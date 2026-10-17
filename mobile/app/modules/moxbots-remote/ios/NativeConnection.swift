import Foundation
import MoxConnectionCore

/// Sole Swift owner of the Rust connection handle; called only on the module queue.
final class NativeConnection {
  private var handle: OpaquePointer?
  private var context: UnsafeMutableRawPointer?
  private static let recordLimit = 256 * 1024

  private static func recordName(_ bytes: UnsafePointer<UInt8>?, _ count: Int) -> String? {
    guard count > 0, count <= 8192, let bytes else { return nil }
    let value = String(bytes: UnsafeBufferPointer(start: bytes, count: count), encoding: .utf8)
    guard let value, !value.contains("\u{0}") else { return nil }
    return value
  }
  private static let read: MoxStoreRead = { context, scope, scopeLength, name, nameLength, output, capacity in
    guard let context, let output, capacity <= recordLimit,
      let scope = recordName(scope, scopeLength), let name = recordName(name, nameLength) else { return -2 }
    let records = Unmanaged<SecureRecords>.fromOpaque(context).takeUnretainedValue()
    do {
      guard let data = try records.read(scope: scope, record: name) else { return -1 }
      guard data.count <= capacity else { return -2 }
      data.copyBytes(to: output, count: data.count)
      return Int64(data.count)
    } catch { return -2 }
  }
  private static let write: MoxStoreWrite = { context, scope, scopeLength, name, nameLength, bytes, length in
    guard let context, let bytes, length <= recordLimit,
      let scope = recordName(scope, scopeLength), let name = recordName(name, nameLength) else { return -1 }
    let records = Unmanaged<SecureRecords>.fromOpaque(context).takeUnretainedValue()
    do {
      try records.write(scope: scope, record: name, bytes: Data(bytes: bytes, count: length))
      return 0
    } catch { return -1 }
  }
  private static let remove: MoxStoreRemove = { context, scope, scopeLength, name, nameLength in
    guard let context, let scope = recordName(scope, scopeLength), let name = recordName(name, nameLength) else { return -1 }
    do {
      try Unmanaged<SecureRecords>.fromOpaque(context).takeUnretainedValue().remove(scope: scope, record: name)
      return 0
    } catch { return -1 }
  }

  init(origin: String, bundle: String) throws {
    let retained = Unmanaged.passRetained(SecureRecords(bundle: bundle)).toOpaque()
    context = retained
    let store = MoxConnectionStore(context: retained, read: Self.read, write: Self.write, remove: Self.remove)
    let config = try JSONSerialization.data(withJSONObject: ["issuer": origin, "publicTlsCa": NSNull()])
    var error = MoxConnectionBuffer(data: nil, len: 0, status: 0)
    handle = config.withUnsafeBytes { raw in
      mox_connection_new(raw.bindMemory(to: UInt8.self).baseAddress, config.count, store, &error)
    }
    defer { mox_connection_buffer_free(error) }
    guard handle != nil else {
      Unmanaged<SecureRecords>.fromOpaque(retained).release()
      context = nil
      throw NativeFailure("MOBILE_CONNECTION_UNAVAILABLE")
    }
  }

  func request(_ input: String) throws -> String {
    guard let handle, let data = input.data(using: .utf8), data.count <= 64 * 1024 else {
      throw NativeFailure("MOBILE_INPUT_INVALID")
    }
    let response = data.withUnsafeBytes { raw in
      mox_connection_request(handle, raw.bindMemory(to: UInt8.self).baseAddress, data.count)
    }
    defer { mox_connection_buffer_free(response) }
    guard let bytes = response.data, response.len <= 256 * 1024,
      let envelope = try JSONSerialization.jsonObject(with: Data(bytes: bytes, count: response.len)) as? [String: Any] else {
      throw NativeFailure("MOBILE_RESPONSE_INVALID")
    }
    let value: Any
    if response.status == 0, envelope["ok"] as? Bool == true, let projection = envelope["value"] {
      value = projection
    } else {
      let error = envelope["error"] as? [String: Any]
      let rawCode = error?["code"] as? String ?? "MOBILE_CONNECTION_UNAVAILABLE"
      let code = rawCode.range(of: "^[A-Z0-9_]{1,128}$", options: .regularExpression) != nil
        ? rawCode : "MOBILE_CONNECTION_UNAVAILABLE"
      value = ["kind": "error", "code": code]
    }
    let result = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    guard let text = String(data: result, encoding: .utf8) else { throw NativeFailure("MOBILE_RESPONSE_INVALID") }
    return text
  }

  func close() {
    if let handle { mox_connection_free(handle); self.handle = nil }
    if let context { Unmanaged<SecureRecords>.fromOpaque(context).release(); self.context = nil }
  }
  deinit { close() }
}
