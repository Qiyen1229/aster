"""Cloudflare Email Routing Webhook 自動轉寄記帳服務。"""
from __future__ import annotations

import hashlib
import re
import secrets
from datetime import timedelta
from email.utils import parseaddr

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.request_info import ClientInfo
from app.core.security import utcnow
from app.model import EmailForwardBinding, InboxDedupeKey, InboxItem, User
from app.schema.inbox import EmailForwardHookIn, HookItem
from app.service.audit_service import AuditService
from app.service.errors import ServiceError
from app.service.inbox_service import MAX_PENDING, RETENTION, is_noise_notification

EMAIL_FORWARD_DEDUPE_TTL = timedelta(days=90)

_GMAIL_VERIFY_URL_RE = re.compile(r"https://(?:mail-settings|mail)\.google\.com/mail/vf-[^\s<>)\"']+", re.IGNORECASE)
_GMAIL_VERIFY_CODE_LABELED_RE = re.compile(
    r"(?:確認碼|驗證碼|confirmation\s*code|verification\s*code)\s*[:：#]?\s*(\d{9})\b",
    re.IGNORECASE,
)
_GMAIL_VERIFY_CODE_FALLBACK_RE = re.compile(r"\b(\d{9})\b")
_GMAIL_VERIFY_HINT_RE = re.compile(
    r"(?:forwarding-noreply@google\.com|mail-settings\.google\.com/mail/vf-|mail\.google\.com/mail/vf-|Gmail\s*轉寄確認|Forwarding\s*Confirmation)",
    re.IGNORECASE,
)


def extract_gmail_verification(from_addr: str, subject: str, text: str) -> tuple[str | None, str | None] | None:
    """判斷是否為 Gmail 轉寄驗證信，若是則回傳 (verify_url, verify_code)，否則回傳 None。"""
    combined = f"{from_addr}\n{subject}\n{text}"
    if not _GMAIL_VERIFY_HINT_RE.search(combined):
        return None
    url_m = _GMAIL_VERIFY_URL_RE.search(text) or _GMAIL_VERIFY_URL_RE.search(subject)
    code_m = (
        _GMAIL_VERIFY_CODE_LABELED_RE.search(text)
        or _GMAIL_VERIFY_CODE_LABELED_RE.search(subject)
        or _GMAIL_VERIFY_CODE_FALLBACK_RE.search(text)
        or _GMAIL_VERIFY_CODE_FALLBACK_RE.search(subject)
    )
    verify_url = url_m.group(0).rstrip(".,;:") if url_m else None
    verify_code = code_m.group(1) if code_m else None
    if not verify_url and not verify_code and "forwarding-noreply@google.com" not in from_addr.lower():
        return None
    return verify_url, verify_code


def _normalize_addr(raw: str) -> str:
    _, parsed = parseaddr(raw)
    return (parsed or raw).strip().lower()


