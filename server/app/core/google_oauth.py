"""Google OAuth 2.0 輔助：產生授權網址、簽章／驗證 state、交換與驗證 Google ID Token。"""
from __future__ import annotations

import json
import secrets
import urllib.error
import urllib.parse
import urllib.request
from datetime import timedelta, timezone
from typing import Any

import jwt
from fastapi import Request

from app.core.config import get_settings
from app.core.security import utcnow
from app.service.errors import ServiceError

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"


def google_configured() -> bool:
    s = get_settings()
    return bool(s.google_client_id.strip() and s.google_client_secret.strip())


def sanitize_next_path(raw: str | None) -> str:
    if not raw or not raw.startswith("/") or raw.startswith("//"):
        return "/"
    return raw


def resolve_redirect_uri(request: Request) -> str:
    s = get_settings()
    if s.google_redirect_uri.strip():
        return s.google_redirect_uri.strip()
    if s.public_url.strip():
        return f"{s.public_url.strip().rstrip('/')}/api/auth/google/callback"
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}/api/auth/google/callback"


def create_oauth_state(*, next_path: str = "/", mode: str = "login") -> str:
    s = get_settings()
    now = utcnow()
    exp = now + timedelta(minutes=10)
    payload = {
        "type": "google_oauth",
        "nonce": secrets.token_urlsafe(12),
        "next": sanitize_next_path(next_path),
        "mode": "register" if mode == "register" else "login",
        "exp": int(exp.replace(tzinfo=timezone.utc).timestamp()),
    }
    return jwt.encode(payload, s.resolved_jwt_secret(), algorithm=s.jwt_algorithm)


def verify_oauth_state(state: str | None) -> dict[str, Any] | None:
    if not state:
        return None
    s = get_settings()
    try:
        payload = jwt.decode(state, s.resolved_jwt_secret(), algorithms=[s.jwt_algorithm], options={"require": ["exp", "type"]})
    except jwt.PyJWTError:
        return None
    if payload.get("type") != "google_oauth":
        return None
    return payload


def build_google_auth_url(redirect_uri: str, state: str) -> str:
    s = get_settings()
    qs = urllib.parse.urlencode({
        "client_id": s.google_client_id.strip(),
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    })
    return f"{GOOGLE_AUTH_URL}?{qs}"


def exchange_google_code(code: str, redirect_uri: str) -> dict[str, Any]:
    """用授權碼向 Google 換取並驗證 ID Token，回傳含 email 與 name 的使用者資訊。"""
    s = get_settings()
    body = urllib.parse.urlencode({
        "code": code,
        "client_id": s.google_client_id.strip(),
        "client_secret": s.google_client_secret.strip(),
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }).encode("utf-8")
    req = urllib.request.Request(
        GOOGLE_TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            token_data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise ServiceError(502, "無法連線 Google 驗證伺服器，請稍後再試") from e

    id_token = token_data.get("id_token")
    if not id_token or not isinstance(id_token, str):
        raise ServiceError(401, "Google 未回傳身分憑證")

    info_url = f"{GOOGLE_TOKENINFO_URL}?{urllib.parse.urlencode({'id_token': id_token})}"
    try:
        with urllib.request.urlopen(info_url, timeout=10) as resp:
            info = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise ServiceError(401, "Google 身分驗證失敗，請重試") from e

    if info.get("aud") != s.google_client_id.strip():
        raise ServiceError(401, "Google 憑證對象不符")
    verified = info.get("email_verified")
    if verified not in (True, "true", "True"):
        raise ServiceError(403, "此 Google 帳號的 Email 尚未通過驗證")
    email = str(info.get("email") or "").strip().lower()
    if not email:
        raise ServiceError(400, "無法從 Google 取得 Email")
    return {"email": email, "name": str(info.get("name") or "").strip()}
