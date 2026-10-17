import Foundation
import CryptoKit
import CoreFoundation

struct NativeArtifactTarget {
  let targetId: String
  let identityKey: String
  let agentId: String
}
struct NativeArtifactDescriptor {
  let artifactId: String
  let name: String
  let mimeType: String
  let sizeBytes: Int
  let sha256: String
}
struct NativeReadyArtifactFile {
  let url: URL
  let name: String
  let mimeType: String
}

enum NativeArtifactInteger {
  static func value(_ raw: Any?) -> Int? {
    guard let number = raw as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
      number.doubleValue.isFinite, number.doubleValue.rounded(.towardZero) == number.doubleValue,
      number.doubleValue >= 0, number.doubleValue <= Double(Int32.max) else { return nil }
    return number.intValue
  }
}
enum NativeArtifactBoolean {
  static func value(_ raw: Any?) -> Bool? {
    guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
  }
}

/// Encrypted metadata plus a private account-scoped, non-backed-up file cache.
final class NativeArtifactCache {
  private let records: SecureRecords
  private let scope: String
  private let root: URL
  private let index = "artifact-cache-index-v1"
  private let fault: (String) -> Void
  init(scope: String, bundle: String, fault: @escaping (String) -> Void = { _ in }) throws {
    self.scope = scope
    self.fault = fault
    records = SecureRecords(bundle: bundle)
    let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("artifacts-v1", isDirectory: true)
    root = base.appendingPathComponent(Self.hash(Data(scope.utf8)), isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var resource = URLResourceValues()
    resource.isExcludedFromBackup = true
    var excluded = root
    try excluded.setResourceValues(resource)
  }
  private func record(_ identity: String, _ session: String, _ id: String) -> String {
    "artifact-v1:" + identity + ":" + session + ":" + id
  }
  private func catalog(_ identity: String, _ session: String) -> String { "artifact-catalog-v1:" + identity + ":" + session }
  func saveCatalog(identity: String, session: String, agent: String, before: String?, next: String?, items: [NativeArtifactDescriptor]) throws {
    let key = catalog(identity, session)
    var existing: [String: Any]?
    if before != nil {
      guard let data = try records.read(scope: scope, record: key),
        let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        Set(value.keys) == Set(["version", "identityKey", "agentId", "sessionId", "nextBefore", "items"]),
        NativeArtifactInteger.value(value["version"]) == 1, value["identityKey"] as? String == identity,
        value["sessionId"] as? String == session, value["agentId"] as? String == agent,
        value["nextBefore"] as? String == before else {
        throw NativeFailure("MOBILE_ARTIFACT_REFRESH_REQUIRED")
      }
      existing = value
    }
    var all: [String: NativeArtifactDescriptor] = [:]
    if before != nil {
      guard let old = existing?["items"] as? [[String: Any]] else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_INVALID") }
      for item in old { let descriptor = try Self.parseDescriptor(item); all[descriptor.artifactId] = descriptor }
    }
    for item in items {
      if let old = all[item.artifactId], old.artifactId != item.artifactId || old.name != item.name || old.mimeType != item.mimeType || old.sizeBytes != item.sizeBytes || old.sha256 != item.sha256 {
        throw NativeFailure("MOBILE_ARTIFACT_DESCRIPTOR_CHANGED")
      }
      all[item.artifactId] = item
    }
    guard all.count <= 128 else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_LIMIT") }
    let value: [String: Any] = ["version": 1, "identityKey": identity, "agentId": agent, "sessionId": session,
      "nextBefore": (next as Any?) ?? NSNull(), "items": all.values.map(Self.project)]
    let bytes = try JSONSerialization.data(withJSONObject: value)
    guard bytes.count <= 220 * 1024 else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_LIMIT") }
    try records.write(scope: scope, record: key, bytes: bytes)
    guard try records.read(scope: scope, record: key) == bytes else { throw NativeFailure("MOBILE_ARTIFACT_PERSISTENCE_UNCONFIRMED") }
  }
  func requireListed(identity: String, session: String, agent: String, descriptor: NativeArtifactDescriptor) throws {
    guard let bytes = try records.read(scope: scope, record: catalog(identity, session)),
      let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      NativeArtifactInteger.value(value["version"]) == 1, value["identityKey"] as? String == identity,
      value["agentId"] as? String == agent, value["sessionId"] as? String == session,
      let items = value["items"] as? [[String: Any]] else { throw NativeFailure("MOBILE_ARTIFACT_REFRESH_REQUIRED") }
    guard let found = try items.map(Self.parseDescriptor).first(where: { $0.artifactId == descriptor.artifactId }) else {
      throw NativeFailure("MOBILE_ARTIFACT_REFRESH_REQUIRED")
    }
    guard found.name == descriptor.name, found.mimeType == descriptor.mimeType, found.sizeBytes == descriptor.sizeBytes, found.sha256 == descriptor.sha256 else {
      throw NativeFailure("MOBILE_ARTIFACT_DESCRIPTOR_CHANGED")
    }
  }
  private func file(_ identity: String, _ session: String, _ id: String) -> URL {
    let key = scope + "\u{0}" + identity + "\u{0}" + session + "\u{0}" + id
    return root.appendingPathComponent(Self.hash(Data(key.utf8)))
  }
  private func entries() throws -> [String] {
    guard let data = try records.read(scope: scope, record: index) else { return [] }
    guard let values = try JSONSerialization.jsonObject(with: data) as? [String], values.count <= 256,
      Set(values).count == values.count,
      values.allSatisfy({ $0.range(of: "^artifact-v1:[0-9a-f]{64}:[A-Za-z0-9-]{1,99}:[0-9a-f-]{36}$", options: .regularExpression) != nil }) else {
      throw NativeFailure("MOBILE_ARTIFACT_CACHE_INVALID")
    }
    var recovered: [String] = []
    var changed = false
    for entry in values {
      let parts = entry.split(separator: ":")
      guard parts.count == 4 else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_INVALID") }
      guard let job = try read(identity: String(parts[1]), session: String(parts[2]), id: String(parts[3])) else {
        let orphan = file(String(parts[1]), String(parts[2]), String(parts[3]))
        if FileManager.default.fileExists(atPath: orphan.path) { try FileManager.default.removeItem(at: orphan) }
        changed = true // A process may stop after indexing a reservation but before its sealed job.
        continue
      }
      if job["state"] as? String == "deleting" {
        let url = file(String(parts[1]), String(parts[2]), String(parts[3]))
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        try records.remove(scope: scope, record: entry)
        changed = true
      } else {
        recovered.append(entry) // Preserve sealed paused, active, and ready jobs.
      }
    }
    if changed { try saveIndex(recovered) }
    return recovered
  }
  private func saveIndex(_ values: [String]) throws {
    let bytes = try JSONSerialization.data(withJSONObject: values)
    try records.write(scope: scope, record: index, bytes: bytes)
    guard try records.read(scope: scope, record: index) == bytes else { throw NativeFailure("MOBILE_ARTIFACT_PERSISTENCE_UNCONFIRMED") }
  }
  func read(identity: String, session: String, id: String) throws -> [String: Any]? {
    let key = record(identity, session, id)
    guard let data = try records.read(scope: scope, record: key) else { return nil }
    guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(value.keys) == Set(["version", "record", "identityKey", "agentId", "sessionId", "artifactId", "name", "mimeType", "sizeBytes", "sha256", "receivedBytes", "state", "errorCode"]),
      NativeArtifactInteger.value(value["version"]) == 1, value["record"] as? String == key,
      value["identityKey"] as? String == identity, value["sessionId"] as? String == session,
      value["artifactId"] as? String == id else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_INVALID") }
    return value
  }
  func reserve(session: String, target: NativeArtifactTarget, descriptor: NativeArtifactDescriptor) throws -> [String: Any] {
    let key = record(target.identityKey, session, descriptor.artifactId)
    let values = try entries()
    if let old = try read(identity: target.identityKey, session: session, id: descriptor.artifactId) {
      guard old["name"] as? String == descriptor.name, old["mimeType"] as? String == descriptor.mimeType,
        NativeArtifactInteger.value(old["sizeBytes"]) == descriptor.sizeBytes,
        old["sha256"] as? String == descriptor.sha256, old["agentId"] as? String == target.agentId else {
        throw NativeFailure("MOBILE_ARTIFACT_DESCRIPTOR_CHANGED")
      }
      if !values.contains(key) { try saveIndex(values + [key]) }
      return old
    }
    guard values.filter({ $0.hasPrefix("artifact-v1:" + target.identityKey + ":") }).count < 10,
      values.count < 256 else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_LIMIT") }
    var used = 0
    for entry in values {
      let parts = entry.split(separator: ":")
      guard parts.count == 4,
        let item = try read(identity: String(parts[1]), session: String(parts[2]), id: String(parts[3])),
        let size = NativeArtifactInteger.value(item["sizeBytes"]) else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_INVALID") }
      used += size
    }
    guard used + descriptor.sizeBytes <= 200 * 1024 * 1024 else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_LIMIT") }
    let job: [String: Any] = [
      "version": 1, "record": key, "identityKey": target.identityKey, "agentId": target.agentId,
      "sessionId": session, "artifactId": descriptor.artifactId, "name": descriptor.name,
      "mimeType": descriptor.mimeType, "sizeBytes": descriptor.sizeBytes, "sha256": descriptor.sha256,
      "receivedBytes": 0, "state": "paused", "errorCode": NSNull()
    ]
    try saveIndex(values + [key])
    fault("reserve.index")
    try write(job)
    fault("reserve.job")
    return job
  }
  func write(_ job: [String: Any]) throws {
    guard let record = job["record"] as? String else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_INVALID") }
    let bytes = try JSONSerialization.data(withJSONObject: job)
    try records.write(scope: scope, record: record, bytes: bytes)
    guard try records.read(scope: scope, record: record) == bytes else { throw NativeFailure("MOBILE_ARTIFACT_PERSISTENCE_UNCONFIRMED") }
  }
  func length(identity: String, session: String, id: String) throws -> Int {
    let url = file(identity, session, id)
    guard FileManager.default.fileExists(atPath: url.path) else { return 0 }
    guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size >= 0 else {
      throw NativeFailure("MOBILE_ARTIFACT_CACHE_INVALID")
    }
    return size
  }
  func reconcile(identity: String, session: String, id: String, committed: Int) throws {
    let url = file(identity, session, id)
    let actual = try length(identity: identity, session: session, id: id)
    guard actual >= committed else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_INVALID") }
    if actual > committed {
      let handle = try FileHandle(forWritingTo: url)
      defer { try? handle.close() }
      try handle.truncate(atOffset: UInt64(committed))
      try handle.synchronize()
    }
  }
  func append(identity: String, session: String, id: String, expected: Int, bytes: Data) throws {
    let url = file(identity, session, id)
    if !FileManager.default.fileExists(atPath: url.path) {
      guard FileManager.default.createFile(atPath: url.path, contents: nil,
        attributes: [.posixPermissions: 0o600, .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else {
        throw NativeFailure("MOBILE_ARTIFACT_CACHE_UNAVAILABLE")
      }
    }
    var excludedURL = url
    var resource = URLResourceValues(); resource.isExcludedFromBackup = true
    try excludedURL.setResourceValues(resource)
    let handle = try FileHandle(forWritingTo: url)
    defer { try? handle.close() }
    guard try handle.seekToEnd() == UInt64(expected) else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_INVALID") }
    try handle.write(contentsOf: bytes)
    try handle.synchronize()
  }
  func hash(identity: String, session: String, id: String) throws -> String {
    let handle = try FileHandle(forReadingFrom: file(identity, session, id))
    defer { try? handle.close() }
    var digest = SHA256()
    while let data = try handle.read(upToCount: 24 * 1024), !data.isEmpty { digest.update(data: data) }
    return digest.finalize().map { String(format: "%02x", $0) }.joined()
  }
  func recover() throws { _ = try entries() }
  func remove(identity: String, session: String, id: String) throws {
    let key = record(identity, session, id)
    var values = try entries()
    guard var job = try read(identity: identity, session: session, id: id) else { throw NativeFailure("MOBILE_ARTIFACT_NOT_FOUND") }
    if !values.contains(key) { values.append(key); try saveIndex(values) }
    job["state"] = "deleting"
    try write(job)
    fault("delete.marker")
    let url = file(identity, session, id)
    if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    fault("delete.file")
    try records.remove(scope: scope, record: key)
    fault("delete.record")
    try saveIndex(values.filter { $0 != key })
    fault("delete.index")
  }
  func url(identity: String, session: String, id: String) -> URL { file(identity, session, id) }
  private static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}

/// Query/pause are local-only. Explicit download resumes one verified chunk per turn.
final class NativeArtifactScheduler {
  struct IO {
    let request: (String, [String: Any]) throws -> [String: Any]
    let schedule: (@escaping () -> Void) -> Void
    let allowed: () -> Bool
    let onChanged: ([String: Any]) -> Void
  }
  private let cache: NativeArtifactCache
  private let scope: String
  private let io: IO
  private var current: [String: Any]?
  private var currentTarget: NativeArtifactTarget?
  private var generation: UInt64 = 0
  private let chunkBytes = 24 * 1024
  init(cache: NativeArtifactCache, scope: String, io: IO) { self.cache = cache; self.scope = scope; self.io = io }

  func list(target: NativeArtifactTarget, session: String, limit: Int, before: String?) throws -> [String: Any] {
    try Self.validateTarget(target); try validateSession(session)
    guard (1...30).contains(limit), before.map({ !$0.isEmpty && $0.utf8.count <= 256 }) ?? true else { throw NativeFailure("MOBILE_INTENT_INVALID") }
    var request: [String: Any] = ["version": 1, "kind": "list", "agentId": target.agentId, "sessionId": session, "limit": limit]
    if let before { request["before"] = before }
    let result = try io.request(target.targetId, request)
    try Self.throwRemoteError(result)
    guard Set(result.keys) == Set(["version", "kind", "agentId", "sessionId", "items", "hasMore", "nextBefore"]),
      NativeArtifactInteger.value(result["version"]) == 1, result["kind"] as? String == "list",
      result["agentId"] as? String == target.agentId, result["sessionId"] as? String == session,
      let items = result["items"] as? [[String: Any]], items.count <= limit,
      let more = NativeArtifactBoolean.value(result["hasMore"]), let rawNext = result["nextBefore"] else { throw NativeFailure("MOBILE_ARTIFACT_RESPONSE_INVALID") }
    let next: String?
    if rawNext is NSNull { next = nil }
    else if let text = rawNext as? String { next = text }
    else { throw NativeFailure("MOBILE_ARTIFACT_RESPONSE_INVALID") }
    guard more == (next != nil), next == nil || (next?.isEmpty == false && (next?.utf8.count ?? 257) <= 256 && next != before) else { throw NativeFailure("MOBILE_ARTIFACT_RESPONSE_INVALID") }
    let parsed = try items.map { try Self.descriptor($0) }
    guard Set(parsed.map(\.artifactId)).count == parsed.count else { throw NativeFailure("MOBILE_ARTIFACT_RESPONSE_INVALID") }
    try cache.saveCatalog(identity: target.identityKey, session: session, agent: target.agentId, before: before, next: next, items: parsed)
    return ["kind": "artifact-list", "targetId": target.targetId, "identityKey": target.identityKey,
      "agentId": target.agentId, "sessionId": session, "items": parsed.map(Self.project),
      "hasMore": more, "nextBefore": (next as Any?) ?? NSNull()]
  }
  func download(target: NativeArtifactTarget, session: String, descriptor: NativeArtifactDescriptor) throws -> [String: Any] {
    try Self.validateTarget(target); try validateSession(session); try Self.validateDescriptor(descriptor)
    try cache.requireListed(identity: target.identityKey, session: session, agent: target.agentId, descriptor: descriptor)
    if current?["state"] as? String == "downloading" { throw NativeFailure("MOBILE_ARTIFACT_BUSY") }
    var job = try cache.reserve(session: session, target: target, descriptor: descriptor)
    guard let offset = NativeArtifactInteger.value(job["receivedBytes"]) else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_INVALID") }
    try cache.reconcile(identity: target.identityKey, session: session, id: descriptor.artifactId, committed: offset)
    guard try cache.length(identity: target.identityKey, session: session, id: descriptor.artifactId) == offset else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_INVALID") }
    job["state"] = "downloading"; job["errorCode"] = NSNull()
    current = job; currentTarget = target; generation &+= 1
    try persist(job); emit(job, target); scheduleStep()
    return projection(job, target)
  }
  func status(target: NativeArtifactTarget, session: String, id: String) throws -> [String: Any] {
    let job = try localJob(target, session, id)
    guard let received = NativeArtifactInteger.value(job["receivedBytes"]),
      try cache.length(identity: target.identityKey, session: session, id: id) == received else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_INVALID") }
    if job["state"] as? String == "ready" {
      guard let size = NativeArtifactInteger.value(job["sizeBytes"]), size == received,
        try cache.hash(identity: target.identityKey, session: session, id: id) == (job["sha256"] as? String) else { throw NativeFailure("MOBILE_ARTIFACT_CACHE_INVALID") }
    }
    var result = projection(job, target)
    if job["state"] as? String == "downloading" && current?["record"] as? String != job["record"] as? String { result["state"] = "paused" }
    return result
  }
  func pause(target: NativeArtifactTarget, session: String, id: String) throws -> [String: Any] {
    var job = try localJob(target, session, id)
    if current?["record"] as? String == job["record"] { generation &+= 1; current = nil; currentTarget = nil }
    if job["state"] as? String != "ready" { job["state"] = "paused" }
    job["errorCode"] = NSNull()
    try persist(job); emit(job, target)
    return projection(job, target)
  }
  func remove(target: NativeArtifactTarget, session: String, id: String) throws -> [String: Any] {
    let job = try localJob(target, session, id)
    guard current?["record"] as? String != job["record"] as? String else { throw NativeFailure("MOBILE_ARTIFACT_ACTIVE") }
    try cache.remove(identity: target.identityKey, session: session, id: id)
    return action("remove", target, session, id, "removed")
  }
  func readyFile(target: NativeArtifactTarget, session: String, id: String) throws -> NativeReadyArtifactFile {
    let job = try localJob(target, session, id)
    guard job["state"] as? String == "ready", let size = NativeArtifactInteger.value(job["sizeBytes"]),
      let name = job["name"] as? String, let mime = job["mimeType"] as? String,
      try cache.length(identity: target.identityKey, session: session, id: id) == size,
      try cache.hash(identity: target.identityKey, session: session, id: id) == (job["sha256"] as? String) else {
      throw NativeFailure("MOBILE_ARTIFACT_NOT_READY")
    }
    return NativeReadyArtifactFile(url: cache.url(identity: target.identityKey, session: session, id: id), name: name, mimeType: mime)
  }
  func pause() {
    guard var job = current else { return }
    generation &+= 1
    if job["state"] as? String == "downloading" {
      job["state"] = "paused"; job["errorCode"] = "MOBILE_ARTIFACT_PAUSED"
      if let target = currentTarget { try? persist(job); emit(job, target) }
    }
    current = nil; currentTarget = nil
  }
  func pauseForTarget(_ id: String) { if let target = currentTarget, target.targetId != id { pause() } }
  func pauseForSession(_ id: String) { if current?["sessionId"] as? String == id { pause() } }
  func validateTargets(_ values: [[String: Any]]) {
    guard let target = currentTarget else { return }
    if !values.contains(where: { $0["targetId"] as? String == target.targetId && $0["identityKey"] as? String == target.identityKey && $0["agentId"] as? String == target.agentId }) { pause() }
  }

  private func scheduleStep() {
    let token = generation
    io.schedule { [weak self] in
      guard let self, token == self.generation, var job = self.current, let target = self.currentTarget else { return }
      guard self.io.allowed() else { self.pause(); return }
      do {
        guard job["state"] as? String == "downloading", let offset = NativeArtifactInteger.value(job["receivedBytes"]),
          let session = job["sessionId"] as? String, let id = job["artifactId"] as? String else { throw NativeFailure("MOBILE_ARTIFACT_PAUSED") }
        let response = try self.io.request(target.targetId, ["version": 1, "kind": "read", "agentId": target.agentId,
          "sessionId": session, "artifactId": id, "offset": offset, "maxBytes": self.chunkBytes])
        guard token == self.generation, self.current?["record"] as? String == job["record"] else { return }
        try Self.throwRemoteError(response)
        let bytes = try Self.chunk(response, job: job, offset: offset, chunkBytes: self.chunkBytes)
        let next = offset + bytes.count
        guard let size = NativeArtifactInteger.value(job["sizeBytes"]), let eof = NativeArtifactBoolean.value(response["eof"]),
          next <= size, eof == (next == size) else { throw NativeFailure("MOBILE_ARTIFACT_RESPONSE_INVALID") }
        try self.cache.append(identity: target.identityKey, session: session, id: id, expected: offset, bytes: bytes)
        job["receivedBytes"] = next
        if eof {
          guard try self.cache.hash(identity: target.identityKey, session: session, id: id) == (job["sha256"] as? String) else { throw NativeFailure("MOBILE_ARTIFACT_HASH_MISMATCH") }
          job["state"] = "ready"
        }
        try self.persist(job); self.emit(job, target)
        if eof { self.current = nil; self.currentTarget = nil } else { self.scheduleStep() }
      } catch {
        if token == self.generation, self.current?["record"] as? String == job["record"] {
          self.generation &+= 1; job["state"] = "paused"; job["errorCode"] = self.errorCode(error)
          try? self.persist(job); self.emit(job, target); self.current = nil; self.currentTarget = nil
        }
      }
    }
  }
  private func localJob(_ target: NativeArtifactTarget, _ session: String, _ id: String) throws -> [String: Any] {
    try cache.recover()
    try Self.validateTarget(target); try validateSession(session); try validateID(id)
    guard let job = try cache.read(identity: target.identityKey, session: session, id: id),
      job["agentId"] as? String == target.agentId else { throw NativeFailure("MOBILE_ARTIFACT_NOT_FOUND") }
    return job
  }
  private func persist(_ job: [String: Any]) throws { try cache.write(job) }
  private func emit(_ job: [String: Any], _ target: NativeArtifactTarget) { io.onChanged(projection(job, target)) }
  private func projection(_ job: [String: Any], _ target: NativeArtifactTarget) -> [String: Any] {
    ["kind": "artifact-download", "targetId": target.targetId, "identityKey": job["identityKey"]!,
      "agentId": job["agentId"]!, "sessionId": job["sessionId"]!, "artifactId": job["artifactId"]!,
      "name": job["name"]!, "mimeType": job["mimeType"]!, "sha256": job["sha256"]!,
      "state": job["state"]!, "receivedBytes": job["receivedBytes"]!, "totalBytes": job["sizeBytes"]!,
      "errorCode": job["errorCode"] ?? NSNull()]
  }
  private func action(_ action: String, _ target: NativeArtifactTarget, _ session: String, _ id: String, _ state: String) -> [String: Any] {
    ["kind": "artifact-action", "action": action, "targetId": target.targetId, "identityKey": target.identityKey,
      "agentId": target.agentId, "sessionId": session, "artifactId": id, "state": state, "errorCode": NSNull()]
  }
  static func validateTarget(_ target: NativeArtifactTarget) throws {
    guard target.targetId.range(of: "^[A-Za-z0-9._:-]{1,256}$", options: .regularExpression) != nil,
      target.identityKey.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      target.agentId.range(of: "^[A-Za-z0-9._:-]{1,256}$", options: .regularExpression) != nil else { throw NativeFailure("MOBILE_TARGET_INVALID") }
  }
  private func validateSession(_ id: String) throws { guard id.range(of: "^[A-Za-z0-9-]{1,99}$", options: .regularExpression) != nil else { throw NativeFailure("MOBILE_INTENT_INVALID") } }
  private func validateID(_ id: String) throws { guard UUID(uuidString: id)?.uuidString.lowercased() == id else { throw NativeFailure("MOBILE_INTENT_INVALID") } }
  private func errorCode(_ error: Error) -> String {
    let code = (error as? NativeFailure)?.code ?? "MOBILE_ARTIFACT_UNAVAILABLE"
    return code.range(of: "^[A-Z0-9_]{1,128}$", options: .regularExpression) != nil ? code : "MOBILE_ARTIFACT_UNAVAILABLE"
  }
  static func validateDescriptor(_ value: NativeArtifactDescriptor) throws {
    guard UUID(uuidString: value.artifactId)?.uuidString.lowercased() == value.artifactId,
      (1...256).contains(value.name.count), value.name != ".", value.name != "..",
      !value.name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || $0 == "/" || $0 == "\\" }),
      value.mimeType.utf8.count <= 128, value.mimeType.range(of: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$", options: .regularExpression) != nil,
      (1...(20 * 1024 * 1024)).contains(value.sizeBytes), value.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
      throw NativeFailure("MOBILE_INTENT_INVALID")
    }
  }
  private static func descriptor(_ value: [String: Any]) throws -> NativeArtifactDescriptor {
    guard Set(value.keys) == Set(["artifactId", "name", "mimeType", "sizeBytes", "sha256"]),
      let id = value["artifactId"] as? String, let name = value["name"] as? String, let mime = value["mimeType"] as? String,
      let size = NativeArtifactInteger.value(value["sizeBytes"]), let hash = value["sha256"] as? String else {
      throw NativeFailure("MOBILE_ARTIFACT_RESPONSE_INVALID")
    }
    let result = NativeArtifactDescriptor(artifactId: id, name: name, mimeType: mime, sizeBytes: size, sha256: hash)
    try validateDescriptor(result); return result
  }
  private static func project(_ value: NativeArtifactDescriptor) -> [String: Any] {
    ["artifactId": value.artifactId, "name": value.name, "mimeType": value.mimeType, "sizeBytes": value.sizeBytes, "sha256": value.sha256]
  }
  private static func chunk(_ value: [String: Any], job: [String: Any], offset: Int, chunkBytes: Int) throws -> Data {
    guard Set(value.keys) == Set(["version", "kind", "agentId", "sessionId", "artifactId", "offset", "dataBase64", "sha256", "eof"]),
      NativeArtifactInteger.value(value["version"]) == 1, value["kind"] as? String == "chunk",
      value["agentId"] as? String == job["agentId"] as? String, value["sessionId"] as? String == job["sessionId"] as? String,
      value["artifactId"] as? String == job["artifactId"] as? String, NativeArtifactInteger.value(value["offset"]) == offset,
      let encoded = value["dataBase64"] as? String, encoded.utf8.count <= 32_768, let hash = value["sha256"] as? String,
      NativeArtifactBoolean.value(value["eof"]) != nil,
      hash.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { throw NativeFailure("MOBILE_ARTIFACT_RESPONSE_INVALID") }
    guard let bytes = Data(base64Encoded: encoded), bytes.count <= chunkBytes,
      bytes.base64EncodedString() == encoded, !bytes.isEmpty || NativeArtifactBoolean.value(value["eof"]) == true,
      SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == hash else { throw NativeFailure("MOBILE_ARTIFACT_HASH_MISMATCH") }
    return bytes
  }
  private static func throwRemoteError(_ value: [String: Any]) throws {
    guard value["kind"] as? String == "error" else { return }
    let code = value["code"] as? String
    let keys = Set(value.keys)
    let typedAsset = keys == Set(["version", "kind", "code"]) && NativeArtifactInteger.value(value["version"]) == 1 &&
      code?.range(of: "^ASSET_[A-Z0-9_]{1,122}$", options: .regularExpression) != nil
    let connectionFailure = keys == Set(["kind", "code"]) &&
      code?.range(of: "^[A-Z0-9_]{1,128}$", options: .regularExpression) != nil
    guard typedAsset == true || connectionFailure == true, let code else {
      throw NativeFailure("MOBILE_ARTIFACT_RESPONSE_INVALID")
    }
    throw NativeFailure(code)
  }
}
