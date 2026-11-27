"""Email 自動轉寄（Cloudflare Email Routing Webhook）測試。"""
from __future__ import annotations

import re
from pathlib import Path
from unittest.mock import patch

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app
from tests.conftest import Api


def _hook_email(body: dict, secret: str | None = "test-webhook-secret"):  # noqa: ANN202
    c = TestClient(app)
    headers = {"X-Aster-Webhook-Secret": secret} if secret is not None else {}
    return c.post("/api/hook/email", json=body, headers=headers)


def test_email_forward_crud_and_user_isolation(api: Api, admin_and_user, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("CLURE_EMAIL_WEBHOOK_SECRET", "test-webhook-secret")
    monkeypatch.setenv("CLURE_EMAIL_FORWARD_DOMAIN", "qiyen.me")
    monkeypatch.setenv("CLURE_EMAIL_FORWARD_PREFIX", "in-")
    get_settings.cache_clear()

    # 未登入被拒
    anon = TestClient(app)
    assert anon.get("/api/inbox/email-forward").status_code == 401

    a, u = admin_and_user
    assert u.get("/api/inbox/email-forward").json() is None

    # 無效 Email
    assert u.post("/api/inbox/email-forward", {"source_email": "not-an-email"}).status_code == 422

    # 建立綁定
    r = u.post("/api/inbox/email-forward", {"source_email": "User@Gmail.com"})
    assert r.status_code == 200
    data = r.json()
    assert data["source_email"] == "user@gmail.com"
    assert data["status"] == "pending_verify"
    assert data["received_count"] == 0
    assert re.fullmatch(r"in-[0-9a-f]{20}@qiyen\.me", data["forward_address"])
    first_addr = data["forward_address"]

    # 另一位使用者看不到
    assert a.get("/api/inbox/email-forward").json() is None

    # 重新設定會換新位址並使舊位址失效
    r2 = u.post("/api/inbox/email-forward", {"source_email": "user2@gmail.com"})
    assert r2.status_code == 200
    second_addr = r2.json()["forward_address"]
    assert second_addr != first_addr
    assert _hook_email({"to": first_addr, "from_addr": "bank@example.com", "subject": "消費通知", "text": "刷卡消費 NT$500"}).status_code == 404

    # 標記已驗證
    rv = u.post("/api/inbox/email-forward/verify", {})
    assert rv.status_code == 200
    assert rv.json()["status"] == "verified"

    # 移除綁定後舊位址立即失效
    rd = u.c.delete("/api/inbox/email-forward", headers=u._h())
    assert rd.status_code == 200
    assert u.get("/api/inbox/email-forward").json() is None
    assert _hook_email({"to": second_addr, "from_addr": "bank@example.com", "subject": "消費通知", "text": "刷卡消費 NT$500"}).status_code == 404


def test_email_webhook_secret_validation(api: Api, monkeypatch) -> None:  # noqa: ANN001
    api.register("alice")
    monkeypatch.setenv("CLURE_EMAIL_FORWARD_DOMAIN", "qiyen.me")
    monkeypatch.setenv("CLURE_EMAIL_WEBHOOK_SECRET", "")
    get_settings.cache_clear()

    binding = api.post("/api/inbox/email-forward", {"source_email": "alice@gmail.com"}).json()
    payload = {"to": binding["forward_address"], "from_addr": "bank@esunbank.com", "subject": "消費通知", "text": "消費 NT$100"}

    # 未設定 secret 時拒絕
    assert _hook_email(payload, secret="").status_code == 401
    assert _hook_email(payload, secret=None).status_code == 401

    # 設定 secret 後驗證
    monkeypatch.setenv("CLURE_EMAIL_WEBHOOK_SECRET", "super-secret-xyz")
    get_settings.cache_clear()
    assert _hook_email(payload, secret=None).status_code == 401
    assert _hook_email(payload, secret="wrong-secret").status_code == 401
    assert _hook_email(payload, secret="super-secret-xyz").status_code == 200


def test_gmail_verification_email_captured_without_inbox_item(api: Api, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("CLURE_EMAIL_WEBHOOK_SECRET", "test-webhook-secret")
    monkeypatch.setenv("CLURE_EMAIL_FORWARD_DOMAIN", "qiyen.me")
    get_settings.cache_clear()

    api.register("alice")
    binding = api.post("/api/inbox/email-forward", {"source_email": "alice@gmail.com"}).json()
    long_prefix = "Gmail 轉寄確認說明。" * 120  # 超過 1000 字元，確保截斷前就能抓到連結與確認碼
    verify_url = "https://mail-settings.google.com/mail/vf-abcDEF123_456-xyz"
    res = _hook_email({
        "to": f"Aster <{binding['forward_address']}>",
        "from_addr": "Gmail Team <forwarding-noreply@google.com>",
        "subject": "Gmail Forwarding Confirmation - Receive Mail from alice@gmail.com",
        "text": f"{long_prefix}\nConfirmation code: 987654321\nPlease click: {verify_url}\n",
        "message_id": "<gmail-vf-1@mail.gmail.com>",
    })
    assert res.status_code == 200
    assert "驗證信" in res.json()["message"]

    # 不會產生待記帳項目
    assert api.get("/api/inbox/items").json() == []

    updated = api.get("/api/inbox/email-forward").json()
    assert updated["verify_url"] == verify_url
    assert updated["verify_code"] == "987654321"
    assert updated["verify_received_at"] is not None
    assert updated["received_count"] == 0


def test_transaction_email_noise_dedupe_and_push(api: Api, monkeypatch) -> None:  # noqa: ANN001
    monkeypatch.setenv("CLURE_EMAIL_WEBHOOK_SECRET", "test-webhook-secret")
    monkeypatch.setenv("CLURE_EMAIL_FORWARD_DOMAIN", "qiyen.me")
    get_settings.cache_clear()

    api.register("alice")
    binding = api.post("/api/inbox/email-forward", {"source_email": "alice@gmail.com"}).json()
    addr = binding["forward_address"]

    # 1. 雜訊信（OTP / 廣告）應略過，不進收件匣
    r_noise = _hook_email({
        "to": addr,
        "from_addr": "玉山銀行 <notify@esunbank.com.tw>",
        "subject": "動態密碼通知",
        "text": "您的 OTP 驗證碼為 654321，請於 5 分鐘內輸入。",
        "message_id": "<otp-1@esunbank.com.tw>",
    })
    assert r_noise.status_code == 200
    assert "略過" in r_noise.json()["message"]
    assert api.get("/api/inbox/items").json() == []

    # 2. 真實消費通知應寫入 InboxItem 並觸發 Push
    with patch("app.service.push_service.PushService.send_to_user") as mock_push:
        r_tx = _hook_email({
            "to": addr,
            "from_addr": "玉山銀行 <notify@esunbank.com.tw>",
            "subject": "玉山銀行刷卡消費通知",
            "text": "您於 2026/11/27 在 全聯福利中心 刷卡消費 NT$1,250。",
            "message_id": "<tx-1@esunbank.com.tw>",
        })
        assert r_tx.status_code == 200
        assert mock_push.called

    items = api.get("/api/inbox/items").json()
    assert len(items) == 1
    assert items[0]["source"] == "email"
    assert "NT$1,250" in items[0]["text"]
    assert items[0]["card"] == "玉山銀行"

    # 3. 相同 message_id 重送應去重
    r_dup = _hook_email({
        "to": addr,
        "from_addr": "玉山銀行 <notify@esunbank.com.tw>",
        "subject": "玉山銀行刷卡消費通知",
        "text": "您於 2026/11/27 在 全聯福利中心 刷卡消費 NT$1,250。",
        "message_id": "<tx-1@esunbank.com.tw>",
    })
    assert r_dup.status_code == 200
    assert "重複" in r_dup.json()["message"]
    assert len(api.get("/api/inbox/items").json()) == 1

    # 狀態應自動變為 verified 且 received_count 更新
    updated = api.get("/api/inbox/email-forward").json()
    assert updated["status"] == "verified"
    assert updated["received_count"] == 3
    assert updated["last_received_at"] is not None


def test_alembic_0017_upgrade_and_downgrade(tmp_path: Path, monkeypatch) -> None:
    db_file = tmp_path / "mig.db"
    monkeypatch.setenv("CLURE_DATABASE_URL", f"sqlite:///{db_file}")
    get_settings.cache_clear()

    root = Path(__file__).resolve().parent.parent
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_file}")

    command.upgrade(cfg, "head")
    command.downgrade(cfg, "0016_inbox_dedupe_and_fields")
    command.upgrade(cfg, "head")
