"""跨源（CORS）與原生 App Bearer JWT 認證測試。"""
from __future__ import annotations

from datetime import timedelta

from fastapi.testclient import TestClient

from app import db as dbmod
from app.core.security import decode_token
from app.main import app
from app.model import RefreshToken
from tests.conftest import PASSWORD, Api


def _bearer_client(ip: str = "10.8.0.1") -> TestClient:
    return TestClient(app, headers={"X-Real-IP": ip, "User-Agent": "Aster-iOS/4.1.54"})


def test_cors_preflight_allows_capacitor_and_blocks_unknown_origin() -> None:
    c = _bearer_client()
    for origin in ("capacitor://localhost", "ionic://localhost", "http://localhost"):
        r = c.options(
            "/api/auth/login",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Authorization, Content-Type, X-Auth-Mode",
            },
        )
        assert r.status_code == 200
        assert r.headers.get("access-control-allow-origin") == origin
        allowed_headers = (r.headers.get("access-control-allow-headers") or "").lower()
        assert "authorization" in allowed_headers
        assert "content-type" in allowed_headers
        assert "x-auth-mode" in allowed_headers

    bad = c.options(
        "/api/auth/login",
        headers={
            "Origin": "https://evil.example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type",
        },
    )
    assert "access-control-allow-origin" not in bad.headers


def test_bearer_register_login_access_and_sessions() -> None:
    c = _bearer_client()
    reg = c.post(
        "/api/auth/register",
        json={"username": "native_u1", "email": "native_u1@example.com", "password": PASSWORD},
        headers={"Origin": "capacitor://localhost", "X-Auth-Mode": "bearer"},
    )
    assert reg.status_code == 201
    assert reg.headers.get("access-control-allow-origin") == "capacitor://localhost"
    body = reg.json()
    assert body["username"] == "native_u1"
    assert body["token_type"] == "bearer"
    assert body["access_token"] and body["refresh_token"]
    # Bearer 模式不種 Auth Cookie
    set_cookies = "".join(reg.headers.get_list("set-cookie"))
    assert "clure_access=" not in set_cookies
    assert "clure_refresh=" not in set_cookies

    # 用 Bearer Access Token 存取受保護的 GET 與非 GET 端點（不需 Cookie 與 CSRF）
    auth_headers = {"Authorization": f"Bearer {body['access_token']}", "Origin": "capacitor://localhost"}
    me = c.get("/api/auth/me", headers=auth_headers)
    assert me.status_code == 200 and me.json()["username"] == "native_u1"
    assert c.get("/api/auth/check", headers=auth_headers).status_code == 204

    tok = c.post("/api/inbox/tokens", json={"name": "iPhone"}, headers=auth_headers)
    assert tok.status_code == 201 and tok.json()["token"]

    sessions = c.get("/api/auth/sessions", headers=auth_headers)
    assert sessions.status_code == 200
    assert any(s["current"] is True for s in sessions.json())

    # 登入（Bearer 模式）
    login = c.post(
        "/api/auth/login",
        json={"identifier": "native_u1", "password": PASSWORD},
        headers={"Origin": "capacitor://localhost", "X-Auth-Mode": "bearer"},
    )
    assert login.status_code == 200
    assert login.json()["access_token"] and login.json()["refresh_token"]


def test_bearer_refresh_rotation_and_reuse_detection() -> None:
    c = _bearer_client("10.8.0.2")
    reg = c.post(
        "/api/auth/register",
        json={"username": "native_u2", "email": "native_u2@example.com", "password": PASSWORD},
        headers={"X-Auth-Mode": "bearer"},
    )
    assert reg.status_code == 201
    refresh1 = reg.json()["refresh_token"]

    ref = c.post(
        "/api/auth/refresh",
        json={"refresh_token": refresh1},
        headers={"X-Auth-Mode": "bearer"},
    )
    assert ref.status_code == 200
    access2 = ref.json()["access_token"]
    refresh2 = ref.json()["refresh_token"]
    assert refresh2 and refresh2 != refresh1

    # 寬限期後重用舊 Refresh Token → 觸發重用偵測並撤銷整條權杖鏈
    for s in dbmod.session_scope():
        jti = decode_token(refresh1, "refresh")["jti"]
        row = s.get(RefreshToken, jti)
        row.revoked_at = row.revoked_at - timedelta(minutes=5)
        s.commit()

    thief = _bearer_client("10.8.9.9")
    assert thief.post("/api/auth/refresh", json={"refresh_token": refresh1}, headers={"X-Auth-Mode": "bearer"}).status_code == 401
    # 合法裝置的新 Refresh Token 與 Access Token 一併失效
    assert c.post("/api/auth/refresh", json={"refresh_token": refresh2}, headers={"X-Auth-Mode": "bearer"}).status_code == 401
    assert c.get("/api/auth/me", headers={"Authorization": f"Bearer {access2}"}).status_code == 401


