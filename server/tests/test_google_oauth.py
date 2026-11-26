"""Google OAuth 2.0 登入與註冊測試。"""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

from app.core.config import get_settings


def _enable_google(monkeypatch) -> None:
    s = get_settings()
    monkeypatch.setattr(s, "google_client_id", "test-client-id.apps.googleusercontent.com")
    monkeypatch.setattr(s, "google_client_secret", "test-client-secret")
    monkeypatch.setattr(s, "google_redirect_uri", "")


def test_providers_flag(api, monkeypatch):
    r = api.get("/api/auth/providers")
    assert r.status_code == 200
    assert r.json() == {"google": False, "email_verify": False}

    _enable_google(monkeypatch)
    r2 = api.get("/api/auth/providers")
    assert r2.status_code == 200
    assert r2.json() == {"google": True, "email_verify": False}


def test_google_register_needs_profile_setup_and_email_verify_code(api, monkeypatch):
    _enable_google(monkeypatch)
    start = api.get("/api/auth/google/start?mode=register", follow_redirects=False)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    monkeypatch.setattr(
        "app.api.auth.exchange_google_code",
        lambda code, redirect_uri: {"email": "bob@gmail.com", "name": "Bob"},
    )
    cb = api.get(f"/api/auth/google/callback?code=c1&state={state}", follow_redirects=False)
    assert cb.status_code == 302
    me = api.get("/api/auth/me").json()
    assert me["needs_profile_setup"] is True

    done = api.post("/api/auth/setup-profile", json={"username": "bob_custom", "password": "Password123"})
    assert done.status_code == 200
    assert done.json()["username"] == "bob_custom"
    assert done.json()["needs_profile_setup"] is False

    # 測試 SMTP 啟用時，傳統註冊需要信箱驗證碼
    api.post("/api/auth/logout")
    s = get_settings()
    monkeypatch.setattr(s, "smtp_host", "smtp.gmail.com")
    monkeypatch.setattr(s, "smtp_user", "sender@gmail.com")
    monkeypatch.setattr(s, "smtp_password", "app-pw")
    sent = {}

    def fake_send_mail(*, to: str, subject: str, body: str, **_kw: object) -> None:
        sent["to"] = to
        sent["body"] = body

    monkeypatch.setattr("app.service.auth_service.send_mail", fake_send_mail)
    rc = api.post("/api/auth/register-code", json={"email": "carol@gmail.com"})
    assert rc.status_code == 200
    token = rc.json()["token"]
    import re
    code = re.search(r"(\d{6})", sent["body"]).group(1)

    bad_reg = api.post("/api/auth/register", json={"username": "carol", "email": "carol@gmail.com", "password": "Password123", "verification_code": "000000", "verification_token": token})
    assert bad_reg.status_code == 400

    ok_reg = api.post("/api/auth/register", json={"username": "carol", "email": "carol@gmail.com", "password": "Password123", "verification_code": code, "verification_token": token})
    assert ok_reg.status_code == 201
    assert ok_reg.json()["needs_profile_setup"] is False


def test_google_start_and_callback_register_then_login(api, monkeypatch):
    _enable_google(monkeypatch)
    start = api.get("/api/auth/google/start?mode=register&next=/", follow_redirects=False)
    assert start.status_code == 302
    loc = urlparse(start.headers["location"])
    assert loc.netloc == "accounts.google.com"
    qs = parse_qs(loc.query)
    assert qs["client_id"] == ["test-client-id.apps.googleusercontent.com"]
    assert qs["redirect_uri"] == ["https://aster.test/api/auth/google/callback"]
    state = qs["state"][0]

    monkeypatch.setattr(
        "app.api.auth.exchange_google_code",
        lambda code, redirect_uri: {"email": "Alice.Chen@gmail.com", "name": "Alice"},
    )
    cb = api.get(f"/api/auth/google/callback?code=fake-code&state={state}", follow_redirects=False)
    assert cb.status_code == 302
    assert cb.headers["location"] == "/"

    me = api.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["email"] == "alice.chen@gmail.com"
    assert me.json()["role"] == "admin"

    # 登出後再次用 Google 登入同一信箱，應直接登入而非重複註冊
    api.post("/api/auth/logout")
    start2 = api.get("/api/auth/google/start?mode=login", follow_redirects=False)
    state2 = parse_qs(urlparse(start2.headers["location"]).query)["state"][0]
    cb2 = api.get(f"/api/auth/google/callback?code=fake-code-2&state={state2}", follow_redirects=False)
    assert cb2.status_code == 302
    assert api.get("/api/auth/me").json()["id"] == me.json()["id"]


def test_google_callback_rejects_bad_state_or_closed_registration(api, monkeypatch):
    _enable_google(monkeypatch)
    bad = api.get("/api/auth/google/callback?code=x&state=tampered", follow_redirects=False)
    assert bad.status_code == 302
    assert bad.headers["location"].startswith("/login?oauth_error=")

    s = get_settings()
    monkeypatch.setattr(s, "allow_registration", False)
    start = api.get("/api/auth/google/start?mode=register", follow_redirects=False)
    state = parse_qs(urlparse(start.headers["location"]).query)["state"][0]
    monkeypatch.setattr(
        "app.api.auth.exchange_google_code",
        lambda code, redirect_uri: {"email": "newuser@gmail.com", "name": "New"},
    )
    closed = api.get(f"/api/auth/google/callback?code=ok&state={state}", follow_redirects=False)
    assert closed.status_code == 302
    assert closed.headers["location"].startswith("/register?oauth_error=")
