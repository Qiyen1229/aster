"""收件匣：捷徑權杖管理、接收捷徑送來的項目、列出與確認。

- 權杖格式 clr_ 加 32 個隨機字元，資料庫只存 SHA-256；建立時回傳一次，之後只顯示末四碼
- 權杖只能「送進收件匣」，不能讀取任何帳目
- 確認（ack）時才刪除，並回傳實際刪除的 id；帳目寫入與防重複由客戶端處理
- 30 天沒處理的項目自動清除；每人最多 500 筆待處理、10 組權杖
"""
from __future__ import annotations

import hashlib
import json
import re
import secrets
from datetime import timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.core.request_info import ClientInfo
from app.core.security import utcnow
from app.model import InboxBooking, InboxItem, InboxToken, User
from app.repository.sync_repository import SyncRepository
from app.schema.inbox import BookingRequest, HookItem
from app.service.audit_service import AuditService
from app.service.errors import ServiceError

TOKEN_PREFIX = "clr_"
MAX_TOKENS = 10
MAX_PENDING = 500
RETENTION = timedelta(days=30)

_HARD_NOISE_RE = re.compile(
    r"驗證碼|動態密碼|安全碼|驗證密碼|\bOTP\b|登入成功|成功登入|登入通知|裝置登入|密碼變更|修改密碼",
    re.IGNORECASE,
)
_PROMO_NOISE_RE = re.compile(
    r"雙11|雙十一|雙12|雙十二|購物節|滿額抽|抽好禮|回饋送|限時特惠|好康優惠|專屬優惠|刷卡金回饋|行銷活動|紅利點數|折抵活動"
    r"|立即登錄|登錄活動|參加抽獎|申請信貸|信貸專案|貸款試算|手續費優惠|手續費折抵|免收手續費|帳單已產|電子帳單|繳款提醒|繳費提醒|對帳單",
    re.IGNORECASE,
)
_TX_SIGNAL_RE = re.compile(
    r"消費|刷卡|付款|扣款|扣帳|簽帳|交易|授權|請款|轉帳|轉出|轉入|入帳|存入|匯款|提款|提領|支付|儲值|加值|繳費|繳款|退款|退貨|退刷|NT\$|NTD|TWD|USD|JPY|EUR|HKD",
    re.IGNORECASE,
)
_DIGIT_RE = re.compile(r"\d")
_ACTUAL_TX_RE = re.compile(
    r"(?:消費|刷卡|付款|扣款|扣帳|簽帳|交易|轉帳|轉出|轉入|入帳|存入|匯款|提款|支付|儲值|退款)"
    r"(?:成功|完成)?(?:金額)?\s*[:：]?\s*(?:(?:NT\$|NTD|TWD|USD|JPY|EUR|HKD)\s*[\d,]+|[\d,]+(?:\.\d+)?\s*元)",
    re.IGNORECASE,
)


