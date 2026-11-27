#!/usr/bin/env python3
"""產生並簽署兩個可匯入 iPhone 捷徑，輸出到 public/shortcuts/。

- Aster 自動記帳：內建台灣主流銀行 App、LINE Pay、街口、錢包與訊息等通知自動化觸發器，收到消費通知後自動送出
- Aster Apple Pay 記帳：錢包交易自動化觸發器（WFWalletTransactionTrigger），感應付款後自動送出

捷徑裡不含任何網址或權杖：匯入時只問一題「貼上連結碼」（App 會先複製到剪貼簿），
連結碼就是 https://你的網址/api/hook/inbox?t=clr_… 。所以同一組檔案每位使用者都能用。

簽署需要 macOS 的 shortcuts 指令（--mode anyone 會連到 Apple 簽署，需登入 Apple ID）：
    python3 scripts/make-shortcuts.py
"""
from __future__ import annotations

import plistlib
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "shortcuts"
OBJ = "￼"  # 文字中變數的位置

# 預先內建於「Aster 自動記帳」通知自動化觸發器（WFNotificationTrigger）的系統通知、行動支付與台灣主流銀行 App
NOTIFY_APPS = [
    # 系統通知（簡訊／錢包）
    {"BundleIdentifier": "com.apple.MobileSMS", "Name": "訊息"},
    {"BundleIdentifier": "com.apple.Passbook", "Name": "錢包"},
    # 行動支付／掃碼付款
    {"BundleIdentifier": "com.linepaytw.upay", "Name": "LINE Pay"},
    {"BundleIdentifier": "jp.naver.line", "Name": "LINE"},
    {"BundleIdentifier": "com.jkos.JKOS", "Name": "街口支付"},
    {"BundleIdentifier": "com.pxpayplus.app", "Name": "全支付"},
    {"BundleIdentifier": "com.ipass.ipassmoney", "Name": "iPASS MONEY"},
    {"BundleIdentifier": "tw.com.easycard.easycardwallet", "Name": "Easy Wallet"},
    {"BundleIdentifier": "tw.com.icash.i.icashpay", "Name": "icash Pay"},
    {"BundleIdentifier": "tw.com.openpoint.member", "Name": "OPENPOINT"},
    {"BundleIdentifier": "com.etmgup.pxmart", "Name": "全聯福利中心"},
    {"BundleIdentifier": "tw.com.twmp.twhcewallet", "Name": "台灣行動支付"},
    {"BundleIdentifier": "tw.com.allpay.app.AllPay", "Name": "歐付寶"},
    {"BundleIdentifier": "com.gashpay.personal", "Name": "橘子支付"},
    {"BundleIdentifier": "com.pay2go.Pay2Go", "Name": "ezPay簡單付"},
    # 銀行與信用卡 App（刷實體卡／網購／綁定支付）
    {"BundleIdentifier": "com.cathaybk.cathaybk", "Name": "國泰世華"},
    {"BundleIdentifier": "com.cathayholdings.mymobione", "Name": "國泰優惠"},
    {"BundleIdentifier": "com.chinatrust.mobilebank", "Name": "中國信託"},
    {"BundleIdentifier": "tw.com.esunbank.app.esunwallet", "Name": "玉山 Wallet"},
    {"BundleIdentifier": "tw.com.ESunbank.mobilebanking.release", "Name": "玉山行動銀行"},
    {"BundleIdentifier": "tw.com.taishinbank.richart", "Name": "Richart"},
    {"BundleIdentifier": "tw.com.taishinbank.cardaily", "Name": "Richart Life"},
    {"BundleIdentifier": "tw.com.taishinbank.mobile", "Name": "台新銀行"},
    {"BundleIdentifier": "com.fubon.aibank", "Name": "台北富邦 Fubon+"},
    {"BundleIdentifier": "tw.com.mma.xphone", "Name": "永豐行動銀行"},
    {"BundleIdentifier": "com.sinopac.dawho", "Name": "永豐 DAWHO"},
    {"BundleIdentifier": "com.linebank.tw", "Name": "LINE Bank"},
    {"BundleIdentifier": "com.nextbank.ncbportal", "Name": "將來銀行 NextBank"},
    {"BundleIdentifier": "com.firstbank.mbank", "Name": "第一銀行 第e行動"},
    {"BundleIdentifier": "com.firstbank.mBankForLite", "Name": "第一銀行 iLEO"},
    {"BundleIdentifier": "tw.com.megabank.mobilebank.pre", "Name": "兆豐銀行"},
    {"BundleIdentifier": "tw.com.hncb.NMBank", "Name": "華南銀行+"},
    {"BundleIdentifier": "com.bot.ibank.p", "Name": "臺銀行動+"},
    {"BundleIdentifier": "tw.com.tcb-bank.mbbank.released", "Name": "合作金庫"},
    {"BundleIdentifier": "tw.gov.post.mpost", "Name": "行動郵局"},
    {"BundleIdentifier": "com.obank.tw.ebank", "Name": "王道銀行 O-Bank"},
    {"BundleIdentifier": "com.ubot.wbank", "Name": "聯邦行動銀行"},
    {"BundleIdentifier": "com.ubot.dbank", "Name": "New New Bank"},
    {"BundleIdentifier": "com.kgib.maib.prod", "Name": "凱基銀行"},
    {"BundleIdentifier": "com.yuantabank.bankinginyour.superapp.personal", "Name": "元大行動銀行"},
    {"BundleIdentifier": "com.skbank.iphone.skbank", "Name": "新光銀行"},
    {"BundleIdentifier": "tw.com.scsb.ios.mbank", "Name": "上海商銀掌上銀"},
    {"BundleIdentifier": "tw.com.landbank.mb.newrelease", "Name": "土銀行動銀行"},
    {"BundleIdentifier": "com.chb.mobile.pmb", "Name": "彰銀行動網"},
    {"BundleIdentifier": "com.ricb.ebank", "Name": "樂天國際銀行"},
    {"BundleIdentifier": "tw.com.rakuten.card.RakutenCardTaiwan", "Name": "樂天信用卡"},
    {"BundleIdentifier": "com.sunnybank.newmobilebankios", "Name": "陽信行動網銀"},
    {"BundleIdentifier": "tw.com.tcbbank.mobilebank", "Name": "台中銀行"},
    {"BundleIdentifier": "com.cotabank.CotaEBank", "Name": "三信商銀"},
    {"BundleIdentifier": "com.feib.mobile.pmb", "Name": "遠東商銀"},
    {"BundleIdentifier": "com.dbs.mbanking.tw", "Name": "星展 digibank"},
    {"BundleIdentifier": "com.dbs.cardplus.tw", "Name": "星展 Card+"},
    {"BundleIdentifier": "tw.com.hsbc.hsbctaiwan", "Name": "滙豐台灣"},
    {"BundleIdentifier": "tw.com.SCBreeze", "Name": "渣打行動銀行"},
]


