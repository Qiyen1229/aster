"""輕量化 Email 自動記帳收信（IMAP 輪詢）：僅讀取純文字交易／入帳通知，不下載與儲存附件。"""
from __future__ import annotations

import email
import hashlib
import imaplib
import logging
import os
import re
from datetime import timedelta
from email.header import decode_header
from email.message import Message
from email.utils import parseaddr

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import utcnow
from app.model import ROLE_ADMIN, InboxDedupeKey, InboxItem, User
from app.schema.inbox import HookItem
from app.service.inbox_service import MAX_PENDING, RETENTION, is_noise_notification

log = logging.getLogger("aster.email_inbox")
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_FOOTER_NOISE_RE = re.compile(r"(?:Google\s*LLC|1600\s*Amphitheatre\s*Parkway|Mountain\s*View,\s*CA\s*\d{5})", re.IGNORECASE)
EMAIL_DEDUPE_TTL = timedelta(days=90)


def imap_configured() -> bool:
    if os.environ.get("CLURE_IMAP_ENABLED", "").strip().lower() in ("0", "false", "no", "off"):
        return False
    s = get_settings()
    return bool(s.imap_host.strip() and s.imap_user.strip() and s.imap_password)


def _decode_mime(raw: str | None) -> str:
    if not raw:
        return ""
    parts: list[str] = []
    for chunk, charset in decode_header(raw):
        if isinstance(chunk, bytes):
            parts.append(chunk.decode(charset or "utf-8", errors="replace"))
        else:
            parts.append(chunk)
    return "".join(parts).strip()


def extract_email_text(msg: Message) -> tuple[str, str, str]:
    """萃取 (寄件者顯示名或信箱, 主旨, 純文字內文)，完全略過附件。"""
    name, addr = parseaddr(_decode_mime(msg.get("From")))
    sender = (name or addr or "Email").strip()[:80]
    subject = _decode_mime(msg.get("Subject"))[:160]
    plain = ""
    html_fallback = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_disposition() == "attachment":
                continue
            ctype = part.get_content_type()
            if ctype == "text/plain" and not plain:
                payload = part.get_payload(decode=True)
                if isinstance(payload, bytes):
                    plain = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
            elif ctype == "text/html" and not html_fallback:
                payload = part.get_payload(decode=True)
                if isinstance(payload, bytes):
                    html_fallback = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
    else:
        payload = msg.get_payload(decode=True)
        if isinstance(payload, bytes):
            raw = payload.decode(msg.get_content_charset() or "utf-8", errors="replace")
            if msg.get_content_type() == "text/html":
                html_fallback = raw
            else:
                plain = raw

    body = plain.strip() if plain.strip() else _WS_RE.sub(" ", _TAG_RE.sub(" ", html_fallback)).strip()
    body = _FOOTER_NOISE_RE.sub("", body).strip()
    return sender, subject, body[:1000]


def _resolve_target_user(db: Session) -> User | None:
    s = get_settings()
    target = s.imap_target_user.strip().lower()
    if target:
        return db.scalar(select(User).where((func.lower(User.username) == target) | (func.lower(User.email) == target)))
    return db.scalar(select(User).where(User.is_active.is_(True), User.role == ROLE_ADMIN).order_by(User.id)) \
        or db.scalar(select(User).where(User.is_active.is_(True)).order_by(User.id))


def _extract_uidvalidity(imap: imaplib.IMAP4_SSL) -> str:
    if not hasattr(imap, "response"):
        return ""
    _, vals = imap.response("UIDVALIDITY")
    if vals and vals[0]:
        raw = vals[0]
        return raw.decode("ascii", errors="ignore").strip() if isinstance(raw, bytes) else str(raw).strip()
    return ""


def _email_dedupe_key(parsed: Message, folder: str, uidvalidity: str, uid: bytes, sender: str, subject: str, body: str) -> str:
    msg_id = (parsed.get("Message-ID") or "").strip()
    if msg_id:
        return f"email:msgid:{hashlib.sha256(msg_id.encode('utf-8', errors='replace')).hexdigest()}"
    uid_str = uid.decode("ascii", errors="replace")
    fp_raw = f"{folder}|{uidvalidity}|{uid_str}|{sender}|{subject}|{body[:200]}"
    return f"email:fp:{hashlib.sha256(fp_raw.encode('utf-8', errors='replace')).hexdigest()}"


