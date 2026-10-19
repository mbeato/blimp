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

    static func load() -> ServerLink? {
        var query = item
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(ServerLink.self, from: data)
    }

    static func save(_ s: ServerLink) throws {
        let data = try JSONEncoder().encode(s)
        SecItemDelete(item as CFDictionary)
        var query = item
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    static func clear() {
        SecItemDelete(item as CFDictionary)
    }
}