def text(s: str) -> dict:
    return {"Value": {"string": s, "attachmentsByRange": {}}, "WFSerializationType": "WFTextTokenString"}


def var_text(attachment: dict) -> dict:
    """整段文字就是一個變數"""
    return {"Value": {"string": OBJ, "attachmentsByRange": {"{0, 1}": attachment}}, "WFSerializationType": "WFTextTokenString"}


def multi_var_text(attachments: list[dict], sep: str = "\n") -> dict:
    """多個變數以分隔符串接成一段文字"""
    s = sep.join(OBJ for _ in attachments)
    step = len(sep) + 1
    ranges = {f"{{{i * step}, 1}}": att for i, att in enumerate(attachments)}
    return {"Value": {"string": s, "attachmentsByRange": ranges}, "WFSerializationType": "WFTextTokenString"}


def variable(att: dict) -> dict:
    """捷徑動作的變數參數包裝（如 Conditional WFInput）"""
    return {"Type": "Variable", "Variable": {"Value": att, "WFSerializationType": "WFTextTokenAttachment"}}


def output(uid: str, name: str) -> dict:
    return {"Type": "ActionOutput", "OutputUUID": uid, "OutputName": name}


def shortcut_input(prop: str | None = None) -> dict:
    a: dict = {"Type": "ExtensionInput"}
    if prop:
        a["Aggrandizements"] = [{"Type": "WFPropertyVariableAggrandizement", "PropertyName": prop}]
    return a


def current_date_iso() -> dict:
    return {
        "Type": "CurrentDate",
        "Aggrandizements": [{
            "Type": "WFDateFormatVariableAggrandizement",
            "WFDateFormatStyle": "ISO 8601",
            "WFISO8601IncludeTime": True,
        }],
    }