def test_bearer_logout_revokes_refresh_and_access() -> None:
    c = _bearer_client("10.8.0.3")
    reg = c.post(
        "/api/auth/register",
        json={"username": "native_u3", "email": "native_u3@example.com", "password": PASSWORD},
        headers={"X-Auth-Mode": "bearer"},
    )
    assert reg.status_code == 201
    access = reg.json()["access_token"]
    refresh = reg.json()["refresh_token"]

    out = c.post(
        "/api/auth/logout",
        json={"refresh_token": refresh},
        headers={"X-Auth-Mode": "bearer", "Authorization": f"Bearer {access}"},
    )
    assert out.status_code == 200
    assert c.get("/api/auth/me", headers={"Authorization": f"Bearer {access}"}).status_code == 401
    assert c.post("/api/auth/refresh", json={"refresh_token": refresh}, headers={"X-Auth-Mode": "bearer"}).status_code == 401


def test_bearer_change_password_returns_new_tokens_and_invalidates_other_devices() -> None:
    c1 = _bearer_client("10.8.0.4")
    c2 = _bearer_client("10.8.0.5")
    reg = c1.post(
        "/api/auth/register",
        json={"username": "native_u4", "email": "native_u4@example.com", "password": PASSWORD},
        headers={"X-Auth-Mode": "bearer"},
    )
    assert reg.status_code == 201
    access1 = reg.json()["access_token"]

    login2 = c2.post(
        "/api/auth/login",
        json={"identifier": "native_u4", "password": PASSWORD},
        headers={"X-Auth-Mode": "bearer"},
    )
    assert login2.status_code == 200
    access2 = login2.json()["access_token"]

    chg = c1.post(
        "/api/auth/change-password",
        json={"current_password": PASSWORD, "new_password": "NewPassw0rd!"},
        headers={"Authorization": f"Bearer {access1}", "X-Auth-Mode": "bearer"},
    )
    assert chg.status_code == 200
    new_access = chg.json()["access_token"]
    assert new_access and new_access != access1
    assert c1.get("/api/auth/me", headers={"Authorization": f"Bearer {new_access}"}).status_code == 200
    # 其他裝置舊權杖因 token_version 遞增立即失效
    assert c2.get("/api/auth/me", headers={"Authorization": f"Bearer {access2}"}).status_code == 401


def test_cookie_csrf_remains_strict_even_with_bearer_headers(api: Api) -> None:
    # 未帶 X-Auth-Mode: bearer 也沒帶 Bearer Token 時，CSRF 仍嚴格擋下
    assert api.c.post("/api/auth/login", json={"identifier": "a", "password": "b"}).status_code == 403

    # 非認證端點只帶 X-Auth-Mode: bearer（沒有 Authorization: Bearer）仍須通過 CSRF
    assert api.c.post("/api/inbox/tokens", json={"name": "x"}, headers={"X-Auth-Mode": "bearer"}).status_code == 403

    # Cookie 已登入狀態（帶有 clure_access Cookie）：就算偽造 Authorization: Bearer 或 X-Auth-Mode: bearer，沒有 X-CSRF-Token 仍被擋
    assert api.register("cookie_user").status_code == 201
    assert api.c.post(
        "/api/inbox/tokens",
        json={"name": "x"},
        headers={"Authorization": "Bearer fake-token", "X-Auth-Mode": "bearer"},
    ).status_code == 403
    assert api.c.post(
        "/api/auth/logout",
        headers={"X-Auth-Mode": "bearer"},
    ).status_code == 403


def test_bearer_logout_without_refresh_body_revokes_family_and_delete_account_omits_cookies() -> None:
    c = _bearer_client("10.8.0.6")
    reg = c.post(
        "/api/auth/register",
        json={"username": "native_u5", "email": "native_u5@example.com", "password": PASSWORD},
        headers={"X-Auth-Mode": "bearer"},
    )
    assert reg.status_code == 201
    access1 = reg.json()["access_token"]
    refresh1 = reg.json()["refresh_token"]

    # 僅帶 Authorization: Bearer 登出（未傳 refresh_token body）仍應撤銷該裝置權杖鏈
    out = c.post("/api/auth/logout", headers={"Authorization": f"Bearer {access1}", "X-Auth-Mode": "bearer"})
    assert out.status_code == 200
    assert c.get("/api/auth/me", headers={"Authorization": f"Bearer {access1}"}).status_code == 401
    assert c.post("/api/auth/refresh", json={"refresh_token": refresh1}, headers={"X-Auth-Mode": "bearer"}).status_code == 401

    # 重新登入後刪除帳號（需建立第二位管理員或先註冊一般帳號，這裡另建一般帳號測刪除）
    reg2 = c.post(
        "/api/auth/register",
        json={"username": "native_u6", "email": "native_u6@example.com", "password": PASSWORD},
        headers={"X-Auth-Mode": "bearer"},
    )
    assert reg2.status_code == 201
    access2 = reg2.json()["access_token"]
    deleted = c.request(
        "DELETE",
        "/api/auth/account",
        json={"password": PASSWORD},
        headers={"Authorization": f"Bearer {access2}", "X-Auth-Mode": "bearer"},
    )
    assert deleted.status_code == 200
    assert deleted.headers.get_list("set-cookie") == []
