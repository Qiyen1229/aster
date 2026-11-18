"""跨裝置同步業務邏輯：最後寫入者勝（以前端變更時間 updated_at 判斷）。

- 上傳：每筆依 (使用者, 資料表, 主鍵) upsert；只有比伺服器版本「更新」的才採用，
  其餘回傳伺服器版本讓前端覆蓋（時間相同時以伺服器既有版本為準，讓先同步的裝置優先）。
- 下載：依使用者遞增序號 seq 取回之後的變更，略過同一台裝置自己上傳的版本。
- 時鐘：變更時間超過伺服器時間 5 分鐘以上（裝置時鐘偏快）一律截到伺服器時間，避免永遠蓋掉其他裝置的修改。
- 墓碑：刪除紀錄保留 TOMBSTONE_DAYS 天後清除；游標早於清除點的裝置下載時會收到 reset，改為完整同步。
"""
from __future__ import annotations

import json
import logging
import time
from datetime import timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import utcnow
from app.core.request_info import ClientInfo
from app.model import SyncKey, SyncRecord, SyncRekey, SyncRekeyRecord, User
from app.service.audit_service import AuditService
from app.repository.sync_repository import SyncRepository
from app.schema.sync import SYNC_TABLES, E2EEConfig, E2EEUpdate, RekeyBatch, RekeyBegin, SyncChange, SyncPullResponse, SyncPushResponse, SyncStatus
from app.service.errors import ServiceError

log = logging.getLogger("aster.sync")

MAX_PAYLOAD_BYTES = 256 * 1024
MAX_RECORDS_PER_USER = 100_000
PROTOCOL_VERSION = 4
MAX_CLOCK_AHEAD_MS = 5 * 60 * 1000
TOMBSTONE_DAYS = 90
# 每位使用者多久檢查一次墓碑清除（行程內記錄即可，漏做只是晚一點清）
PURGE_INTERVAL_S = 6 * 3600
_last_purge: dict[int, float] = {}


def now_ms() -> int:
    return int(time.time() * 1000)


def _to_change(r: SyncRecord) -> SyncChange:
    return SyncChange(
        table=r.table_name, key=r.record_key, updated_at=r.updated_at, deleted=r.deleted,
        payload=json.loads(r.payload) if r.payload and not r.deleted else None,
    )


