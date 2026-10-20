// The paired server (its URL and token) is kept only here: one generic-password item,
// this device only, readable while the phone is unlocked.
import BlimpKit
import Foundation
import Security

struct KeychainError: Error { let status: OSStatus }

enum Keychain {
    // computed, not a stored static: a [String: Any] isn't Sendable
    private static var item: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "dev.blimp.phone",
         kSecAttrAccount as String: "server"]
    }

    enum Saved { case server(ServerLink), none, unreadable }

    /// `unreadable` isn't "not paired": iOS can start the app before the phone is unlocked (after an
    /// update, or to prewarm it), and the item can only be read while it's unlocked.
    static func load() -> Saved {
        var query = item
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        switch SecItemCopyMatching(query as CFDictionary, &out) {
        case errSecSuccess:
            guard let data = out as? Data, let link = try? JSONDecoder().decode(ServerLink.self, from: data) else { return .none }
            return .server(link)
        case errSecItemNotFound:
            return .none
        default:
            return .unreadable
        }
    }

    /// Updates the saved item, and adds it only when there is none: never delete first, so a
    /// failed add can't lose the server that was saved.
    static func save(_ s: ServerLink) throws {
        let data = try JSONEncoder().encode(s)
        var status = SecItemUpdate(item as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var query = item
            query[kSecValueData as String] = data
            query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            status = SecItemAdd(query as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    static func clear() {
        SecItemDelete(item as CFDictionary)
    }
}