def poll_imap_once(db: Session) -> int:
    """輪詢未讀信件並將符合交易特徵的通知寫入收件匣；回傳新增筆數。"""
    if not imap_configured():
        return 0
    user = _resolve_target_user(db)
    if not user:
        return 0
    s = get_settings()
    folder = s.imap_folder.strip() or "INBOX"
    added_items: list[InboxItem] = []
    uids_to_mark_seen: list[bytes] = []
    now = utcnow()
    try:
        db.execute(delete(InboxItem).where(InboxItem.user_id == user.id, InboxItem.created_at < now - RETENTION))
        db.execute(delete(InboxDedupeKey).where(InboxDedupeKey.user_id == user.id, InboxDedupeKey.expires_at < now))

        with imaplib.IMAP4_SSL(s.imap_host.strip(), s.imap_port, timeout=15) as imap:
            imap.login(s.imap_user.strip(), s.imap_password)
            sel_typ, _ = imap.select(folder, readonly=False)
            if sel_typ != "OK":
                return 0
            uidvalidity = _extract_uidvalidity(imap)
            typ, data = imap.uid("search", None, "UNSEEN")
            if typ != "OK" or not data or not data[0]:
                return 0
            uids = data[0].split()[:20]
            pending = int(db.scalar(select(func.count(InboxItem.id)).where(InboxItem.user_id == user.id)) or 0)
            for uid in uids:
                if pending >= MAX_PENDING:
                    break
                ftyp, fdata = imap.uid("fetch", uid, "(BODY.PEEK[])")
                if ftyp != "OK" or not fdata:
                    continue
                raw_bytes = next((part[1] for part in fdata if isinstance(part, tuple) and isinstance(part[1], bytes)), None)
                if not raw_bytes:
                    continue
                parsed = email.message_from_bytes(raw_bytes)
                sender, subject, body = extract_email_text(parsed)
                combined = f"{subject}\n{body}".strip()[:1000]
                if not combined:
                    uids_to_mark_seen.append(uid)
                    continue
                hook = HookItem(source="email", text=combined, merchant="", card=sender[:60])
                if is_noise_notification(hook):
                    uids_to_mark_seen.append(uid)
                    continue

                dedupe_key = _email_dedupe_key(parsed, folder, uidvalidity, uid, sender, subject, body)
                seen_item = db.scalar(
                    select(InboxItem.id).where(InboxItem.user_id == user.id, InboxItem.source_event_id == dedupe_key)
                )
                seen_dedupe = db.scalar(
                    select(InboxDedupeKey).where(
                        InboxDedupeKey.user_id == user.id,
                        InboxDedupeKey.dedupe_key == dedupe_key,
                        InboxDedupeKey.expires_at >= now,
                    )
                )
                if seen_item is not None or seen_dedupe is not None:
                    uids_to_mark_seen.append(uid)
                    continue

                try:
                    with db.begin_nested():
                        existing_expired = db.scalar(
                            select(InboxDedupeKey).where(
                                InboxDedupeKey.user_id == user.id,
                                InboxDedupeKey.dedupe_key == dedupe_key,
                            )
                        )
                        if existing_expired:
                            existing_expired.expires_at = now + EMAIL_DEDUPE_TTL
                        else:
                            db.add(InboxDedupeKey(user_id=user.id, dedupe_key=dedupe_key, expires_at=now + EMAIL_DEDUPE_TTL))
                        db.flush()
                except IntegrityError:
                    uids_to_mark_seen.append(uid)
                    continue

                item = InboxItem(
                    user_id=user.id, token_id=None, source="email",
                    text=combined, amount="", merchant="", card=sender[:60],
                    occurred=now.strftime("%Y-%m-%d"), source_event_id=dedupe_key,
                )
                db.add(item)
                db.flush()
                added_items.append(item)
                uids_to_mark_seen.append(uid)
                pending += 1

            db.commit()
            for uid in uids_to_mark_seen:
                try:
                    imap.uid("store", uid, "+FLAGS.SILENT", r"(\Seen)")
                except Exception as exc:  # noqa: BLE001
                    log.warning("IMAP 標記已讀失敗（uid=%s）：%s", uid, exc)

        if added_items:
            try:
                from app.service.push_service import PushService
                PushService(db).send_to_user(
                    user.id,
                    {"title": "📥 收件匣有新項目", "body": "打開 Aster 確認記帳", "url": "/inbox", "tag": f"inbox:{added_items[-1].id}"},
                )
                db.commit()
            except Exception:  # noqa: BLE001 — 推播失敗不能影響收信結果
                log.exception("Email 收件匣推播失敗")
        return len(added_items)
    except Exception as exc:  # noqa: BLE001
        log.warning("IMAP 收信輪詢失敗：%s", exc)
        db.rollback()
        return 0


async def email_inbox_loop() -> None:
    """背景定時輪詢 IMAP 收件匣。"""
    import asyncio
    from app.db import session_scope

    while True:
        s = get_settings()
        if imap_configured():
            try:
                for db in session_scope():
                    await asyncio.to_thread(poll_imap_once, db)
            except Exception as exc:  # noqa: BLE001
                log.warning("IMAP 背景任務例外：%s", exc)
        await asyncio.sleep(max(30, s.imap_poll_seconds))
