"""收件匣：權杖建立／撤銷、捷徑送入（不需 CSRF）、列出與確認（不會重複刪）、權限隔離。"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app
from tests.conftest import Api


def _hook(token: str, body: dict, header: str = "bearer"):  # noqa: ANN202
    c = TestClient(app)  # 捷徑沒有 Cookie、也沒有 CSRF 標頭
    if header == "query":  # 匯入式捷徑：連結碼＝網址＋?t=權杖
        return c.post("/api/hook/inbox", params={"t": token}, json=body)
    h = {"Authorization": f"Bearer {token}"} if header == "bearer" else {"X-Aster-Token": token}
    return c.post("/api/hook/inbox", json=body, headers=h)


def test_token_create_list_revoke(api: Api) -> None:
    api.register("alice")
    r = api.post("/api/inbox/tokens", {"name": "我的 iPhone"})
    assert r.status_code == 201
    token = r.json()["token"]
    assert token.startswith("clr_") and r.json()["item"]["hint"] == token[-4:]
    listed = api.get("/api/inbox/tokens").json()
    assert len(listed) == 1 and "token" not in listed[0] and "token_hash" not in listed[0]
    assert api.c.delete(f"/api/inbox/tokens/{listed[0]['id']}", headers=api._h()).status_code == 200
    assert _hook(token, {"text": "午餐 120"}).status_code == 401


def test_hook_receive_list_and_ack(api: Api) -> None:
    api.register("alice")
    token = api.post("/api/inbox/tokens", {"name": "iPhone"}).json()["token"]
    r = _hook(token, {"source": "Apple Pay", "amount": "NT$1,234.00", "merchant": "全聯福利中心", "card": "玉山 Pi 卡", "date": "2026/10/28 12:30"})
    assert r.status_code == 200 and r.json()["ok"]
    assert _hook(token, {"source": "簡訊", "text": "您的玉山卡消費 NT$560"}, header="x").status_code == 200
    assert _hook(token, {"amount": 99, "extra_field": "ignored"}, header="query").status_code == 200
    assert _hook(token, {"source": "siri"}).status_code == 422  # 沒有內容
    tok = api.get("/api/inbox/tokens").json()[0]
    assert tok["use_count"] == 3 and tok["last_used_at"]  # 成功送進來三次（第四次 422 不算）
    items = api.get("/api/inbox/items").json()
    assert [i["source"] for i in items] == ["other", "sms", "applepay"]
    assert items[2]["amount"] == "NT$1,234.00" and items[2]["card"] == "玉山 Pi 卡" and items[0]["amount"] == "99"
    ids = [i["id"] for i in items]
    assert api.post("/api/inbox/items/ack", {"ids": ids[:2]}).json()["ids"] == sorted(ids[:2])
    # 另一台裝置再確認同一筆：已經不在了，不會回傳（避免重複記帳）
    assert api.post("/api/inbox/items/ack", {"ids": ids[:2]}).json()["ids"] == []
    assert len(api.get("/api/inbox/items").json()) == 1


def test_booking_shape_survives_ack_and_ids_are_not_reused(api: Api) -> None:
    api.register("alice")
    token = api.post("/api/inbox/tokens", {"name": "iPhone"}).json()["token"]
    _hook(token, {"text": "早餐 100"})
    item_id = api.get("/api/inbox/items").json()[0]["id"]
    body = {"id": item_id, "shape": ["transactions"]}
    assert api.post("/api/inbox/items/booking", body).status_code == 200
    assert len(api.get("/api/inbox/items").json()) == 1
    assert api.post("/api/inbox/items/booking", body).status_code == 200
    for shape in [["transfers"], ["transactions", "transactions"], ["transactions", "split:2"]]:
        assert api.post("/api/inbox/items/booking", {**body, "shape": shape}).status_code == 409
    api.post("/api/inbox/items/ack", {"ids": [item_id]})
    assert api.post("/api/inbox/items/booking", body).status_code == 200
    _hook(token, {"text": "午餐 100"})
    next_id = api.get("/api/inbox/items").json()[0]["id"]
    assert next_id > item_id
    api.post("/api/inbox/items/ack", {"ids": [next_id]})
    assert api.post("/api/inbox/items/booking", {"id": next_id, "shape": ["transactions"]}).status_code == 409
    assert api.post("/api/inbox/items/booking", {**body, "shape": ["invalid"]}).status_code == 422


def test_booking_isolates_users(admin_and_user) -> None:  # noqa: ANN001
    a, u = admin_and_user
    token = u.post("/api/inbox/tokens", {"name": "iPhone"}).json()["token"]
    _hook(token, {"text": "早餐 100"})
    item_id = u.get("/api/inbox/items").json()[0]["id"]
    body = {"id": item_id, "shape": ["transactions"]}
    assert a.post("/api/inbox/items/booking", body).status_code == 409
    assert u.post("/api/inbox/items/booking", body).status_code == 200
    assert a.post("/api/inbox/items/booking", body).status_code == 404


def test_hook_accepts_legacy_header(api: Api) -> None:
    api.register("alice")
    token = api.post("/api/inbox/tokens", {"name": "iPhone"}).json()["token"]
    # 更名為 Aster 前設定的捷徑用 X-Clure-Token
    assert TestClient(app).post("/api/hook/inbox", json={"text": "午餐 1"}, headers={"X-Clure-Token": token}).status_code == 200


def test_hook_notify_noise_filtering(api: Api) -> None:
    api.register("bob")
    token = api.post("/api/inbox/tokens", {"name": "iPhone"}).json()["token"]

    # 1. 真正的 App 交易通知：成功寫入
    r1 = _hook(token, {"source": "通知", "card": "國泰世華", "text": "您於 10/28 12:30 消費 NT$280，可用餘額 NT$50,000"})
    assert r1.status_code == 200 and r1.json()["message"] == "已送到 Aster，打開 App 確認記帳"

    r2 = _hook(token, {"source": "notify", "card": "LINE Pay", "text": "在 50嵐 付款 NT$65 完成"})
    assert r2.status_code == 200 and r2.json()["message"] == "已送到 Aster，打開 App 確認記帳"

    r_in = _hook(token, {"source": "notify", "card": "中國信託", "text": "跨行轉入 NT$30,000，跨行轉帳手續費 0 元，餘額 NT$85,000"})
    assert r_in.status_code == 200 and r_in.json()["message"] == "已送到 Aster，打開 App 確認記帳"

    r3 = _hook(token, {"source": "siri", "text": "早餐 65 現金"})
    assert r3.status_code == 200 and r3.json()["message"] == "已記進 Aster 收件匣：早餐 65 現金"

    # 2. 雜訊通知：回傳 200 但略過不寫入
    noise_samples = [
        "【玉山銀行】您的網路交易驗證碼(OTP)為 123456，請於2分鐘內輸入",
        "【國泰世華】您的網銀帳號於 11:20 登入成功，如非本人請洽客服",
        "【台新 Richart】信貸專案限時優惠利率 1.88% 起，立即登錄申請",
        "【台新銀行】跨行轉帳免收手續費優惠，立即查看",
        "今天晚上 7 點好樂迪包廂見喔！",  # 一般 LINE 聊天，無交易信號
    ]
    for noise in noise_samples:
        rn = _hook(token, {"source": "notify", "card": "銀行", "text": noise})
        assert rn.status_code == 200 and rn.json()["message"] == "已略過非消費通知"

    # 驗證收件匣只有那 4 筆真正交易
    items = api.get("/api/inbox/items").json()
    assert len(items) == 4
    assert items[0]["source"] == "siri" and items[0]["text"] == "早餐 65 現金"
    assert items[1]["source"] == "notify" and items[1]["card"] == "中國信託"
    assert items[2]["source"] == "notify" and items[2]["card"] == "LINE Pay"
    assert items[3]["source"] == "notify" and items[3]["card"] == "國泰世華"


def test_transaction_boilerplate_is_not_marketing_noise() -> None:
    from app.schema.inbox import HookItem
    from app.service.inbox_service import is_noise_notification

    for text in [
        "跨行轉入 NT$30000，本次免收手續費",
        "您於全聯消費 NT$280，電子帳單已寄送",
        "付款 120 元完成；立即登錄活動享抽獎",
        "中國信託：存款入帳通知 新臺幣 1,500 元",
    ]:
        assert not is_noise_notification(HookItem(source="notify", text=text))
    for text in [
        "本月跨行轉帳 5 次免收手續費",
        "電子帳單已產生，繳款提醒：應繳 NT$3000",
        "雙11購物節，刷卡滿 NT$1000 抽好禮",
        "網路消費 NT$120 驗證碼 123456",
    ]:
        assert is_noise_notification(HookItem(source="notify", text=text))


def test_hook_rejects_bad_token_and_isolates_users(admin_and_user) -> None:  # noqa: ANN001
    a, u = admin_and_user
    assert _hook("clr_wrong", {"text": "x 1"}).status_code == 401
    assert _hook("", {"text": "x 1"}).status_code == 401
    token = u.post("/api/inbox/tokens", {"name": "iPhone"}).json()["token"]
    _hook(token, {"text": "午餐 120"})
    assert len(u.get("/api/inbox/items").json()) == 1
    assert a.get("/api/inbox/items").json() == []
    item_id = u.get("/api/inbox/items").json()[0]["id"]
    assert a.post("/api/inbox/items/ack", {"ids": [item_id]}).json()["ids"] == []
    tid = u.get("/api/inbox/tokens").json()[0]["id"]
    assert a.c.delete(f"/api/inbox/tokens/{tid}", headers=a._h()).status_code == 404


def test_inbox_requires_login() -> None:
    c = TestClient(app)
    assert c.get("/api/inbox/items").status_code == 401
    assert c.get("/api/inbox/tokens").status_code == 401


def test_hook_pushes_to_subscribed_devices(api: Api, monkeypatch) -> None:  # noqa: ANN001
    """捷徑送進收件匣時立即推播：有訂閱才送、雜訊不送、推播失敗不影響收件；內容不含金額與商家。"""
    from app.core import webpush
    from tests.test_push_e2ee import _sub_body

    api.register("alice")
    token = api.post("/api/inbox/tokens", {"name": "iPhone"}).json()["token"]
    assert api.post("/api/push/subscribe", _sub_body()).status_code == 200

    sent: list[dict] = []
    monkeypatch.setattr(webpush, "send", lambda endpoint, p, a, msg, **kw: (sent.append(msg), webpush.SendResult(True, 201, False))[1])
    r = _hook(token, {"source": "Apple Pay", "amount": "NT$120", "merchant": "全聯"})
    assert r.status_code == 200 and r.json()["ok"]
    assert len(sent) == 1
    assert sent[0]["title"] == "📥 收件匣有新項目" and sent[0]["url"] == "/inbox"
    assert sent[0]["tag"].startswith("inbox:") and sent[0]["db"].startswith("clure-u")
    assert "120" not in sent[0]["body"] and "全聯" not in sent[0]["body"]

    # 雜訊通知不寫入，也不推播
    rn = _hook(token, {"source": "notify", "text": "【玉山銀行】您的網路交易驗證碼(OTP)為 123456，請於2分鐘內輸入"})
    assert rn.json()["message"] == "已略過非消費通知"
    assert len(sent) == 1

    # 推播服務掛了：收件照常，項目仍進收件匣
    def boom(*a, **kw):  # noqa: ANN002, ANN003, ANN202
        raise RuntimeError("push service down")

    monkeypatch.setattr(webpush, "send", boom)
    r2 = _hook(token, {"text": "晚餐 80"})
    assert r2.status_code == 200 and r2.json()["ok"]
    assert len(api.get("/api/inbox/items").json()) == 2

    # 單純寫「存入」的通知（無 NT$ 與「入帳」字眼）也不應被誤判為雜訊
    r5 = _hook(token, {"source": "notify", "text": "玉山銀行 帳戶*1234 存入 30,000元"})
    assert r5.status_code == 200 and r5.json()["ok"]
    assert r5.json().get("message") != "已略過非消費通知"
    assert len(api.get("/api/inbox/items").json()) == 3


def test_hook_errors_always_include_message(api: Api) -> None:
    """iPhone 捷徑統一讀取 JSON `message`：驗證 /api/hook/* 的 401/422 錯誤也回傳 message。"""
    api.register("alice")
    token = api.post("/api/inbox/tokens", {"name": "iPhone"}).json()["token"]

    bad_tok = _hook("clr_wrong", {"text": "午餐 100"})
    assert bad_tok.status_code == 401
    bad_body = bad_tok.json()
    assert bad_body["detail"] and bad_body["message"] == bad_body["detail"]

    empty_payload = _hook(token, {"source": "siri"})
    assert empty_payload.status_code == 422
    empty_body = empty_payload.json()
    assert empty_body["detail"] and empty_body["message"] == empty_body["detail"]


def test_applepay_card_only_and_hook_idempotency(api: Api) -> None:
    api.register("alice")
    token = api.post("/api/inbox/tokens", {"name": "iPhone"}).json()["token"]

    # Apple Pay 只有 card（沒有 amount 與 merchant）也應受理且不被當噪音
    r_ap = _hook(token, {
        "source": "applepay",
        "card": "玉山 Pi 卡",
        "currency": "TWD",
        "source_event_id": "ap-evt-001",
        "event_at": "2026-11-27T10:00:00+08:00",
    })
    assert r_ap.status_code == 200 and r_ap.json()["ok"]

    # 同一 source_event_id 重送（項目尚在收件匣中）：不重複建立
    r_dup1 = _hook(token, {
        "source": "applepay",
        "card": "玉山 Pi 卡",
        "source_event_id": "ap-evt-001",
    })
    assert r_dup1.status_code == 200
    items = api.get("/api/inbox/items").json()
    assert len(items) == 1
    assert items[0]["currency"] == "TWD"
    assert items[0]["source_event_id"] == "ap-evt-001"
    assert items[0]["event_at"] == "2026-11-27T10:00:00+08:00"

    # ack 刪除後，同一 source_event_id 重送仍不應重複建立
    assert api.post("/api/inbox/items/ack", {"ids": [items[0]["id"]]}).json()["ids"] == [items[0]["id"]]
    r_dup2 = _hook(token, {
        "source": "applepay",
        "card": "玉山 Pi 卡",
        "source_event_id": "ap-evt-001",
    })
    assert r_dup2.status_code == 200
    assert api.get("/api/inbox/items").json() == []

    # 無 source_event_id 的短時間重複重試也不應重複建立
    assert _hook(token, {"source": "siri", "text": "咖啡 85"}).status_code == 200
    assert _hook(token, {"source": "siri", "text": "咖啡 85"}).status_code == 200
    assert len(api.get("/api/inbox/items").json()) == 1


def test_receive_purges_expired_before_cap_and_reports_purged_header(api: Api) -> None:
    from datetime import timedelta
    from sqlalchemy import select
    from app.core.security import utcnow
    from app.db import session_scope
    from app.model import InboxItem, User
    from app.service.inbox_service import MAX_PENDING

    api.register("alice")
    token = api.post("/api/inbox/tokens", {"name": "iPhone"}).json()["token"]

    old_time = utcnow() - timedelta(days=31)
    for db in session_scope():
        user = db.scalar(select(User).where(User.username == "alice"))
        assert user is not None
        for i in range(MAX_PENDING):
            db.add(InboxItem(
                user_id=user.id,
                source="siri",
                text=f"舊項目 {i}",
                created_at=old_time,
            ))

    # 雖然原本有 500 筆，但全部已超過 30 天，receive() 應先清除過期項目而不回 429
    r = _hook(token, {"source": "siri", "text": "新項目 100"})
    assert r.status_code == 200
    items_res = api.get("/api/inbox/items")
    assert items_res.status_code == 200
    assert len(items_res.json()) == 1
    assert items_res.json()[0]["text"] == "新項目 100"

    # 若在 items() 時有過期項目被清除，應回傳 X-Inbox-Purged-Count 標頭
    for db in session_scope():
        user = db.scalar(select(User).where(User.username == "alice"))
        assert user is not None
        db.add(InboxItem(user_id=user.id, source="siri", text="另一筆過期", created_at=old_time))
    res2 = api.get("/api/inbox/items")
    assert res2.status_code == 200
    assert res2.headers.get("X-Inbox-Purged-Count") == "1"
    assert len(res2.json()) == 1