def is_noise_notification(body: HookItem) -> bool:
    """過濾銀行與行動支付 App 的非交易推播（OTP 驗證碼、登入通知、行銷廣告、一般 LINE 聊天）"""
    if body.source != "notify" or body.amount:
        return False
    combined = f"{body.text} {body.merchant}".strip()
    if not combined:
        return True
    if _HARD_NOISE_RE.search(combined):
        return True
    if _PROMO_NOISE_RE.search(combined) and not _ACTUAL_TX_RE.search(combined):
        return True
    if _TX_SIGNAL_RE.search(combined) and _DIGIT_RE.search(combined):
        return False
    return True


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class InboxService:
    def __init__(self, db: Session) -> None:
        self.db = db

    # ── 權杖 ──
    def tokens(self, user: User) -> list[InboxToken]:
        return list(self.db.scalars(select(InboxToken).where(InboxToken.user_id == user.id).order_by(InboxToken.id)).all())

    def create_token(self, user: User, name: str, client: ClientInfo) -> tuple[str, InboxToken]:
        if len(self.tokens(user)) >= MAX_TOKENS:
            raise ServiceError(413, f"最多 {MAX_TOKENS} 組捷徑權杖，請先刪除不用的")
        token = TOKEN_PREFIX + secrets.token_urlsafe(24)
        row = InboxToken(user_id=user.id, name=name.strip()[:40], token_hash=hash_token(token), hint=token[-4:])
        self.db.add(row)
        self.db.flush()
        AuditService(self.db).record("inbox.token_create", client, user_id=user.id, detail={"name": row.name})
        return token, row

    def revoke_token(self, user: User, token_id: int, client: ClientInfo) -> None:
        n = self.db.execute(delete(InboxToken).where(InboxToken.id == token_id, InboxToken.user_id == user.id)).rowcount
        if not n:
            raise ServiceError(404, "找不到這組權杖")
        AuditService(self.db).record("inbox.token_revoke", client, user_id=user.id)

    def user_for_token(self, token: str | None) -> tuple[User, InboxToken]:
        if not token or not token.startswith(TOKEN_PREFIX) or len(token) > 80:
            raise ServiceError(401, "權杖錯誤：請到 App「設定 → 自動記帳收件匣」重新建立")
        row = self.db.scalar(select(InboxToken).where(InboxToken.token_hash == hash_token(token)))
        user = self.db.get(User, row.user_id) if row else None
        if not row or not user or not user.is_active:
            raise ServiceError(401, "權杖錯誤或已撤銷：請到 App「設定 → 自動記帳收件匣」重新建立")
        return user, row

    # ── 項目 ──
    def receive(self, user: User, token: InboxToken, body: HookItem) -> InboxItem | None:
        if is_noise_notification(body):
            return None
        pending = int(self.db.scalar(select(func.count(InboxItem.id)).where(InboxItem.user_id == user.id)) or 0)
        if pending >= MAX_PENDING:
            raise ServiceError(429, "收件匣已滿，請先打開 App 處理待確認的項目")
        item = InboxItem(user_id=user.id, token_id=token.id, source=body.source, text=body.text, amount=body.amount,
                         merchant=body.merchant, card=body.card, occurred=body.date)
        self.db.add(item)
        token.last_used_at = utcnow()
        token.use_count = (token.use_count or 0) + 1
        self.db.flush()
        return item

    def items(self, user: User) -> list[InboxItem]:
        self.db.execute(delete(InboxItem).where(InboxItem.user_id == user.id, InboxItem.created_at < utcnow() - RETENTION))
        return list(self.db.scalars(select(InboxItem).where(InboxItem.user_id == user.id).order_by(InboxItem.id.desc()).limit(MAX_PENDING)).all())

    def reserve_booking(self, user: User, body: BookingRequest) -> None:
        SyncRepository(self.db).reserve_seq(user.id, 0)
        shape = json.dumps(body.shape, separators=(",", ":"))
        existing = self.db.get(InboxBooking, body.id)
        if existing:
            if existing.user_id != user.id:
                raise ServiceError(404, "找不到這則通知")
            if existing.shape != shape:
                raise ServiceError(409, "這則通知已登記不同的記帳方式，請先同步確認，或用原方式重試")
            return
        item = self.db.get(InboxItem, body.id)
        if not item or item.user_id != user.id:
            raise ServiceError(409, "通知已清除，請先同步帳本確認，不要再次新增")
        self.db.add(InboxBooking(item_id=body.id, user_id=user.id, shape=shape))
        self.db.flush()

    def ack(self, user: User, ids: list[int]) -> list[int]:
        # DELETE … RETURNING：同時確認時只有真正刪到的那一方會拿到 id
        stmt = delete(InboxItem).where(InboxItem.user_id == user.id, InboxItem.id.in_(ids)).returning(InboxItem.id)
        return sorted(self.db.execute(stmt).scalars().all())