def field(key: str, value: dict) -> dict:
    return {"WFItemType": 0, "WFKey": text(key), "WFValue": value}


def dict_value(items: list[dict]) -> dict:
    return {"Value": {"WFDictionaryFieldValueItems": items}, "WFSerializationType": "WFDictionaryFieldValue"}


def _show_hook_message(req_id: str) -> list[dict]:
    """安全解析捷徑 HTTP 回應：先轉純文字再檢查是否為 JSON 物件，避免伺服器或代理回傳 HTML（RTF）時在「取得辭典值」崩潰。"""
    resp_text_id, cond_id, msg_id = (str(uuid.uuid4()).upper() for _ in range(3))
    return [
        {"WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
         "WFWorkflowActionParameters": {
             "UUID": resp_text_id,
             "WFTextActionText": var_text(output(req_id, "URL 的內容")),
         }},
        {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
         "WFWorkflowActionParameters": {
             "GroupingIdentifier": cond_id,
             "WFCondition": 8,  # Begins With
             "WFConditionalActionString": "{",
             "WFControlFlowMode": 0,
             "WFInput": variable(output(resp_text_id, "文字")),
         }},
        {"WFWorkflowActionIdentifier": "is.workflow.actions.getvalueforkey",
         "WFWorkflowActionParameters": {
             "UUID": msg_id,
             "WFDictionaryKey": "message",
             "WFInput": {"Value": output(resp_text_id, "文字"), "WFSerializationType": "WFTextTokenAttachment"},
         }},
        {"WFWorkflowActionIdentifier": "is.workflow.actions.showresult",
         "WFWorkflowActionParameters": {"Text": var_text(output(msg_id, "字典值"))}},
        {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
         "WFWorkflowActionParameters": {
             "GroupingIdentifier": cond_id,
             "WFControlFlowMode": 1,
         }},
        {"WFWorkflowActionIdentifier": "is.workflow.actions.showresult",
         "WFWorkflowActionParameters": {
             "Text": text("無法連線到 Aster 伺服器，請確認連結碼與網路是否正常"),
         }},
        {"WFWorkflowActionIdentifier": "is.workflow.actions.conditional",
         "WFWorkflowActionParameters": {
             "UUID": cond_id,
             "GroupingIdentifier": cond_id,
             "WFControlFlowMode": 2,
         }},
    ]


def build(
    body: list[dict],
    extra_actions: list[dict] | None = None,
    speak_result: bool = False,
    before: list[dict] | None = None,
    types: list[str] | None = None,
    triggers: list[dict] | None = None,
) -> dict:
    """連結碼（匯入時填）→ 其他前置動作 → POST JSON → （Siri）唸出伺服器回覆"""
    code_id, req_id = (str(uuid.uuid4()).upper() for _ in range(2))
    actions = [
        {"WFWorkflowActionIdentifier": "is.workflow.actions.gettext",
         "WFWorkflowActionParameters": {"UUID": code_id, "WFTextActionText": text("")}},
        *(before or []),
        {"WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl",
         "WFWorkflowActionParameters": {
             "UUID": req_id,
             "WFURL": var_text(output(code_id, "文字")),
             "WFHTTPMethod": "POST",
             "ShowHeaders": True,
             "WFHTTPHeaders": dict_value([
                 field("Content-Type", text("application/json")),
                 field("Accept", text("application/json")),
                 field("Connection", text("close")),
             ]),
             "WFHTTPBodyType": "JSON",
             "WFJSONValues": dict_value(body),
         }},
    ]
    if speak_result:
        actions += _show_hook_message(req_id)
    actions += extra_actions or []
    wf: dict = {
        "WFWorkflowClientVersion": "2607.0.1",
        "WFWorkflowMinimumClientVersion": 900,
        "WFWorkflowMinimumClientVersionString": "900",
        "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59446},
        "WFWorkflowTypes": types or [],
        "WFWorkflowHasShortcutInputVariables": True,
        "WFWorkflowInputContentItemClasses": [
            "WFAppContentItem", "WFArticleContentItem", "WFContactContentItem", "WFDateContentItem", "WFEmailAddressContentItem",
            "WFFolderContentItem", "WFGenericFileContentItem", "WFImageContentItem", "WFiTunesProductContentItem", "WFLocationContentItem",
            "WFDCMapsLinkContentItem", "WFAVAssetContentItem", "WFPDFContentItem", "WFPhoneNumberContentItem", "WFRichTextContentItem",
            "WFSafariWebPageContentItem", "WFStringContentItem", "WFURLContentItem", "WFDictionaryContentItem", "WFNumberContentItem",
        ],
        "WFWorkflowOutputContentItemClasses": [],
        "WFWorkflowActions": actions,
        "WFWorkflowImportQuestions": [{
            "ActionIndex": 0, "Category": "Parameter", "ParameterKey": "WFTextActionText", "DefaultValue": "",
            "Text": "貼上 Aster 的連結碼（在 App 按「加入捷徑」時已自動複製，長按這裡選「貼上」）",
        }],
    }
    if triggers:
        wf["WFWorkflowTriggers"] = triggers
    return wf


