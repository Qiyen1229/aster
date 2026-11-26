"""認證業務邏輯：註冊、登入（鎖定）、權杖簽發與輪替（重用偵測）、登出、變更密碼。"""
from __future__ import annotations

import hashlib
import html
import logging
import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.logging import mask_email
from app.core.request_info import ClientInfo
from app.core import secretbox, totp
from app.core.security import create_email_verify_token, create_token, decode_token, hash_password, needs_rehash, utcnow, verify_email_code, verify_password
from app.core.mailer import MailError, mail_configured, send_mail
from app.model import ROLE_ADMIN, ROLE_USER, PasswordReset, RefreshToken, User
from sqlalchemy import select
from app.repository.token_repository import TokenRepository
from app.repository.user_repository import UserRepository
from app.schema.auth import ChangePasswordRequest, LoginRequest, RegisterRequest, ResetPasswordRequest, SessionOut, SetupProfileRequest, check_email_domain
from app.service import app_settings
from app.service.audit_service import AuditService
from app.service.errors import ServiceError

log = logging.getLogger("aster.auth")
# 兩個分頁同時刷新時，舊權杖在這段時間內再次使用不視為遭竊
REFRESH_REUSE_GRACE = timedelta(seconds=30)


@dataclass
class IssuedTokens:
    access_token: str
    access_expires: datetime
    refresh_token: str
    refresh_expires: datetime