class SyncService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.repo = SyncRepository(db)

    def status(self, user: User) -> SyncStatus:
        return SyncStatus(
            enabled=True, protocol_version=PROTOCOL_VERSION, message="已啟用跨裝置同步",
            records=self.repo.count(user.id), cursor=self.repo.last_seq(user.id), server_time=now_ms(),
            purged_seq=self.repo.purged_seq(user.id), e2ee=self.e2ee(user), key_version=self.key_version(user),
        )

    def e2ee(self, user: User) -> E2EEConfig | None:
        k = self.db.get(SyncKey, user.id)
        if not k or not k.enabled:
            return None
        return E2EEConfig(enabled=True, salt=k.salt, iterations=k.iterations, check=k.check, version=k.version)

    def key_version(self, user: User) -> int:
        k = self.db.get(SyncKey, user.id)
        return k.version if k else 0

    def _check_config(self, body: E2EEUpdate) -> None:
        if body.enabled and not (body.salt and body.check and body.iterations >= 100_000):
            raise ServiceError(422, "加密設定不完整")

    def _write_config(self, user: User, body: E2EEUpdate, client: ClientInfo) -> None:
        k = self.db.get(SyncKey, user.id)
        if k is None:
            k = SyncKey(user_id=user.id, version=0)
            self.db.add(k)
        k.enabled = body.enabled
        k.salt = body.salt if body.enabled else ""
        k.iterations = body.iterations if body.enabled else 0
        k.check = body.check if body.enabled else ""
        k.version = (k.version or 0) + 1
        self.db.flush()
        AuditService(self.db).record("sync.e2ee_on" if body.enabled else "sync.e2ee_off", client, user_id=user.id)

    def set_e2ee(self, user: User, body: E2EEUpdate, client: ClientInfo) -> E2EEConfig | None:
        self.repo.reserve_seq(user.id, 0)
        self._check_config(body)
        if self.repo.count(user.id) or body.expected_version != self.key_version(user):
            raise ServiceError(409, "請更新 App，使用完整資料遷移切換加密")
        self._write_config(user, body, client)
        return self.e2ee(user)

    def begin_rekey(self, user: User, body: RekeyBegin) -> None:
        self.repo.reserve_seq(user.id, 0)
        self._check_config(body)
        if body.expected_version != self.key_version(user) or body.cursor != self.repo.last_seq(user.id):
            raise ServiceError(409, "同步資料已變更，請重新同步後再切換加密")
        cfg = E2EEUpdate.model_validate(body.model_dump()).model_dump_json()
        current = self.db.get(SyncRekey, user.id)
        if current and current.migration_id == body.migration_id:
            if current.config != cfg or current.base_cursor != body.cursor:
                raise ServiceError(409, "加密遷移內容已變更")
            return
        self.db.execute(delete(SyncRekey).where(SyncRekey.user_id == user.id))
        self.db.add(SyncRekey(user_id=user.id, migration_id=body.migration_id, base_version=body.expected_version,
                              base_cursor=body.cursor, config=cfg))
        self.db.flush()

    def _migration(self, user: User, migration_id: str) -> SyncRekey:
        self.repo.reserve_seq(user.id, 0)
        m = self.db.get(SyncRekey, user.id)
        if not m or m.migration_id != migration_id:
            raise ServiceError(409, "加密遷移已失效，請重新同步後再試")
        if m.base_version != self.key_version(user) or m.base_cursor != self.repo.last_seq(user.id):
            raise ServiceError(409, "同步資料已變更，舊加密設定保持不變，請重新切換")
        return m

    def _validate_envelope(self, payload: dict, enabled: bool, version: int) -> None:
        encrypted = payload.get("$enc") == 1
        if encrypted != enabled or (enabled and (payload.get("v") != version or not isinstance(payload.get("iv"), str)
                                                or not isinstance(payload.get("ct"), str))):
            raise ServiceError(409, "加密版本已變更，請重新同步或更新 App")

    def stage_rekey(self, user: User, body: RekeyBatch) -> None:
        m = self._migration(user, body.migration_id)
        cfg = E2EEUpdate.model_validate_json(m.config)
        existing = self.repo.get_many(user.id, [(c.table, c.key) for c in body.changes])
        for c in body.changes:
            rec = existing.get((c.table, c.key))
            if not rec or rec.deleted or c.deleted or c.payload is None or rec.updated_at != c.updated_at:
                raise ServiceError(409, "加密遷移與原始資料不一致")
            self._validate_envelope(c.payload, cfg.enabled, m.base_version + 1)
            payload = json.dumps(c.payload, ensure_ascii=False, separators=(",", ":"))
            if len(payload.encode()) > MAX_PAYLOAD_BYTES:
                raise ServiceError(413, "重新加密後單筆資料過大", {"X-Sync-Error": "payload_too_large"})
            staged = self.db.get(SyncRekeyRecord, (user.id, rec.id))
            if staged:
                staged.payload = payload
            else:
                self.db.add(SyncRekeyRecord(user_id=user.id, record_id=rec.id, payload=payload))
            self.db.flush()
        staged_rows = self.db.scalars(select(SyncRekeyRecord).where(SyncRekeyRecord.user_id == user.id))
        if sum(len(r.payload.encode()) for r in staged_rows) > get_settings().sync_max_bytes_per_user:
            raise ServiceError(413, "重新加密後總容量已達上限", {"X-Sync-Error": "quota_exceeded"})

    def commit_rekey(self, user: User, migration_id: str, client: ClientInfo) -> SyncStatus:
        m = self._migration(user, migration_id)
        rows = list(self.db.scalars(select(SyncRecord).where(SyncRecord.user_id == user.id, SyncRecord.deleted.is_(False))))
        staged = {r.record_id: r.payload for r in self.db.scalars(select(SyncRekeyRecord).where(SyncRekeyRecord.user_id == user.id))}
        if {r.id for r in rows} != set(staged):
            raise ServiceError(409, "加密資料尚未完整上傳，原資料與設定保持不變")
        if sum(len(p.encode()) for p in staged.values()) > get_settings().sync_max_bytes_per_user:
            raise ServiceError(413, "重新加密後總容量已達上限", {"X-Sync-Error": "quota_exceeded"})
        seq = self.repo.reserve_seq(user.id, len(rows)) - len(rows)
        for rec in rows:
            seq += 1
            rec.payload = staged[rec.id]
            rec.seq = seq
            rec.device_id = ""
        self._write_config(user, E2EEUpdate.model_validate_json(m.config), client)
        self.db.execute(delete(SyncRekey).where(SyncRekey.user_id == user.id))
        self.db.flush()
        return self.status(user)

    def purge_if_due(self, user: User, force: bool = False) -> int:
        last = _last_purge.get(user.id, 0.0)
        if not force and time.monotonic() - last < PURGE_INTERVAL_S and last:
            return 0
        _last_purge[user.id] = time.monotonic()
        n = self.repo.purge_tombstones(user.id, utcnow() - timedelta(days=TOMBSTONE_DAYS))
        if n:
            log.info("清除同步墓碑 user_id=%s 筆數=%s", user.id, n)
        return n

    def push(self, user: User, device_id: str, changes: list[SyncChange], key_version: int | None = None) -> SyncPushResponse:
        self.repo.reserve_seq(user.id, 0)
        version = self.key_version(user)
        if (key_version or 0) != version:
            raise ServiceError(409, "加密版本已變更，請重新同步或更新 App")
        enabled = self.e2ee(user) is not None
        if not changes:
            return SyncPushResponse(accepted=0, rejected=[], cursor=self.repo.last_seq(user.id))
        encoded: list[tuple[SyncChange, str | None]] = []
        ahead = now_ms() + MAX_CLOCK_AHEAD_MS
        for c in changes:
            if c.updated_at > ahead:
                c.updated_at = now_ms()
            if c.table not in SYNC_TABLES:
                raise ServiceError(422, f"不支援同步的資料表：{c.table}")
            if not c.deleted and c.payload is None:
                raise ServiceError(422, "缺少資料內容")
            if not c.deleted:
                self._validate_envelope(c.payload, enabled, version)
            body = None if c.deleted else json.dumps(c.payload, ensure_ascii=False, separators=(",", ":"))
            if body is not None and len(body.encode()) > MAX_PAYLOAD_BYTES:
                raise ServiceError(413, "單筆資料過大", {"X-Sync-Error": "payload_too_large"})
            encoded.append((c, body))

        existing = self.repo.get_many(user.id, [(c.table, c.key) for c, _ in encoded])
        new_count = sum(1 for c, _ in encoded if (c.table, c.key) not in existing)
        if new_count and self.repo.count(user.id) + new_count > MAX_RECORDS_PER_USER:
            raise ServiceError(413, "同步資料筆數已達上限", {"X-Sync-Error": "quota_exceeded"})

        added_bytes = 0
        for c, body in encoded:
            if c.deleted or body is None:
                continue
            k = (c.table, c.key)
            rec = existing.get(k)
            body_len = len(body.encode())
            old_len = len(rec.payload.encode()) if rec and rec.payload and not rec.deleted else 0
            if body_len > old_len:
                added_bytes += (body_len - old_len)

        if added_bytes > 0:
            max_bytes = get_settings().sync_max_bytes_per_user
            current_bytes = self.repo.total_bytes(user.id)
            if current_bytes + added_bytes > max_bytes:
                raise ServiceError(413, "同步資料總容量已達上限", {"X-Sync-Error": "quota_exceeded"})

        # 先決定哪些要寫入（同一批內同一筆出現多次時，以較新的為準）
        winners: dict[tuple[str, str], tuple[SyncChange, str | None]] = {}
        rejected: dict[tuple[str, str], SyncRecord] = {}
        for c, body in encoded:
            k = (c.table, c.key)
            cur = winners.get(k)
            if cur and cur[0].updated_at >= c.updated_at:
                continue
            rec = existing.get(k)
            if rec is not None and rec.updated_at >= c.updated_at:
                rejected[k] = rec
                continue
            winners[k] = (c, body)
            rejected.pop(k, None)

        last = self.repo.reserve_seq(user.id, len(winners)) if winners else self.repo.last_seq(user.id)
        seq = last - len(winners)
        for k, (c, body) in winners.items():
            seq += 1
            rec = existing.get(k)
            if rec is None:
                rec = self.repo.add(SyncRecord(user_id=user.id, table_name=c.table, record_key=c.key, updated_at=c.updated_at,
                                               deleted=c.deleted, payload=body, seq=seq, device_id=device_id))
            else:
                rec.updated_at = c.updated_at
                rec.deleted = c.deleted
                rec.payload = body
                rec.seq = seq
                rec.device_id = device_id
        self.db.flush()
        if winners:
            log.info("同步上傳 user_id=%s 採用=%s 略過=%s", user.id, len(winners), len(rejected))
        self.purge_if_due(user)
        return SyncPushResponse(accepted=len(winners), rejected=[_to_change(r) for r in rejected.values()], cursor=last)

    def pull(self, user: User, since: int, limit: int, device_id: str | None) -> SyncPullResponse:
        if 0 < since < self.repo.purged_seq(user.id):
            return SyncPullResponse(changes=[], cursor=since, has_more=False, reset=True)
        rows = self.repo.changes_since(user.id, since, limit)
        cursor = int(rows[-1].seq) if rows else max(since, self.repo.last_seq(user.id), self.repo.purged_seq(user.id))
        # 自己上傳的版本本機已有，不必再下載
        changes = [_to_change(r) for r in rows if not device_id or r.device_id != device_id]
        return SyncPullResponse(changes=changes, cursor=cursor, has_more=len(rows) == limit)
