"""收件匣路由。

- /api/inbox/*：App 使用（登入 Cookie，非 GET 需 CSRF）：管理捷徑權杖、列出與確認待記帳項目
- /api/hook/inbox：iPhone 捷徑使用（Authorization: Bearer clr_…，或匯入式捷徑用的 ?t=clr_…）；不使用 Cookie，因此不需要 CSRF
"""
from __future__ import annotations

import hmac
import logging

from fastapi import APIRouter, Depends, Header, Query, Response
from sqlalchemy.orm import Session

from app.api.deps import get_client, get_current_user, get_db, rate_limit
from app.core.config import get_settings
from app.core.rate_limit import RateLimiter
from app.core.request_info import ClientInfo
from app.model import User
from app.schema.auth import MessageResponse
from app.schema.inbox import (
    AckRequest,
    AckResult,
    BookingRequest,
    EmailForwardBindingOut,
    EmailForwardHookIn,
    EmailForwardSetup,
    HookItem,
    HookResult,
    InboxItemOut,
    TokenCreate,
    TokenCreated,
    TokenOut,
)
from app.service.email_forward import EmailForwardService
from app.service.errors import ServiceError
from app.service.inbox_service import InboxService

log = logging.getLogger("aster.inbox")

router = APIRouter(prefix="/api/inbox", tags=["inbox"])
hook_router = APIRouter(prefix="/api/hook", tags=["inbox"])
# 每組權杖每分鐘最多 30 則；錯誤的權杖以 IP 計，避免被拿來猜權杖
hook_limiter = RateLimiter(30, name="inbox-hook")
hook_ip_limiter = RateLimiter(60, name="inbox-hook-ip")
email_hook_limiter = RateLimiter(120, name="email-hook")