class AuthService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.users = UserRepository(db)
        self.tokens = TokenRepository(db)
        self.audit = AuditService(db)
        self.settings = get_settings()

    # ───── 權杖 ─────
    def issue_tokens(self, user: User, client: ClientInfo, family_id: str | None = None) -> IssuedTokens:
        family = family_id or uuid.uuid4().hex
        # Access Token 也記下它屬於哪一台裝置（family）：遠端登出那台裝置時，它的 Access Token 立刻失效，不用等到期
        access, _, access_exp = create_token(user_id=user.id, role=user.role, token_version=user.token_version, token_type="access", family_id=family)
        refresh, jti, refresh_exp = create_token(user_id=user.id, role=user.role, token_version=user.token_version, token_type="refresh", family_id=family)
        self.tokens.add(RefreshToken(id=jti, user_id=user.id, family_id=family, expires_at=refresh_exp, ip=client.ip, user_agent=client.user_agent))
        return IssuedTokens(access, access_exp, refresh, refresh_exp)

    def authenticate_access(self, token: str | None) -> User | None:
        """驗證 Access Token，並比對帳號狀態與 token_version（凍結、強制登出、改密碼後立即失效）。"""
        if not token:
            return None
        payload = decode_token(token, "access")
        if not payload:
            return None
        try:
            user = self.users.get(int(payload["sub"]))
        except (TypeError, ValueError):
            return None
        if not user or not user.is_active or payload.get("ver") != user.token_version:
            return None
        fam = payload.get("fam")
        if fam and not self.tokens.family_active(fam, utcnow()):
            return None  # 這台裝置已被登出（自己登出、被別台踢掉、重用偵測）
        return user

    def _acquire_write_lock(self, lock_id: int) -> None:
        """取得跨行程交易寫入鎖，避免管理員數量或首次註冊檢查發生競態。"""
        dialect = self.db.bind.dialect.name if self.db.bind is not None else ""
        if dialect == "postgresql":
            self.db.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": lock_id})
        elif dialect == "sqlite":
            self.db.rollback()
            self.db.execute(text("BEGIN IMMEDIATE"))

    # ───── 註冊 ─────
    def send_register_code(self, email: str, client: ClientInfo) -> str:
        if not app_settings.registration_open(self.db, self.settings):
            raise ServiceError(403, "目前未開放註冊，請聯絡管理員")
        if not mail_configured():
            raise ServiceError(503, "伺服器尚未設定寄信功能")
        try:
            check_email_domain(email)
        except ValueError as e:
            raise ServiceError(422, str(e)) from e
        if self.users.get_by_email(email):
            raise ServiceError(409, "此 Email 已被使用")
        code = f"{secrets.randbelow(1_000_000):06d}"
        body = (
            "您好：\n\n"
            "感謝您註冊 Aster 記帳。請於註冊頁面輸入以下 6 位數驗證碼以完成信箱驗證：\n\n"
            f"{code}\n\n"
            "此驗證碼於 10 分鐘內有效，請勿轉傳或提供給他人。\n"
            "若您並未進行註冊操作，請忽略本信件。\n\n"
            "——\n此為系統自動發送之通知信件，請勿直接回覆。"
        )
        email_html = self._render_email_html(
            eyebrow="帳號註冊驗證",
            heading="請輸入您的註冊驗證碼",
            greeting="您好：",
            lead="感謝您註冊 <strong>Aster 記帳</strong>。請於註冊頁面輸入以下 6 位數驗證碼以完成信箱驗證：",
            code=code,
            notes=[
                "此驗證碼於 <strong>10 分鐘</strong> 內有效，請勿轉傳或提供給他人。",
                "若您並未進行註冊操作，請直接忽略本信件。",
            ],
        )
        try:
            send_mail(to=email, subject="【Aster 記帳】註冊信箱驗證碼", body=body, html=email_html)
        except MailError as e:
            log.warning("寄送註冊驗證碼失敗 email=%s err=%s", mask_email(email), e)
            raise ServiceError(502, "驗證碼寄送失敗，請稍後再試") from e
        self.audit.record("auth.register_code", client, detail={"email": mask_email(email)})
        self.db.commit()
        return create_email_verify_token(email, code)

    def register(self, req: RegisterRequest, client: ClientInfo) -> tuple[User, IssuedTokens]:
        if not app_settings.registration_open(self.db, self.settings):
            raise ServiceError(403, "目前未開放註冊，請聯絡管理員")
        if mail_configured() and not verify_email_code(req.verification_token, req.email, req.verification_code):
            self.audit.record("auth.register", client, success=False, detail={"reason": "bad_email_code"})
            self.db.commit()
            raise ServiceError(400, "信箱驗證碼不正確或已過期，請重新取得")
        if self.users.get_by_username(req.username) or self.users.get_by_email(req.email):
            self.audit.record("auth.register", client, success=False, detail={"reason": "duplicate"})
            self.db.commit()
            raise ServiceError(409, "使用者名稱或 Email 已被使用")
        try:
            check_email_domain(req.email)
        except ValueError as e:
            raise ServiceError(422, str(e)) from e
        self._acquire_write_lock(1001)
        # 全新系統（沒有任何使用者）時，第一位註冊者成為管理員；建議改用環境變數或 CLI 預先建立管理員
        role = ROLE_ADMIN if self.settings.first_user_admin and self.users.count() == 0 else ROLE_USER
        now = utcnow()
        user = self.users.add(User(
            username=req.username, email=req.email, password_hash=hash_password(req.password), role=role,
            password_changed_at=now, last_login_at=now, last_seen_at=now,
        ))
        tokens = self.issue_tokens(user, client)
        self.audit.record("auth.register", client, user_id=user.id, detail={"role": role})
        self.db.commit()
        log.info("使用者註冊 id=%s email=%s role=%s", user.id, mask_email(user.email), role)
        return user, tokens

    def _unique_google_username(self, email: str) -> str:
        base = re.sub(r"[^A-Za-z0-9_.-]", "", email.split("@", 1)[0])[:24]
        if len(base) < 3:
            base = f"user_{base}" if base else "aster_user"
        candidate = base
        while self.users.get_by_username(candidate) is not None:
            candidate = f"{base[:24]}_{secrets.token_hex(3)}"
        return candidate

    def login_or_register_google(self, *, email: str, client: ClientInfo) -> tuple[User, IssuedTokens]:
        """Google OAuth 驗證成功後登入既有帳號，或依註冊設定建立新帳號。"""
        norm_email = email.strip().lower()
        now = utcnow()
        user = self.users.get_by_email(norm_email)
        if user is not None:
            if not user.is_active:
                self.audit.record("auth.google", client, success=False, user_id=user.id, detail={"reason": "inactive"})
                self.db.commit()
                raise ServiceError(403, "此帳號已停用，請聯絡管理員")
            user.failed_login_count = 0
            user.locked_until = None
            user.last_login_at = now
            user.last_seen_at = now
            tokens = self.issue_tokens(user, client)
            self.audit.record("auth.google", client, user_id=user.id, detail={"action": "login"})
            self.db.commit()
            return user, tokens

        if not app_settings.registration_open(self.db, self.settings):
            self.audit.record("auth.google", client, success=False, detail={"reason": "registration_closed"})
            self.db.commit()
            raise ServiceError(403, "目前未開放註冊，請聯絡管理員")
        self._acquire_write_lock(1001)
        user = self.users.get_by_email(norm_email)
        if user is not None:
            if not user.is_active:
                raise ServiceError(403, "此帳號已停用，請聯絡管理員")
            user.last_login_at = now
            user.last_seen_at = now
            tokens = self.issue_tokens(user, client)
            self.db.commit()
            return user, tokens
        role = ROLE_ADMIN if self.settings.first_user_admin and self.users.count() == 0 else ROLE_USER
        username = self._unique_google_username(norm_email)
        user = self.users.add(User(
            username=username, email=norm_email, password_hash=hash_password(secrets.token_urlsafe(32)),
            role=role, password_changed_at=None, last_login_at=now, last_seen_at=now,
        ))
        tokens = self.issue_tokens(user, client)
        self.audit.record("auth.google", client, user_id=user.id, detail={"action": "register", "role": role})
        self.db.commit()
        log.info("Google 註冊 id=%s email=%s role=%s", user.id, mask_email(user.email), role)
        return user, tokens

    def setup_profile(self, user: User, req: SetupProfileRequest, client: ClientInfo) -> User:
        """Google 註冊後初次補齊使用者名稱與密碼。"""
        if req.username != user.username and self.users.get_by_username(req.username) is not None:
            raise ServiceError(409, "此使用者名稱已被使用")
        now = utcnow()
        user.username = req.username
        user.password_hash = hash_password(req.password)
        user.password_changed_at = now
        self.audit.record("auth.setup_profile", client, user_id=user.id)
        self.db.commit()
        return user

    # ───── 登入 ─────
    def login(self, req: LoginRequest, client: ClientInfo) -> tuple[User, IssuedTokens]:
        now = utcnow()
        user = self.users.get_by_identifier(req.identifier)
        if user and user.locked_until and user.locked_until > now:
            minutes = max(1, int((user.locked_until - now).total_seconds() // 60) + 1)
            self.audit.record("auth.login_locked", client, success=False, user_id=user.id)
            self.db.commit()
            raise ServiceError(423, f"登入失敗次數過多，帳號已暫時鎖定，請於 {minutes} 分鐘後再試")

        ok = verify_password(req.password, user.password_hash if user else None)
        if not user or not ok:
            detail: dict[str, object] = {"reason": "bad_credentials"}
            if user:
                user.failed_login_count += 1
                if user.failed_login_count >= self.settings.lockout_threshold:
                    user.locked_until = now + timedelta(minutes=self.settings.lockout_minutes)
                    user.failed_login_count = 0
                    detail["locked"] = True
                    log.warning("帳號因連續登入失敗被鎖定 user_id=%s ip=%s", user.id, client.ip)
            self.audit.record("auth.login", client, success=False, user_id=user.id if user else None, detail=detail)
            self.db.commit()
            raise ServiceError(401, "帳號或密碼錯誤")

        if not user.is_active:
            self.audit.record("auth.login", client, success=False, user_id=user.id, detail={"reason": "frozen"})
            self.db.commit()
            raise ServiceError(403, "此帳號已被停用，請聯絡管理員")

        if user.totp_enabled:
            if not req.totp:
                # 密碼對了、但還要驗證碼：不算失敗、不加鎖定次數（前端會跳出輸入驗證碼的畫面）
                self.audit.record("auth.login_totp_required", client, user_id=user.id)
                self.db.commit()
                raise ServiceError(401, "請輸入雙因素驗證碼", headers={"X-Totp-Required": "1"})
            if not self._check_second_factor(user, req.totp):
                user.failed_login_count += 1
                detail2: dict[str, object] = {"reason": "bad_totp"}
                if user.failed_login_count >= self.settings.lockout_threshold:
                    user.locked_until = now + timedelta(minutes=self.settings.lockout_minutes)
                    user.failed_login_count = 0
                    detail2["locked"] = True
                self.audit.record("auth.login", client, success=False, user_id=user.id, detail=detail2)
                self.db.commit()
                raise ServiceError(401, "驗證碼錯誤或已使用過", headers={"X-Totp-Required": "1"})
        user.failed_login_count = 0
        user.locked_until = None
        user.last_login_at = now
        user.last_seen_at = now
        if needs_rehash(user.password_hash):
            user.password_hash = hash_password(req.password)
        tokens = self.issue_tokens(user, client)
        self.audit.record("auth.login", client, user_id=user.id)
        self.db.commit()
        return user, tokens

    # ───── 雙因素驗證（TOTP） ─────
    def _secret(self, user: User) -> str | None:
        try:
            return secretbox.open_(user.totp_secret)["s"] if user.totp_secret else None
        except (ValueError, KeyError):
            return None

    def _check_second_factor(self, user: User, code: str) -> bool:
        """6 位數驗證碼（同一個 30 秒週期不能用兩次），或一次性備援碼（用掉就作廢）。"""
        secret = self._secret(user)
        clean = code.strip().replace(" ", "")
        if secret and len(clean) == totp.DIGITS and clean.isdigit():
            self.db.refresh(user)
            step = totp.verify(secret, clean, last_step=user.totp_last_step)
            if step is not None:
                user.totp_last_step = step
                self.db.flush()
                return True
            return False
        norm = totp.normalize_recovery(code)
        self.db.refresh(user)
        hashes = [h for h in (user.totp_recovery or "").split(",") if h]
        if norm and totp.hash_recovery(norm) in hashes:
            hashes.remove(totp.hash_recovery(norm))
            user.totp_recovery = ",".join(hashes)
            self.db.flush()
            return True
        return False

    def totp_status(self, user: User) -> dict[str, object]:
        left = len([h for h in (user.totp_recovery or "").split(",") if h])
        return {"enabled": bool(user.totp_enabled), "recovery_left": left if user.totp_enabled else 0}

    def totp_setup(self, user: User, client: ClientInfo) -> dict[str, str]:
        if user.totp_enabled:
            raise ServiceError(409, "已經開啟雙因素驗證；要重新設定請先關閉")
        secret = totp.new_secret()
        user.totp_secret = secretbox.seal({"s": secret})
        user.totp_last_step = 0
        self.audit.record("auth.totp_setup", client, user_id=user.id)
        self.db.commit()
        return {"secret": secret, "uri": totp.otpauth_uri(secret, user.email)}

    def totp_enable(self, user: User, code: str, client: ClientInfo) -> list[str]:
        secret = self._secret(user)
        if user.totp_enabled or not secret:
            raise ServiceError(409, "請先按「開始設定」取得密鑰")
        step = totp.verify(secret, code, last_step=0)
        if step is None:
            self.audit.record("auth.totp_enable", client, success=False, user_id=user.id)
            self.db.commit()
            raise ServiceError(400, "驗證碼不正確：請確認手機時間正確，輸入驗證 App 上目前顯示的 6 位數")
        codes = totp.new_recovery_codes()
        user.totp_enabled = True
        user.totp_last_step = step
        user.totp_recovery = ",".join(totp.hash_recovery(c) for c in codes)
        self.audit.record("auth.totp_enable", client, user_id=user.id)
        self.db.commit()
        return codes

    def totp_disable(self, user: User, password: str, code: str, client: ClientInfo) -> None:
        if not user.totp_enabled:
            return
        if not verify_password(password, user.password_hash) or not self._check_second_factor(user, code):
            self.audit.record("auth.totp_disable", client, success=False, user_id=user.id)
            self.db.commit()
            raise ServiceError(400, "密碼或驗證碼不正確")
        user.totp_enabled = False
        user.totp_secret = None
        user.totp_recovery = ""
        user.totp_last_step = 0
        self.audit.record("auth.totp_disable", client, user_id=user.id)
        self.db.commit()

    # ───── 再確認身分／刪除帳號 ─────
    def confirm_identity(self, user: User, password: str, totp_code: str | None, client: ClientInfo, action: str) -> None:
        """密碼（有開雙因素驗證時再加驗證碼）都對才放行；錯誤不計入登入鎖定，但有頻率限制（在 API 層）。"""
        if not verify_password(password, user.password_hash):
            self.audit.record(action, client, success=False, user_id=user.id, detail={"reason": "bad_password"})
            self.db.commit()
            raise ServiceError(400, "密碼不正確")
        if user.totp_enabled:
            if not totp_code:
                raise ServiceError(401, "請輸入雙因素驗證碼", headers={"X-Totp-Required": "1"})
            if not self._check_second_factor(user, totp_code):
                self.audit.record(action, client, success=False, user_id=user.id, detail={"reason": "bad_totp"})
                self.db.commit()
                raise ServiceError(401, "驗證碼錯誤或已使用過", headers={"X-Totp-Required": "1"})

    def delete_account(self, user: User, password: str, totp_code: str | None, client: ClientInfo) -> None:
        """刪除帳號與伺服器上的全部資料（帳目同步資料、收件匣、推播、外部通知、AI 用量、登入紀錄）。審計日誌只留不含個資的紀錄。"""
        self.confirm_identity(user, password, totp_code, client, "auth.account_delete")
        if user.role == ROLE_ADMIN:
            self._acquire_write_lock(1002)
            if self.users.count_admins() <= 1:
                raise ServiceError(400, "你是唯一的管理員，請先建立另一位管理員，再刪除這個帳號")
        uid = user.id
        self.users.delete(user)  # 其他資料表以外鍵 ON DELETE CASCADE 一併刪除
        self.audit.record("auth.account_delete", client, user_id=uid)
        self.db.commit()
        log.info("使用者自行刪除帳號 id=%s", uid)

    # ───── 已登入的裝置 ─────
    def sessions(self, user: User, current_family: str | None) -> list[SessionOut]:
        now = utcnow()
        out: list[SessionOut] = []
        for row in self.tokens.active_for_user(user.id, now):
            out.append(SessionOut(id=row.family_id, created_at=self.tokens.family_started(row.family_id) or row.created_at, last_active=row.created_at,
                                  ip=row.ip, user_agent=row.user_agent, current=row.family_id == current_family))
        out.sort(key=lambda s: (not s.current, -s.last_active.timestamp()))
        return out

    def revoke_session(self, user: User, family_id: str, current_family: str | None, client: ClientInfo) -> None:
        if family_id == current_family:
            raise ServiceError(400, "這是目前使用的裝置，請用「登出」")
        if not self.tokens.family_owned_by(family_id, user.id):
            raise ServiceError(404, "找不到這個裝置（可能已經登出）")
        self.tokens.revoke_family(family_id, utcnow())
        self.audit.record("auth.session_revoke", client, user_id=user.id, detail={"family": family_id[:8]})
        self.db.commit()

    # ───── 刷新（輪替＋重用偵測） ─────
    def refresh(self, refresh_token: str | None, client: ClientInfo) -> tuple[User, IssuedTokens]:
        payload = decode_token(refresh_token or "", "refresh")
        if not payload:
            raise ServiceError(401, "登入已過期，請重新登入")
        now = utcnow()
        row = self.tokens.get(payload["jti"])
        if not row or str(row.user_id) != payload["sub"]:
            raise ServiceError(401, "登入已過期，請重新登入")
        if row.revoked_at:
            ua = (client.user_agent or "")[:512]
            same_device = (row.user_agent == ua) if (row.user_agent or ua) else (row.ip == client.ip)
            if row.replaced_by and now - row.revoked_at <= REFRESH_REUSE_GRACE and same_device:
                # 良性重複刷新（含行動網路切換 IP）：保留既有家族內的已發權杖，避免競態導致瀏覽器 Cookie 作廢
                pass
            else:
                self.tokens.revoke_family(row.family_id, now)
                self.audit.record("auth.refresh_reuse", client, success=False, user_id=row.user_id, detail={"family": row.family_id[:8]})
                self.db.commit()
                log.warning("偵測到 Refresh Token 重用，已撤銷整條權杖鏈 user_id=%s ip=%s", row.user_id, client.ip)
                raise ServiceError(401, "登入狀態異常，請重新登入")
        if row.expires_at <= now:
            raise ServiceError(401, "登入已過期，請重新登入")
        user = self.users.get(row.user_id)
        if not user or not user.is_active or payload.get("ver") != user.token_version:
            self.tokens.revoke_family(row.family_id, now)
            self.db.commit()
            raise ServiceError(401, "登入已失效，請重新登入")
        tokens = self.issue_tokens(user, client, family_id=row.family_id)
        row.revoked_at = now
        row.replaced_by = decode_token(tokens.refresh_token, "refresh")["jti"]  # type: ignore[index]
        user.last_seen_at = now
        self.db.commit()
        return user, tokens

    # ───── 登出 ─────
    def logout(self, refresh_token: str | None, user: User | None, client: ClientInfo, family_id: str | None = None) -> None:
        payload = decode_token(refresh_token or "", "refresh")
        fam = family_id
        if payload:
            row = self.tokens.get(payload["jti"])
            if row:
                fam = row.family_id
        if fam:
            self.tokens.revoke_family(fam, utcnow())
        self.audit.record("auth.logout", client, user_id=user.id if user else (int(payload["sub"]) if payload else None))
        self.db.commit()

    # ───── 變更密碼 ─────
    def change_password(self, user: User, req: ChangePasswordRequest, client: ClientInfo) -> IssuedTokens:
        # 有啟用雙因素驗證時，變更密碼亦須驗證 TOTP，防範 Session 被劫持時遭更換密碼
        self.confirm_identity(user, req.current_password, req.totp, client, "auth.password_change")
        if req.new_password == req.current_password:
            raise ServiceError(400, "新密碼不可與目前密碼相同")
        if req.new_password.lower() == user.username.lower():
            raise ServiceError(400, "密碼不可與使用者名稱相同")
        now = utcnow()
        user.password_hash = hash_password(req.new_password)
        user.password_changed_at = now
        user.must_change_password = False
        user.token_version += 1  # 其他裝置全部登出
        self.tokens.revoke_all_for_user(user.id, now)
        tokens = self.issue_tokens(user, client)  # 目前裝置保持登入
        self.audit.record("auth.password_change", client, user_id=user.id)
        self.db.commit()
        return tokens

    # ───── 忘記密碼 ─────
    @staticmethod
    def _hash_token(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def request_reset(self, identifier: str, client: ClientInfo) -> None:
        """寄重設連結。不論帳號存不存在都回一樣的結果（不洩漏哪些 Email 有註冊）；未設定寄信時才明確告知。"""
        if not mail_configured():
            raise ServiceError(503, "管理員尚未設定寄信功能，請聯絡管理員幫你重設密碼")
        if not self.settings.public_url:
            raise ServiceError(503, "管理員尚未設定網站網址（CLURE_PUBLIC_URL），請聯絡管理員幫你重設密碼")
        user = self.users.get_by_identifier(identifier)
        if not user or not user.is_active:
            self.audit.record("auth.reset_request", client, success=False, detail={"reason": "unknown_or_frozen"})
            self.db.commit()
            return
        now = utcnow()
        # 先作廢舊的未使用連結，同時間只有一條有效
        for old in self.db.scalars(select(PasswordReset).where(PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None))).all():
            old.used_at = now
        token = secrets.token_urlsafe(32)
        self.db.add(PasswordReset(user_id=user.id, token_hash=self._hash_token(token), expires_at=now + timedelta(minutes=self.settings.reset_token_minutes)))
        self.audit.record("auth.reset_request", client, user_id=user.id)
        self.db.commit()
        link = f"{self.settings.public_url.rstrip('/')}/reset-password?token={token}"
        mins = self.settings.reset_token_minutes
        body = (
            f"{user.username} 您好：\n\n"
            "我們收到您（或有人使用此帳號資訊）提出的密碼重設申請。請於瀏覽器開啟以下連結設定新的登入密碼：\n\n"
            f"{link}\n\n"
            f"安全提醒：\n"
            f"• 此重設連結將於 {mins} 分鐘後失效，且僅限使用一次。\n"
            "• 若您並未提出此申請，請直接忽略本信件，您的帳號與密碼將不會受到任何變更。\n\n"
            "——\n此為系統自動發送之通知信件，請勿直接回覆。"
        )
        email_html = self._render_email_html(
            eyebrow="帳號安全通知",
            heading="重設您的帳號密碼",
            greeting=f"{html.escape(user.username)} 您好：",
            lead="我們收到您（或有人使用此帳號資訊）提出的密碼重設申請。請點擊下方按鈕以設定新的登入密碼：",
            cta_label="重設密碼",
            cta_url=link,
            notes=[
                f"此重設連結將於 <strong>{mins} 分鐘</strong> 後失效，且<strong>僅限使用一次</strong>。",
                "若您並未提出此申請，請直接忽略本信件，您的帳號與密碼將不會受到任何變更。",
            ],
            fallback_url=link,
        )
        try:
            send_mail(user.email, "【Aster 記帳】重設您的帳號密碼", body, html=email_html)
        except MailError as e:
            log.warning("重設密碼信寄送失敗 user_id=%s：%s", user.id, e)
            raise ServiceError(502, "寄信失敗，請稍後再試或聯絡管理員") from e

    @staticmethod
    def _render_email_html(
        *,
        eyebrow: str,
        heading: str,
        greeting: str,
        lead: str,
        notes: list[str],
        cta_label: str | None = None,
        cta_url: str | None = None,
        fallback_url: str | None = None,
        code: str | None = None,
    ) -> str:
        cta_block = ""
        if cta_label and cta_url:
            safe_url = html.escape(cta_url, quote=True)
            cta_block = (
                '<div style="margin:24px 0;text-align:center;">'
                f'<a href="{safe_url}" style="display:inline-block;padding:12px 28px;border-radius:10px;'
                'background-color:#d4a853;color:#141414;font-weight:700;font-size:15px;'
                f'text-decoration:none;letter-spacing:0.5px;">{html.escape(cta_label)}</a>'
                "</div>"
            )
        code_block = ""
        if code:
            code_block = (
                '<div style="margin:22px 0;padding:16px;border-radius:10px;background-color:#f6f5f2;'
                'border:1px solid #e6e2d8;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;'
                f'font-size:28px;font-weight:700;letter-spacing:6px;color:#18181b;">{html.escape(code)}</div>'
            )
        fallback_block = ""
        if fallback_url:
            safe_fb = html.escape(fallback_url, quote=True)
            fallback_block = (
                '<p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#71717a;word-break:break-all;">'
                "如果上方按鈕無法點擊，請複製以下網址並貼至瀏覽器開啟：<br>"
                f'<a href="{safe_fb}" style="color:#8a6a24;">{safe_fb}</a>'
                "</p>"
            )
        note_items = "".join(f'<li style="margin:4px 0;">{n}</li>' for n in notes)
        return (
            "<!doctype html><html><body style=\"margin:0;padding:24px 12px;background-color:#f4f4f5;"
            "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans TC',sans-serif;color:#18181b;\">"
            '<div style="max-width:520px;margin:0 auto;background-color:#ffffff;border-radius:14px;'
            'border:1px solid #e4e4e7;padding:28px 24px;">'
            f'<div style="font-size:12px;font-weight:600;color:#8a6a24;letter-spacing:0.6px;">Aster 記帳 · {html.escape(eyebrow)}</div>'
            f'<h1 style="margin:8px 0 18px;font-size:20px;line-height:1.35;color:#18181b;">{html.escape(heading)}</h1>'
            f'<p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#27272a;">{greeting}</p>'
            f'<p style="margin:0 0 12px;font-size:15px;line-height:1.7;color:#27272a;">{lead}</p>'
            f"{cta_block}{code_block}"
            '<div style="margin:18px 0 0;padding:12px 14px;border-radius:10px;background-color:#fafafa;border:1px solid #f0f0f2;">'
            '<div style="font-size:12px;font-weight:700;color:#52525b;margin-bottom:4px;">安全提醒</div>'
            f'<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.6;color:#52525b;">{note_items}</ul>'
            "</div>"
            f"{fallback_block}"
            '<hr style="border:none;border-top:1px solid #f0f0f2;margin:22px 0 14px;">'
            '<p style="margin:0;font-size:12px;color:#a1a1aa;">此為系統自動發送之通知信件，請勿直接回覆。</p>'
            "</div></body></html>"
        )

    def reset_password(self, req: ResetPasswordRequest, client: ClientInfo) -> None:
        now = utcnow()
        row = self.db.scalar(select(PasswordReset).where(PasswordReset.token_hash == self._hash_token(req.token)))
        if not row or row.used_at or row.expires_at <= now:
            self.audit.record("auth.reset_password", client, success=False, user_id=row.user_id if row else None, detail={"reason": "invalid_token"})
            self.db.commit()
            raise ServiceError(400, "連結無效或已過期，請重新申請")
        user = self.users.get(row.user_id)
        if not user or not user.is_active:
            raise ServiceError(400, "連結無效或已過期，請重新申請")
        if req.new_password.lower() == user.username.lower():
            raise ServiceError(400, "密碼不可與使用者名稱相同")
        user.password_hash = hash_password(req.new_password)
        user.password_changed_at = now
        user.must_change_password = False
        user.locked_until = None
        user.failed_login_count = 0
        user.token_version += 1  # 所有裝置登出
        self.tokens.revoke_all_for_user(user.id, now)
        row.used_at = now
        self.audit.record("auth.reset_password", client, user_id=user.id)
        self.db.commit()