class EmailForwardService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_binding(self, user: User) -> EmailForwardBinding | None:
        return self.db.scalar(select(EmailForwardBinding).where(EmailForwardBinding.user_id == user.id))

    def setup_binding(self, user: User, source_email: str, client: ClientInfo) -> EmailForwardBinding:
        s = get_settings()
        domain = s.email_forward_domain.strip().lower() or "qiyen.me"
        prefix = s.email_forward_prefix.strip().lower()
        token = secrets.token_hex(10)
        forward_address = f"{prefix}{token}@{domain}"
        now = utcnow()

        row = self.get_binding(user)
        if row is None:
            row = EmailForwardBinding(
                user_id=user.id,
                source_email=source_email.strip().lower(),
                forward_token=token,
                forward_address=forward_address,
                status="pending_verify",
                created_at=now,
                updated_at=now,
            )
            self.db.add(row)
        else:
            row.source_email = source_email.strip().lower()
            row.forward_token = token
            row.forward_address = forward_address
            row.status = "pending_verify"
            row.verify_url = None
            row.verify_code = None
            row.verify_received_at = None
            row.last_received_at = None
            row.received_count = 0
            row.updated_at = now
        self.db.flush()
        AuditService(self.db).record("inbox.email_forward_setup", client, user_id=user.id, detail={"domain": domain})
        return row

    def mark_verified(self, user: User, client: ClientInfo) -> EmailForwardBinding:
        row = self.get_binding(user)
        if row is None:
            raise ServiceError(404, "尚未設定 Email 自動轉寄")
        row.status = "verified"
        row.updated_at = utcnow()
        self.db.flush()
        AuditService(self.db).record("inbox.email_forward_verify", client, user_id=user.id)
        return row

    def delete_binding(self, user: User, client: ClientInfo) -> None:
        res = self.db.execute(delete(EmailForwardBinding).where(EmailForwardBinding.user_id == user.id))
        if not res.rowcount:
            raise ServiceError(404, "尚未設定 Email 自動轉寄")
        AuditService(self.db).record("inbox.email_forward_delete", client, user_id=user.id)

    def _find_binding_for_recipient(self, to_raw: str) -> EmailForwardBinding | None:
        addr = _normalize_addr(to_raw)
        if not addr or "@" not in addr:
            return None
        row = self.db.scalar(select(EmailForwardBinding).where(EmailForwardBinding.forward_address == addr))
        if row is not None:
            return row
        s = get_settings()
        prefix = s.email_forward_prefix.strip().lower()
        domain = s.email_forward_domain.strip().lower()
        local, _, host = addr.partition("@")
        if domain and host != domain:
            return None
        if prefix and not local.startswith(prefix):
            return None
        token = local[len(prefix):] if prefix else local
        if not token:
            return None
        return self.db.scalar(select(EmailForwardBinding).where(EmailForwardBinding.forward_token == token))

    def receive_webhook(self, payload: EmailForwardHookIn) -> tuple[str, InboxItem | None, User | None]:
        binding = self._find_binding_for_recipient(payload.to)
        if binding is None:
            return "not_found", None, None
        user = self.db.get(User, binding.user_id)
        if not user or not user.is_active:
            return "not_found", None, None

        now = utcnow()
        verification = extract_gmail_verification(payload.from_addr, payload.subject, payload.text)
        if verification is not None:
            verify_url, verify_code = verification
            binding.verify_url = verify_url
            binding.verify_code = verify_code
            binding.verify_received_at = now
            binding.updated_at = now
            self.db.flush()
            return "verification", None, user

        binding.last_received_at = now
        binding.received_count = (binding.received_count or 0) + 1
        if binding.status == "pending_verify":
            binding.status = "verified"
        binding.updated_at = now

        combined = f"{payload.subject.strip()}\n{payload.text.strip()}".strip()[:1000]
        name, addr = parseaddr(payload.from_addr)
        sender = (name or addr or "Email").strip()[:60]
        if not combined:
            self.db.flush()
            return "noise", None, user

        hook = HookItem(source="email", text=combined, merchant="", card=sender)
        if is_noise_notification(hook):
            self.db.flush()
            return "noise", None, user

        self.db.execute(delete(InboxItem).where(InboxItem.user_id == user.id, InboxItem.created_at < now - RETENTION))
        self.db.execute(delete(InboxDedupeKey).where(InboxDedupeKey.user_id == user.id, InboxDedupeKey.expires_at < now))

        msg_id = (payload.message_id or "").strip()
        if msg_id:
            dedupe_key = f"email:wh:msgid:{hashlib.sha256(msg_id.encode('utf-8', errors='replace')).hexdigest()}"
        else:
            fp_raw = f"{binding.forward_address}|{sender}|{payload.subject[:160]}|{payload.text[:200]}"
            dedupe_key = f"email:wh:fp:{hashlib.sha256(fp_raw.encode('utf-8', errors='replace')).hexdigest()}"

        seen_item = self.db.scalar(
            select(InboxItem.id).where(InboxItem.user_id == user.id, InboxItem.source_event_id == dedupe_key)
        )
        seen_dedupe = self.db.scalar(
            select(InboxDedupeKey).where(
                InboxDedupeKey.user_id == user.id,
                InboxDedupeKey.dedupe_key == dedupe_key,
                InboxDedupeKey.expires_at >= now,
            )
        )
        if seen_item is not None or seen_dedupe is not None:
            self.db.flush()
            return "duplicate", None, user

        pending = int(self.db.scalar(select(func.count(InboxItem.id)).where(InboxItem.user_id == user.id)) or 0)
        if pending >= MAX_PENDING:
            raise ServiceError(429, "收件匣已滿，請先打開 App 處理待確認的項目")

        try:
            with self.db.begin_nested():
                existing_expired = self.db.scalar(
                    select(InboxDedupeKey).where(
                        InboxDedupeKey.user_id == user.id,
                        InboxDedupeKey.dedupe_key == dedupe_key,
                    )
                )
                if existing_expired:
                    existing_expired.expires_at = now + EMAIL_FORWARD_DEDUPE_TTL
                else:
                    self.db.add(InboxDedupeKey(user_id=user.id, dedupe_key=dedupe_key, expires_at=now + EMAIL_FORWARD_DEDUPE_TTL))
                self.db.flush()
        except IntegrityError:
            return "duplicate", None, user

        item = InboxItem(
            user_id=user.id,
            token_id=None,
            source="email",
            text=combined,
            amount="",
            merchant="",
            card=sender,
            occurred=now.strftime("%Y-%m-%d"),
            source_event_id=dedupe_key,
        )
        self.db.add(item)
        self.db.flush()
        return "created", item, user