def auto() -> dict:
    """Aster 自動記帳：合併銀行／行動支付／簡訊通知與 Apple Pay 錢包交易雙觸發器"""
    rand_id = str(uuid.uuid4()).upper()
    return build(
        [
            field("source", text("notify")),
            field("amount", var_text(shortcut_input("Amount"))),
            field("merchant", var_text(shortcut_input("Merchant"))),
            field("card", multi_var_text([shortcut_input("Card or Pass"), shortcut_input("App")])),
            field("text", multi_var_text([shortcut_input("Title"), shortcut_input("Subtitle"), shortcut_input()])),
            field("date", var_text(current_date_iso())),
            field("source_event_id", multi_var_text([current_date_iso(), output(rand_id, "隨機數字")], "-")),
        ],
        before=[
            {"WFWorkflowActionIdentifier": "is.workflow.actions.delay",
             "WFWorkflowActionParameters": {"WFDelayTime": 1}},
            {"WFWorkflowActionIdentifier": "is.workflow.actions.number.random",
             "WFWorkflowActionParameters": {"UUID": rand_id, "WFRandomNumberMinimum": 100000, "WFRandomNumberMaximum": 999999}},
        ],
        triggers=[
            {
                "WFTriggerIdentifier": "WFNotificationTrigger",
                "WFTriggerUUID": str(uuid.uuid4()).upper(),
                "WFTriggerSerializedParameters": {
                    "SelectedApps": NOTIFY_APPS,
                },
            },
            {
                "WFTriggerIdentifier": "WFWalletTransactionTrigger",
                "WFTriggerUUID": str(uuid.uuid4()).upper(),
                "WFTriggerSerializedParameters": {},
            },
        ],
    )


SHORTCUTS: dict[str, tuple[str, object]] = {
    "aster-auto": ("Aster 自動記帳", auto),
}


def extract_icloud_id(signed_bytes: bytes) -> str | None:
    m = re.search(b"[0-9a-f]{32}", signed_bytes[:8192])
    return m.group(0).decode("ascii") if m else None


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    unsigned_only = "--unsigned" in sys.argv
    only = {f"aster-{k.strip()}" for k in sys.argv[sys.argv.index("--only") + 1].split(",")} if "--only" in sys.argv else None
    with tempfile.TemporaryDirectory() as tmp:
        for name, (display_name, fn) in SHORTCUTS.items():
            if only is not None and name not in only:
                continue
            raw = Path(tmp) / f"{display_name}.shortcut"
            raw.write_bytes(plistlib.dumps(fn(), fmt=plistlib.FMT_BINARY))  # type: ignore[operator]
            dest = OUT / f"{name}.shortcut"
            if unsigned_only:
                dest.write_bytes(raw.read_bytes())
                dest.chmod(0o644)
                print(f"未簽署：{dest}")
                continue
            r = subprocess.run(["shortcuts", "sign", "--mode", "anyone", "--input", str(raw), "--output", str(dest)], capture_output=True, text=True)
            if r.returncode != 0 or not dest.exists():
                print(f"簽署失敗：{name}\n{r.stderr or r.stdout}", file=sys.stderr)
                return 1
            dest.chmod(0o644)
            icloud_id = extract_icloud_id(dest.read_bytes())
            print(f"已簽署：{dest}（{dest.stat().st_size} bytes） icloud={icloud_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
