import AppIntents
import Foundation

@available(iOS 16.0, *)
enum AsterHookIntentError: LocalizedError {
    case notConfigured
    case invalidUrl
    case serverError(Int)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "請先開啟 Aster 記帳 App 並進入「自動記帳捷徑」完成裝置連結。"
        case .invalidUrl:
            return "Aster 伺服器網址格式無效。"
        case .serverError(let code):
            return "Aster 伺服器回應錯誤（HTTP \(code)）。"
        }
    }
}

/// iOS 16+ 原生 AppIntent：於背景直接將消費通知／Apple Pay 交易送入 Aster 收件匣（自動套用 Aster AppIcon）
@available(iOS 16.0, *)
struct AsterLogNotificationIntent: AppIntent {
    static var title: LocalizedStringResource = "記錄消費至 Aster"
    static var description = IntentDescription("將銀行通知或 Apple Pay 感應付款資訊直接送入 Aster 收件匣，不需開啟 App。")
    static var openAppWhenRun: Bool = false

    @Parameter(title: "來源", default: "notify")
    var source: String

    @Parameter(title: "通知內容")
    var text: String?

    @Parameter(title: "金額")
    var amount: String?

    @Parameter(title: "商家")
    var merchant: String?

    @Parameter(title: "卡片或 App")
    var card: String?

    func perform() async throws -> some IntentResult {
        guard let creds = AsterHookCredentialsStore.load() else {
            throw AsterHookIntentError.notConfigured
        }
        let endpoint = creds.hookUrl.hasSuffix("/api/hook/inbox")
            ? creds.hookUrl
            : "\(creds.hookUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")))/api/hook/inbox"
        guard let url = URL(string: endpoint) else {
            throw AsterHookIntentError.invalidUrl
        }

        let isoDate = ISO8601DateFormatter().string(from: Date())
        var payload: [String: String] = [
            "source": source.isEmpty ? "notify" : source,
            "date": isoDate,
            "source_event_id": "\(isoDate)-\(UUID().uuidString)",
        ]
        if let text, !text.isEmpty { payload["text"] = text }
        if let amount, !amount.isEmpty { payload["amount"] = amount }
        if let merchant, !merchant.isEmpty { payload["merchant"] = merchant }
        if let card, !card.isEmpty { payload["card"] = card }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(creds.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [])

        let (_, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw AsterHookIntentError.serverError(http.statusCode)
        }
        return .result()
    }
}
