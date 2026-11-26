"""輕量化 Email 自動記帳收信（IMAP 輪詢）：僅讀取純文字交易／入帳通知，不下載與儲存附件。"""
from __future__ import annotations

import email
import imaplib
import logging
import re
from email.header import decode_header
from email.message import Message
from email.utils import parseaddr

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.security import utcnow
from app.model import ROLE_ADMIN, InboxItem, User
from app.schema.inbox import HookItem
from app.service.inbox_service import MAX_PENDING, is_noise_notification

log = logging.getLogger("aster.email_inbox")
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_FOOTER_NOISE_RE = re.compile(r"(?:Google\s*LLC|1600\s*Amphitheatre\s*Parkway|Mountain\s*View,\s*CA\s*\d{5})", re.IGNORECASE)


def imap_configured() -> bool:
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


def poll_imap_once(db: Session) -> int:
    """輪詢未讀信件並將符合交易特徵的通知寫入收件匣；回傳新增筆數。"""
    if not imap_configured():
        return 0
    user = _resolve_target_user(db)
    if not user:
        return 0
    s = get_settings()
    added = 0
    try:
        with imaplib.IMAP4_SSL(s.imap_host.strip(), s.imap_port, timeout=15) as imap:
            imap.login(s.imap_user.strip(), s.imap_password)
            imap.select(s.imap_folder.strip() or "INBOX")
            typ, data = imap.search(None, "UNSEEN")
            if typ != "OK" or not data or not data[0]:
                return 0
            msg_ids = data[0].split()[:20]
            pending = int(db.scalar(select(func.count(InboxItem.id)).where(InboxItem.user_id == user.id)) or 0)
            for mid in msg_ids:
                if pending >= MAX_PENDING:
                    break
                ftyp, fdata = imap.fetch(mid, "(RFC822)")
                if ftyp != "OK" or not fdata:
                    continue
                raw_bytes = next((part[1] for part in fdata if isinstance(part, tuple) and isinstance(part[1], bytes)), None)
                if not raw_bytes:
                    continue
                parsed = email.message_from_bytes(raw_bytes)
                sender, subject, body = extract_email_text(parsed)
                combined = f"{subject}\n{body}".strip()[:1000]
                hook = HookItem(source="email", text=combined, merchant=sender, card=sender[:60])
                if is_noise_notification(hook):
                    continue
                db.add(InboxItem(
                    user_id=user.id, token_id=None, source="email",
                    text=combined, amount="", merchant=sender, card=sender[:60],
                    occurred=utcnow().strftime("%Y-%m-%d"),
                ))
                pending += 1
                added += 1
            if added:
                db.commit()
            return added
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
