"""認證路由：註冊、登入、刷新、登出、目前使用者、變更密碼。"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Request, Response
from fastapi.responses import Response as PlainResponse
from sqlalchemy.orm import Session

from app.api.cookies import clear_auth_cookies, read_bearer_token, read_refresh, set_auth_cookies
from app.api.deps import get_client, get_current_user, get_db, get_optional_user, login_account_limiter, login_ip_limiter, rate_limit, register_limiter, reset_account_limiter, reset_ip_limiter
from app.core.config import get_settings
from app.core.mailer import mail_configured
from app.core.request_info import ClientInfo
from app.model import User
from app.schema.auth import (BearerAuthResponse, ChangePasswordRequest, ForgotPasswordRequest, LoginRequest, MessageResponse, RefreshTokenRequest, RegisterRequest, ResetPasswordRequest, SessionOut,
                             TotpDisableRequest, TotpEnabled, PasswordCheckRequest, TotpEnableRequest, TotpSetup, TotpStatus, UserPublic)
from app.service.app_settings import registration_open
from app.service.auth_service import AuthService, IssuedTokens

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _is_bearer_mode(request: Request, body: RefreshTokenRequest | None = None) -> bool:
    if request.headers.get("x-auth-mode", "").strip().lower() == "bearer":
        return True
    if read_bearer_token(request) is not None:
        return True
    return bool(body and body.refresh_token)


def _respond(response: Response, request: Request, tokens: IssuedTokens, user: User, *, bearer: bool = False) -> UserPublic | BearerAuthResponse:
    response.headers["Cache-Control"] = "no-store"
    pub = UserPublic.model_validate(user)
    if bearer:
        return BearerAuthResponse(**pub.model_dump(), access_token=tokens.access_token, refresh_token=tokens.refresh_token)
    set_auth_cookies(response, request, access=tokens.access_token, access_exp=tokens.access_expires,
                     refresh=tokens.refresh_token, refresh_exp=tokens.refresh_expires, user_id=user.id)
    return pub


@router.get("/registration", summary="是否開放註冊（登入頁決定要不要顯示註冊連結）")
def registration(db: Session = Depends(get_db)) -> dict[str, bool]:
    return {"open": registration_open(db)}


@router.post("/register", response_model=UserPublic | BearerAuthResponse, status_code=201, summary="註冊")
def register(body: RegisterRequest, request: Request, response: Response, client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> UserPublic | BearerAuthResponse:
    rate_limit(register_limiter, client.ip)
    user, tokens = AuthService(db).register(body, client)
    return _respond(response, request, tokens, user, bearer=_is_bearer_mode(request))


@router.post("/login", response_model=UserPublic | BearerAuthResponse, summary="登入")
def login(body: LoginRequest, request: Request, response: Response, client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> UserPublic | BearerAuthResponse:
    rate_limit(login_ip_limiter, client.ip)
    rate_limit(login_account_limiter, f"{client.ip}:{body.identifier.lower()}")
    user, tokens = AuthService(db).login(body, client)
    return _respond(response, request, tokens, user, bearer=_is_bearer_mode(request))


@router.get("/forgot-info", summary="忘記密碼的方式：寄信重設，或聯絡管理員")
def forgot_info() -> dict[str, object]:
    s = get_settings()
    return {"mail": mail_configured() and bool(s.public_url), "contact": s.admin_contact_email}


@router.post("/forgot-password", response_model=MessageResponse, summary="忘記密碼：寄重設連結")
def forgot_password(body: ForgotPasswordRequest, client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> MessageResponse:
    rate_limit(reset_ip_limiter, client.ip)
    rate_limit(reset_account_limiter, body.identifier.lower())
    AuthService(db).request_reset(body.identifier, client)
    return MessageResponse(message="如果這個帳號存在，重設密碼的信已寄出，請到信箱查看（也看看垃圾郵件）")


@router.post("/reset-password", response_model=MessageResponse, summary="用信中的連結設定新密碼")
def reset_password(body: ResetPasswordRequest, client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> MessageResponse:
    rate_limit(reset_ip_limiter, client.ip)
    AuthService(db).reset_password(body, client)
    return MessageResponse(message="密碼已重設，請用新密碼登入")


@router.post("/refresh", response_model=UserPublic | BearerAuthResponse, summary="刷新權杖（輪替）")
def refresh(request: Request, response: Response, body: RefreshTokenRequest | None = Body(default=None), client: ClientInfo = Depends(get_client), db: Session = Depends(get_db)) -> UserPublic | BearerAuthResponse:
    bearer = _is_bearer_mode(request, body)
    token = (body.refresh_token if body and body.refresh_token else None) if bearer else read_refresh(request)
    user, tokens = AuthService(db).refresh(token, client)
    return _respond(response, request, tokens, user, bearer=bearer)


@router.post("/logout", response_model=MessageResponse, summary="登出")
def logout(request: Request, response: Response, body: RefreshTokenRequest | None = Body(default=None), client: ClientInfo = Depends(get_client), user: User | None = Depends(get_optional_user), db: Session = Depends(get_db)) -> MessageResponse:
    bearer = _is_bearer_mode(request, body)
    token = (body.refresh_token if body and body.refresh_token else None) if bearer else read_refresh(request)
    AuthService(db).logout(token, user, client, family_id=_current_family(request) if not token else None)
    if not bearer:
        clear_auth_cookies(response, request)
    return MessageResponse(message="已登出")


@router.get("/me", response_model=UserPublic, summary="目前使用者")
def me(response: Response, user: User = Depends(get_current_user)) -> User:
    response.headers["Cache-Control"] = "no-store"
    return user


@router.post("/change-password", response_model=UserPublic | BearerAuthResponse, summary="變更密碼")
def change_password(body: ChangePasswordRequest, request: Request, response: Response, client: ClientInfo = Depends(get_client),
                    user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> UserPublic | BearerAuthResponse:
    tokens = AuthService(db).change_password(user, body, client)
    return _respond(response, request, tokens, user, bearer=_is_bearer_mode(request))


@router.get("/check", status_code=204, summary="登入檢查（nginx auth_request 用）", include_in_schema=False)
def check(user: User | None = Depends(get_optional_user)) -> PlainResponse:
    """已登入（Access Token 有效）回 204，否則 401。關閉 proxy_require_login 時一律 204。"""
    if user or not get_settings().proxy_require_login:
        return PlainResponse(status_code=204)
    return PlainResponse(status_code=401)


# ───── 雙因素驗證（TOTP） ─────

@router.get("/2fa", response_model=TotpStatus, summary="雙因素驗證狀態")
def totp_status(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict[str, object]:
    return AuthService(db).totp_status(user)


@router.post("/2fa/setup", response_model=TotpSetup, summary="開始設定雙因素驗證：產生密鑰")
def totp_setup(client: ClientInfo = Depends(get_client), user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> dict[str, str]:
    rate_limit(login_account_limiter, f"2fa:{user.id}")
    return AuthService(db).totp_setup(user, client)


@router.post("/2fa/enable", response_model=TotpEnabled, summary="輸入驗證 App 上的 6 位數，完成啟用（回傳一次性備援碼）")
def totp_enable(body: TotpEnableRequest, client: ClientInfo = Depends(get_client), user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> TotpEnabled:
    rate_limit(login_account_limiter, f"2fa:{user.id}")
    return TotpEnabled(recovery_codes=AuthService(db).totp_enable(user, body.code, client))


@router.post("/2fa/disable", response_model=MessageResponse, summary="關閉雙因素驗證（要密碼＋驗證碼）")
def totp_disable(body: TotpDisableRequest, client: ClientInfo = Depends(get_client), user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> MessageResponse:
    rate_limit(login_account_limiter, f"2fa:{user.id}")
    AuthService(db).totp_disable(user, body.password, body.code, client)
    return MessageResponse(message="已關閉雙因素驗證")


# ───── 已登入的裝置 ─────

def _current_family(request: Request) -> str | None:
    """目前這台裝置的權杖鏈：Bearer 模式看 Access Token；Cookie 模式看 Refresh Token。"""
    from app.core.security import decode_token
    bearer = read_bearer_token(request)
    if bearer is not None:
        payload = decode_token(bearer, "access")
        return payload.get("fam") if payload else None
    refresh_tok = read_refresh(request)
    if refresh_tok:
        payload = decode_token(refresh_tok, "refresh")
        return payload.get("fam") if payload else None
    return None


@router.get("/sessions", response_model=list[SessionOut], summary="已登入的裝置")
def sessions(request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[SessionOut]:
    return AuthService(db).sessions(user, _current_family(request))


@router.delete("/sessions/{family_id}", response_model=MessageResponse, summary="登出某一台裝置")
def revoke_session(family_id: str, request: Request, client: ClientInfo = Depends(get_client), user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> MessageResponse:
    AuthService(db).revoke_session(user, family_id, _current_family(request), client)
    return MessageResponse(message="已登出該裝置")


# ───── 再確認身分、刪除帳號 ─────

@router.post("/verify-password", response_model=MessageResponse, summary="再確認身分（忘記 App 鎖 PIN 時，用帳號密碼解除這台裝置的 PIN）")
def verify_password_endpoint(body: PasswordCheckRequest, client: ClientInfo = Depends(get_client), user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> MessageResponse:
    rate_limit(login_account_limiter, f"verify:{user.id}")
    AuthService(db).confirm_identity(user, body.password, body.totp, client, "auth.verify_password")
    return MessageResponse(message="已確認")


@router.delete("/account", response_model=MessageResponse, summary="刪除帳號與伺服器上的全部資料（不可復原）")
def delete_account(body: PasswordCheckRequest, request: Request, response: Response, client: ClientInfo = Depends(get_client),
                   user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> MessageResponse:
    rate_limit(login_account_limiter, f"delete:{user.id}")
    AuthService(db).delete_account(user, body.password, body.totp, client)
    if not _is_bearer_mode(request):
        clear_auth_cookies(response, request)
    return MessageResponse(message="帳號已刪除")
