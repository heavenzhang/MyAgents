import Foundation
import Security
import CryptoKit

/// Native-only records; neither keys nor pending request bodies cross the JS bridge.
/// ThisDeviceOnly prevents migration to a different device through cloud backup.
final class SecureRecords {
  private let service: String
  private let limit = 256 * 1024

  init(bundle: String) { service = bundle + ".remote.records.v1" }

  private func query(_ scope: String, _ record: String) -> [String: Any] {
    let account = SHA256.hash(data: Data((scope + "\u{0}" + record).utf8))
      .map { String(format: "%02x", $0) }.joined()
    return [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false]
  }

  func read(scope: String, record: String) throws -> Data? {
    var q = query(scope, record)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let bytes = result as? Data, bytes.count <= limit else {
      throw NativeFailure("MOBILE_SECURE_STORE_UNAVAILABLE")
    }
    return bytes
  }

  /// SecItemAdd/Update is the durable store boundary. Failure must prevent commit.
  func write(scope: String, record: String, bytes: Data) throws {
    guard bytes.count <= limit else { throw NativeFailure("MOBILE_RECORD_TOO_LARGE") }
    let q = query(scope, record)
    let attrs: [String: Any] = [kSecValueData as String: bytes,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    var add = q
    attrs.forEach { add[$0] = $1 }
    let status = SecItemAdd(add as CFDictionary, nil)
    if status == errSecDuplicateItem {
      guard SecItemUpdate(q as CFDictionary, attrs as CFDictionary) == errSecSuccess else {
        throw NativeFailure("MOBILE_SECURE_STORE_UNAVAILABLE")
      }
    } else if status != errSecSuccess {
      throw NativeFailure("MOBILE_SECURE_STORE_UNAVAILABLE")
    }
  }

  func remove(scope: String, record: String) throws {
    let status = SecItemDelete(query(scope, record) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw NativeFailure("MOBILE_SECURE_STORE_UNAVAILABLE")
    }
  }
}

struct NativeFailure: Error {
  let code: String
  init(_ code: String) { self.code = code }
}
