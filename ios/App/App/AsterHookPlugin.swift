import Foundation
import Security
import Capacitor

/// 本機憑證儲存：將 Hook URL 存入 UserDefaults，將權杖存入 iOS Keychain（支援背景自動化讀取）
enum AsterHookCredentialsStore {
    private static let urlDefaultsKey = "aster.hook.url"
    private static let keychainService = "me.qiyen.aster.hook"
    private static let keychainAccount = "inboxToken"

    static func save(hookUrl: String, token: String) {
        UserDefaults.standard.set(hookUrl, forKey: urlDefaultsKey)
        guard let data = token.data(using: .utf8) else { return }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(attributes as CFDictionary, nil)
    }

    static func load() -> (hookUrl: String, token: String)? {
        guard let hookUrl = UserDefaults.standard.string(forKey: urlDefaultsKey),
              !hookUrl.isEmpty else {
            return nil
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let token = String(data: data, encoding: .utf8),
              !token.isEmpty else {
            return nil
        }
        return (hookUrl, token)
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: urlDefaultsKey)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

/// Capacitor 原生外掛：從 JS 端（ensureLink / forgetLink）同步 Hook 網址與權杖至 iOS 原生儲存
@objc(AsterHookPlugin)
public class AsterHookPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AsterHookPlugin"
    public let jsName = "AsterHook"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "syncCredentials", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearCredentials", returnType: CAPPluginReturnPromise),
    ]

    @objc func syncCredentials(_ call: CAPPluginCall) {
        guard let hookUrl = call.getString("hookUrl"), !hookUrl.isEmpty,
              let token = call.getString("token"), !token.isEmpty else {
            call.reject("缺少 hookUrl 或 token")
            return
        }
        AsterHookCredentialsStore.save(hookUrl: hookUrl, token: token)
        call.resolve()
    }

    @objc func clearCredentials(_ call: CAPPluginCall) {
        AsterHookCredentialsStore.clear()
        call.resolve()
    }
}