@router.get("/tokens", response_model=list[TokenOut], summary="捷徑權杖列表")
def tokens(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[TokenOut]:
    return [TokenOut.model_validate(t) for t in InboxService(db).tokens(user)]


@router.post("/tokens", response_model=TokenCreated, status_code=201, summary="建立捷徑權杖（原文只回傳這一次）")
def create_token(body: TokenCreate, user: User = Depends(get_current_user), client: ClientInfo = Depends(get_client),
                 db: Session = Depends(get_db)) -> TokenCreated:
    token, row = InboxService(db).create_token(user, body.name, client)
    return TokenCreated(token=token, item=TokenOut.model_validate(row))


@router.delete("/tokens/{token_id}", response_model=MessageResponse, summary="撤銷捷徑權杖")
def revoke_token(token_id: int, user: User = Depends(get_current_user), client: ClientInfo = Depends(get_client),
                 db: Session = Depends(get_db)) -> MessageResponse:
    InboxService(db).revoke_token(user, token_id, client)
    return MessageResponse(message="已撤銷，使用這組權杖的捷徑將無法再送出")


@router.get("/items", response_model=list[InboxItemOut], summary="待確認的項目")
def items(response: Response, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[InboxItemOut]:
    rows, purged_count = InboxService(db).items_with_meta(user)
    if purged_count:
        response.headers["X-Inbox-Purged-Count"] = str(purged_count)
    return [InboxItemOut.model_validate(i) for i in rows]


@router.post("/items/booking", response_model=MessageResponse, summary="登記通知的固定記帳結構")
def reserve_booking(body: BookingRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> MessageResponse:
    InboxService(db).reserve_booking(user, body)
    return MessageResponse(message="已登記，可安全重試同一記帳方式")


@router.post("/items/ack", response_model=AckResult, summary="已記帳或略過，從收件匣移除")
def ack(body: AckRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> AckResult:
    return AckResult(ids=InboxService(db).ack(user, body.ids))


@hook_router.post("/inbox", response_model=HookResult, summary="iPhone 捷徑送進收件匣")
def hook(body: HookItem, client: ClientInfo = Depends(get_client), authorization: str | None = Header(None), x_aster_token: str | None = Header(None),
         x_clure_token: str | None = Header(None),
         t: str | None = Query(None, max_length=80), db: Session = Depends(get_db)) -> HookResult:
    # 匯入式捷徑只有一個「連結碼」（網址＋?t=權杖），手動設定的捷徑則用 Authorization 標頭；X-Clure-Token 是更名前的標頭
    token = x_aster_token or x_clure_token or (authorization[7:].strip() if authorization and authorization[:7].lower() == "bearer " else None) or t
    rate_limit(hook_ip_limiter, client.ip or "?")
    svc = InboxService(db)
    user, row = svc.user_for_token(token)
    rate_limit(hook_limiter, str(row.id))
    item, status = svc.receive_with_status(user, row, body)
    if status == "noise":
        return HookResult(message="已略過非消費通知")
    if status == "duplicate" or item is None:
        return HookResult(message="已收到（重複通知略過）")
    # 立即推播：有訂閱背景推播的裝置會收到通知，點開直達收件匣。內容不含金額與商家（與 E2EE 推播一致）；失敗不影響收件
    try:
        from app.service.push_service import PushService
        PushService(db).send_to_user(user.id, {"title": "📥 收件匣有新項目", "body": "打開 Aster 確認記帳", "url": "/inbox", "tag": f"inbox:{item.id}"})
    except Exception:  # noqa: BLE001 — 推播失敗不能影響捷徑收件
        log.exception("收件匣推播失敗")
    if body.source == "siri" and body.text:
        return HookResult(message=f"已記進 Aster 收件匣：{body.text[:40]}")
    return HookResult(message="已送到 Aster，打開 App 確認記帳")


@router.get("/email-forward", response_model=EmailForwardBindingOut | None, summary="取得 Email 自動轉寄設定")
def get_email_forward(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> EmailForwardBindingOut | None:
    row = EmailForwardService(db).get_binding(user)
    return EmailForwardBindingOut.model_validate(row) if row else None


@router.post("/email-forward", response_model=EmailForwardBindingOut, summary="建立或更新 Email 自動轉寄位址")
def setup_email_forward(
    body: EmailForwardSetup,
    user: User = Depends(get_current_user),
    client: ClientInfo = Depends(get_client),
    db: Session = Depends(get_db),
) -> EmailForwardBindingOut:
    row = EmailForwardService(db).setup_binding(user, body.source_email, client)
    return EmailForwardBindingOut.model_validate(row)


@router.post("/email-forward/verify", response_model=EmailForwardBindingOut, summary="標記 Email 轉寄已完成驗證")
def verify_email_forward(
    user: User = Depends(get_current_user),
    client: ClientInfo = Depends(get_client),
    db: Session = Depends(get_db),
) -> EmailForwardBindingOut:
    row = EmailForwardService(db).mark_verified(user, client)
    return EmailForwardBindingOut.model_validate(row)


@router.delete("/email-forward", response_model=MessageResponse, summary="移除 Email 自動轉寄設定")
def delete_email_forward(
    user: User = Depends(get_current_user),
    client: ClientInfo = Depends(get_client),
    db: Session = Depends(get_db),
) -> MessageResponse:
    EmailForwardService(db).delete_binding(user, client)
    return MessageResponse(message="已移除 Email 自動轉寄設定")


@hook_router.post("/email", response_model=HookResult, summary="Cloudflare Email Worker 轉寄收信 Webhook")
def hook_email(
    body: EmailForwardHookIn,
    client: ClientInfo = Depends(get_client),
    x_aster_webhook_secret: str | None = Header(None),
    db: Session = Depends(get_db),
) -> HookResult:
    rate_limit(email_hook_limiter, client.ip or "?")
    secret = get_settings().email_webhook_secret.strip()
    if not secret or not x_aster_webhook_secret or not hmac.compare_digest(x_aster_webhook_secret.strip(), secret):
        raise ServiceError(401, "Webhook 密鑰驗證失敗")

    status, item, user = EmailForwardService(db).receive_webhook(body)
    if status == "not_found" or user is None:
        raise ServiceError(404, "找不到對應的轉寄位址")
    if status == "verification":
        return HookResult(message="已收到 Gmail 轉寄驗證信")
    if status == "noise":
        return HookResult(message="已略過非消費通知")
    if status == "duplicate" or item is None:
        return HookResult(message="已收到（重複通知略過）")

    try:
        from app.service.push_service import PushService
        PushService(db).send_to_user(
            user.id,
            {"title": "📥 收件匣有新項目", "body": "打開 Aster 確認記帳", "url": "/inbox", "tag": f"inbox:{item.id}"},
        )
    except Exception:  # noqa: BLE001 — 推播失敗不能影響收信結果
        log.exception("Email Webhook 收件匣推播失敗")
    return HookResult(message="已送到 Aster，打開 App 確認記帳")
