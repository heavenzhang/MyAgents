import Foundation
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

/// Private native file owner. Public projections contain opaque IDs, never URLs
/// or bytes; the system picker is the only admission source.
final class NativeAttachments {
  private let records: SecureRecords
  private let scope: String
  private let directory: URL
  private let index = "attachment-drafts-v1"
  init(scope: String, bundle: String) throws {
    self.scope = scope
    records = SecureRecords(bundle: bundle)
    let hash = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
    let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: true)
    directory = root.appendingPathComponent("attachment-drafts-v1", isDirectory: true).appendingPathComponent(hash, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var excluded = directory
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    try excluded.setResourceValues(values)
  }
  private func entries() throws -> [[String: Any]] {
    guard let bytes = try records.read(scope: scope, record: index) else { return [] }
    guard let items = try JSONSerialization.jsonObject(with: bytes) as? [[String: Any]], items.count <= 8 else {
      throw NativeFailure("MOBILE_ATTACHMENT_STORAGE_UNAVAILABLE")
    }
    return items
  }
  private func save(_ items: [[String: Any]]) throws {
    try records.write(scope: scope, record: index, bytes: JSONSerialization.data(withJSONObject: items))
  }
  private func file(_ id: String) throws -> URL {
    guard UUID(uuidString: id)?.uuidString.lowercased() == id else { throw NativeFailure("MOBILE_ATTACHMENT_INVALID") }
    return directory.appendingPathComponent(id, isDirectory: false)
  }
  func importPicked(_ source: URL, image: Bool, suggestedName: String? = nil) throws -> [String: Any] {
    var items = try entries()
    guard items.count < 8 else { throw NativeFailure("MOBILE_ATTACHMENT_LIMIT") }
    let access = source.startAccessingSecurityScopedResource()
    defer { if access { source.stopAccessingSecurityScopedResource() } }
    let attributes = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .contentTypeKey, .nameKey])
    guard source.isFileURL, attributes.isRegularFile == true, attributes.isSymbolicLink != true else {
      throw NativeFailure("MOBILE_ATTACHMENT_INVALID")
    }
    let id = UUID().uuidString.lowercased()
    let destination = try file(id)
    let pending = directory.appendingPathComponent(".pending-" + id)
    guard FileManager.default.createFile(atPath: pending.path, contents: nil,
      attributes: [.posixPermissions: 0o600, .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else {
      throw NativeFailure("MOBILE_ATTACHMENT_STORAGE_UNAVAILABLE")
    }
    defer { try? FileManager.default.removeItem(at: pending) }
    let input = try FileHandle(forReadingFrom: source)
    let output = try FileHandle(forWritingTo: pending)
    defer { try? input.close(); try? output.close() }
    var hasher = SHA256()
    var size = 0
    let maximum = (image ? 10 : 20) * 1024 * 1024
    while let bytes = try input.read(upToCount: 24 * 1024), !bytes.isEmpty {
      size += bytes.count
      guard size <= maximum else { throw NativeFailure("MOBILE_ATTACHMENT_TOO_LARGE") }
      hasher.update(data: bytes); try output.write(contentsOf: bytes)
    }
    guard size > 0 else { throw NativeFailure("MOBILE_ATTACHMENT_EMPTY") }
    try output.synchronize()
    var type = attributes.contentType
    if image {
      guard let source = CGImageSourceCreateWithURL(pending as CFURL, nil),
        let rawType = CGImageSourceGetType(source), let actualType = UTType(rawType as String), actualType.conforms(to: .image),
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
        let width = properties[kCGImagePropertyPixelWidth] as? Int,
        let height = properties[kCGImagePropertyPixelHeight] as? Int,
        width > 0, height > 0, Int64(width) * Int64(height) <= 40_000_000 else {
        throw NativeFailure("MOBILE_ATTACHMENT_IMAGE_INVALID")
      }
      type = actualType
    }
    var name = suggestedName ?? attributes.name ?? (image ? "图片" : "文件")
    name = String(name.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) || "/\\".unicodeScalars.contains($0) ? "_" : String($0) }.joined().prefix(256))
    if name.isEmpty { name = "文件" }
    let item: [String: Any] = ["localId": id, "name": name, "mimeType": type?.preferredMIMEType ?? "application/octet-stream",
      "sizeBytes": size, "sha256": hasher.finalize().map { String(format: "%02x", $0) }.joined(), "image": image,
      "createdAt": Date().timeIntervalSince1970]
    try FileManager.default.moveItem(at: pending, to: destination)
    do { items.append(item); try save(items) }
    catch { try? FileManager.default.removeItem(at: destination); throw error }
    return projection(item)
  }
  func list() throws -> [String: Any] {
    let items = try entries().filter { item in
      guard let id = item["localId"] as? String, let path = try? file(id) else { return false }
      return FileManager.default.fileExists(atPath: path.path)
    }.map(projection)
    return ["kind": "attachments", "items": items]
  }
  func remove(_ id: String) throws -> [String: Any] {
    let items = try entries()
    guard items.contains(where: { $0["localId"] as? String == id }) else { throw NativeFailure("MOBILE_ATTACHMENT_NOT_FOUND") }
    try save(items.filter { $0["localId"] as? String != id })
    let path = try file(id)
    if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) }
    return ["kind": "attachment-removed", "localId": id]
  }
  /// Native upload scheduler only; no JS byte-read operation exists.
  func readChunk(_ id: String, offset: UInt64) throws -> ([String: Any], Data) {
    guard let item = try entries().first(where: { $0["localId"] as? String == id }),
      let size = item["sizeBytes"] as? Int, offset < UInt64(size) else { throw NativeFailure("MOBILE_ATTACHMENT_NOT_FOUND") }
    let input = try FileHandle(forReadingFrom: file(id)); defer { try? input.close() }
    guard try input.seekToEnd() == UInt64(size) else { throw NativeFailure("MOBILE_ATTACHMENT_INVALID") }
    try input.seek(toOffset: offset)
    let length = min(24 * 1024, size - Int(offset))
    guard let bytes = try input.read(upToCount: length), bytes.count == length else { throw NativeFailure("MOBILE_ATTACHMENT_UNREADABLE") }
    return (item, bytes)
  }
  private func projection(_ item: [String: Any]) -> [String: Any] {
    var value = item; value.removeValue(forKey: "createdAt"); value["kind"] = "attachment"; return value
  }
}
