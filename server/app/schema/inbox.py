"""收件匣的請求／回應模型。"""
from __future__ import annotations

from datetime import datetime
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SOURCES = ("applepay", "notify", "sms", "siri", "clipboard", "share", "quick", "email", "other")
SOURCE_ALIASES = {
    "apple_pay": "applepay", "wallet": "applepay", "錢包": "applepay",
    "notification": "notify", "通知": "notify", "app": "notify",
    "message": "sms", "簡訊": "sms", "語音": "siri", "mail": "email", "剪貼簿": "clipboard", "分享": "share", "快速": "quick",
    "auto": "notify", "自動": "notify", "voice": "siri", "隨手記": "siri",
}


def _clip(v: object, n: int) -> str:
    """捷徑送來的值可能是數字、空值或很長的文字：一律轉成去頭尾空白的字串並截斷"""
    if v is None:
        return ""
    return str(v).strip()[:n]


def _clip_opt(v: object, n: int) -> str | None:
    s = _clip(v, n)
    return s or None


class HookItem(BaseModel):
    """iPhone 捷徑送進收件匣的內容；欄位都可以省略，但至少要有文字或金額。"""

    model_config = ConfigDict(extra="ignore")

    source: str = "other"
    text: str = ""
    amount: str = ""
    merchant: str = ""
    card: str = ""
    date: str = ""
    currency: str | None = None
    source_event_id: str | None = None
    event_at: str | None = None

    @field_validator("source", mode="before")
    @classmethod
    def _source(cls, v: object) -> str:
        s = _clip(v, 16).lower().replace(" ", "")
        s = SOURCE_ALIASES.get(s, s)
        return s if s in SOURCES else "other"

    @field_validator("text", mode="before")
    @classmethod
    def _text(cls, v: object) -> str:
        return _clip(v, 1000)

    @field_validator("amount", "date", mode="before")
    @classmethod
    def _short(cls, v: object) -> str:
        return _clip(v, 40)

    @field_validator("merchant", mode="before")
    @classmethod
    def _merchant(cls, v: object) -> str:
        return _clip(v, 120)

    @field_validator("card", mode="before")
    @classmethod
    def _card(cls, v: object) -> str:
        return _clip(v, 80)

    @field_validator("currency", mode="before")
    @classmethod
    def _currency(cls, v: object) -> str | None:
        return _clip_opt(v, 16)

    @field_validator("source_event_id", mode="before")
    @classmethod
    def _source_event_id(cls, v: object) -> str | None:
        return _clip_opt(v, 128)

    @field_validator("event_at", mode="before")
    @classmethod
    def _event_at(cls, v: object) -> str | None:
        return _clip_opt(v, 64)

    @model_validator(mode="after")
    def _not_empty(self) -> HookItem:
        if not (self.text or self.amount or self.merchant or (self.source in ("applepay", "notify") and self.card)):
            raise ValueError("內容是空的：請至少傳送文字或金額")
        return self


class HookResult(BaseModel):
    ok: bool = True
    message: str


class TokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class TokenOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    hint: str
    created_at: datetime
    last_used_at: datetime | None
    use_count: int = 0


class TokenCreated(BaseModel):
    """權杖原文只在建立時回傳這一次"""

    token: str
    item: TokenOut


class InboxItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source: str
    text: str
    amount: str
    merchant: str
    card: str
    occurred: str
    currency: str | None = None
    source_event_id: str | None = None
    event_at: str | None = None
    created_at: datetime


class BookingRequest(BaseModel):
    id: int = Field(gt=0)
    shape: list[str] = Field(min_length=1, max_length=100)

    @field_validator("shape")
    @classmethod
    def _shape(cls, values: list[str]) -> list[str]:
        import re
        if any(not re.fullmatch(r"transactions|transfers|debts|durable|split:[1-9][0-9]?", value) for value in values):
            raise ValueError("記帳來源結構不正確")
        return values


class AckRequest(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=200)


class AckResult(BaseModel):
    """實際刪除的項目；另一台裝置已處理過的不會出現在這裡（避免重複記帳）"""

    ids: list[int]


_SIMPLE_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class EmailForwardSetup(BaseModel):
    source_email: str = Field(min_length=3, max_length=254)

    @field_validator("source_email", mode="before")
    @classmethod
    def _validate_email(cls, v: object) -> str:
        s = _clip(v, 254).lower()
        if not _SIMPLE_EMAIL_RE.fullmatch(s):
            raise ValueError("請輸入有效的 Email 位址")
        return s


class EmailForwardBindingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    source_email: str
    forward_address: str
    status: Literal["pending_verify", "verified"]
    verify_url: str | None = None
    verify_code: str | None = None
    verify_received_at: datetime | None = None
    last_received_at: datetime | None = None
    received_count: int = 0
    created_at: datetime
    updated_at: datetime


class EmailForwardHookIn(BaseModel):
    """Cloudflare Email Worker 送來的轉寄郵件內容。"""

    model_config = ConfigDict(extra="ignore")

    to: str = Field(min_length=3, max_length=320)
    from_addr: str = Field(default="", max_length=320)
    subject: str = Field(default="", max_length=300)
    text: str = Field(default="", max_length=12000)
    message_id: str | None = Field(default=None, max_length=300)

    @field_validator("to", "from_addr", "subject", "text", mode="before")
    @classmethod
    def _coerce_str(cls, v: object) -> str:
        if v is None:
            return ""
        return str(v)

    @field_validator("message_id", mode="before")
    @classmethod
    def _coerce_msg_id(cls, v: object) -> str | None:
        return _clip_opt(v, 300)
