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

    # Apple Pay 無金額卡片通知不應被當噪音丟棄
    applepay_blank = HookItem(source="applepay", card="玉山 Pi 卡")
    assert is_noise_notification(applepay_blank) is False

    # 官方銀行／LINE 動作摘要通知（無數字）不應被丟棄
    official_action = HookItem(source="notify", text="中國信託：你有一筆入帳", card="LINE")
    assert is_noise_notification(official_action) is False

    google_alert_email = HookItem(
        source="email",
        text="Google 帳戶安全快訊：已授權 Aster 登入。Google LLC, 1600 Amphitheatre Parkway, Mountain View, CA 94043",
        merchant="Google",
    )
    assert is_noise_notification(google_alert_email) is True


def test_extract_email_text_and_poll_imap(monkeypatch, api):
    # 建立使用者成為收件目標
    api.register("qiyen", "qiyen@example.com", PASSWORD)

    msg = EmailMessage()
    msg["From"] = "中國信託 <noreply@ctbcbank.com>"
    msg["Subject"] = "存款入帳通知"
    msg["Message-ID"] = "<tx-001@ctbcbank.com>"
    msg.set_content("您尾數 7068 帳戶於 2026/11/26 存入新臺幣 1,300 元。")
    sender, subject, body = extract_email_text(msg)
    assert "中國信託" in sender
    assert "存款入帳通知" in subject
    assert "1,300" in body

    noise_msg = EmailMessage()
    noise_msg["From"] = "Google <no-reply@accounts.google.com>"
    noise_msg["Subject"] = "安全快訊"
    noise_msg["Message-ID"] = "<noise-001@google.com>"
    noise_msg.set_content("您的動態密碼為 999999")

    no_msgid_tx = EmailMessage()
    no_msgid_tx["From"] = "玉山銀行 <noreply@esunbank.com>"
    no_msgid_tx["Subject"] = "消費通知"
    no_msgid_tx.set_content("於 全聯福利中心 刷卡消費 NT$250。")

    empty_msg = EmailMessage()
    empty_msg["From"] = "spam@example.com"
    empty_msg["Subject"] = ""
    empty_msg.add_attachment(b"binary", maintype="application", subtype="octet-stream", filename="a.bin")

    messages = {
        b"1": noise_msg.as_bytes(),
        b"2": empty_msg.as_bytes(),
        b"3": msg.as_bytes(),
        b"4": no_msgid_tx.as_bytes(),
    }
    seen_uids: set[bytes] = set()
    fetch_specs: list[str] = []
    select_readonly: list[bool] = []

    class FakeIMAP:
        def __init__(self, *args, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def login(self, user, pw):
            return ("OK", [])

        def select(self, folder, readonly=False):
            select_readonly.append(readonly)
            return ("OK", [b"3"])

        def response(self, name):
            if name == "UIDVALIDITY":
                return ("UIDVALIDITY", [b"42"])
            return (None, [None])

        def uid(self, cmd, *args):
            if cmd == "search":
                unseen = [u for u in messages if u not in seen_uids]
                return ("OK", [b" ".join(unseen)])
            if cmd == "fetch":
                uid, spec = args[0], args[1]
                fetch_specs.append(spec)
                return ("OK", [(b"1 (BODY[] ...)", messages[uid])])
            if cmd == "store":
                uid, op, flag = args[0], args[1], args[2]
                if "+FLAGS" in op and "Seen" in flag:
                    seen_uids.add(uid)
                return ("OK", [])
            return ("NO", [])

    push_calls: list[tuple[int, dict]] = []
    monkeypatch.setattr(
        "app.service.push_service.PushService.send_to_user",
        lambda self, user_id, msg_payload: (push_calls.append((user_id, msg_payload)), 1)[1],
    )

    s = get_settings()
    monkeypatch.setattr(s, "imap_host", "imap.gmail.com")
    monkeypatch.setattr(s, "imap_user", "aster@gmail.com")
    monkeypatch.setattr(s, "imap_password", "app-pw")
    monkeypatch.setattr("app.service.email_inbox.imaplib.IMAP4_SSL", FakeIMAP)

    from app.db import session_scope
    for db in session_scope():
        added = poll_imap_once(db)
    assert added == 2
    assert select_readonly == [False]
    assert all(spec == "(BODY.PEEK[])" for spec in fetch_specs)
    # 雜訊信件與空白信件、有效信件都應被標記為 \Seen，避免重複占用前 20 筆配額或卡住輪詢
    assert seen_uids == {b"1", b"2", b"3", b"4"}
    # 推播在 commit 後觸發
    assert len(push_calls) == 1
    assert push_calls[0][1]["url"] == "/inbox"

    items = api.get("/api/inbox/items").json()
    assert len(items) == 2
    assert all(it["source"] == "email" for it in items)
    # 寄件者應放在 card，而不是覆寫 merchant
    assert all(it["merchant"] == "" for it in items)
    assert {it["card"] for it in items} == {"中國信託", "玉山銀行"}

    # ack 刪除所有項目後，即使 IMAP 再次變成 UNSEEN，也不應重複寫入
    api.post("/api/inbox/items/ack", {"ids": [it["id"] for it in items]})
    seen_uids.clear()
    for db in session_scope():
        added_again = poll_imap_once(db)
    assert added_again == 0
    assert api.get("/api/inbox/items").json() == []
    # 雖未重複寫入，仍應標記為 \Seen
    assert seen_uids == {b"1", b"2", b"3", b"4"}
