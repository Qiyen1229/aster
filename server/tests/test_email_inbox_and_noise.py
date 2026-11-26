"""Email IMAP 收信通道與後端噪音過濾（不誤殺轉帳通知）測試。"""
from __future__ import annotations

from email.message import EmailMessage

from app.core.config import get_settings
from app.schema.inbox import HookItem
from app.service.email_inbox import extract_email_text, poll_imap_once
from app.service.inbox_service import is_noise_notification
from tests.conftest import PASSWORD, Api


def test_noise_filter_keeps_transfer_with_security_phrase():
    otp_only = HookItem(source="notify", text="您的動態密碼為 123456，5 分鐘內有效", merchant="中國信託")
    assert is_noise_notification(otp_only) is True

    tx_with_phrase = HookItem(
        source="notify",
        text="中國信託轉帳成功：轉出金額 NT$5,000（本筆免動態密碼、免收手續費）",
        merchant="中國信託",
    )
    assert is_noise_notification(tx_with_phrase) is False


def test_extract_email_text_and_poll_imap(monkeypatch, api):
    # 建立使用者成為收件目標
    api.post("/api/auth/register", {"username": "qiyen", "email": "qiyen@example.com", "password": PASSWORD})

    msg = EmailMessage()
    msg["From"] = "中國信託 <noreply@ctbcbank.com>"
    msg["Subject"] = "存款入帳通知"
    msg.set_content("您尾數 7068 帳戶於 2026/11/26 存入新臺幣 1,300 元。")
    sender, subject, body = extract_email_text(msg)
    assert "中國信託" in sender
    assert "存款入帳通知" in subject
    assert "1,300" in body

    raw_bytes = msg.as_bytes()

    class FakeIMAP:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def login(self, user, pw):
            return ("OK", [])

        def select(self, folder):
            return ("OK", [])

        def search(self, charset, crit):
            return ("OK", [b"1"])

        def fetch(self, mid, spec):
            return ("OK", [(b"1 (RFC822)", raw_bytes)])

    s = get_settings()
    monkeypatch.setattr(s, "imap_host", "imap.gmail.com")
    monkeypatch.setattr(s, "imap_user", "aster@gmail.com")
    monkeypatch.setattr(s, "imap_password", "app-pw")
    monkeypatch.setattr("app.service.email_inbox.imaplib.IMAP4_SSL", FakeIMAP)

    from app.db import session_scope
    for db in session_scope():
        added = poll_imap_once(db)
    assert added == 1

    items = api.get("/api/inbox/items").json()
    assert len(items) == 1
    assert items[0]["source"] == "email"
    assert "1,300" in items[0]["text"]
