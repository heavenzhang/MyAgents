import Foundation
import CryptoKit

struct NativeUploadTarget {
  let targetId: String
  let identityKey: String
  let agentId: String
}

struct NativeUploadSource {
  let localId: String
  let name: String
  let mimeType: String
  let sizeBytes: Int
  let sha256: String
}

struct NativeUploadChunk {
  let source: NativeUploadSource
  var bytes: Data
}

/// One bounded typed assets request per owner-queue turn; all external effects are injectable.
final class NativeUploadScheduler {
  struct IO {
    let readRecord: (String, String) throws -> Data?
    let writeRecord: (String, String, Data) throws -> Void
    let removeRecord: (String, String) throws -> Void
    let source: (String, String) throws -> NativeUploadSource?
    let readChunk: (String, String, UInt64) throws -> NativeUploadChunk
    let request: (String, [String: Any]) throws -> [String: Any]
  }

  private enum Step: Equatable { case status, query, begin, chunk, finish, cancelStatus, cancel }
  private struct Job {
    let scope: String
    let record: String
    let localId: String
    var targetId: String
    let identityKey: String
    let agentId: String
    let uploadId: String
    let name: String
    let mimeType: String
    let totalBytes: Int
    let sha256: String
    var receivedBytes = 0
    var state = "uploading"
    var assetId: String?
    var errorCode: String?
  }

  private let io: IO
  private let schedule: (@escaping () -> Void) -> Void
  private let allowed: () -> Bool
  private let onChanged: ([String: Any]) -> Void
  private var current: Job?
  private var currentStep: Step = .status
  private var generation: UInt64 = 0
  private let chunkBytes = 24 * 1024
  private let maxBytes = 20 * 1024 * 1024
  private let maxJobs = 128
  private let indexRecord = "attachment-upload-index-v1"
  private let states: Set<String> = ["uploading", "ready", "paused", "cancelled"]

  init(io: IO, schedule: @escaping (@escaping () -> Void) -> Void,
       allowed: @escaping () -> Bool, onChanged: @escaping ([String: Any]) -> Void) {
    self.io = io
    self.schedule = schedule
    self.allowed = allowed
    self.onChanged = onChanged
  }

  func start(scope: String, target: NativeUploadTarget, localId: String) throws -> [String: Any] {
    try validate(target: target, localId: localId)
    guard let source = try io.source(scope, localId) else { throw NativeFailure("MOBILE_ATTACHMENT_NOT_FOUND") }
    try validate(source: source)
    let record = recordName(target.identityKey, localId)
    var job = try load(scope: scope, record: record) ?? Job(
      scope: scope, record: record, localId: localId, targetId: target.targetId,
      identityKey: target.identityKey, agentId: target.agentId, uploadId: UUID().uuidString.lowercased(),
      name: source.name, mimeType: source.mimeType, totalBytes: source.sizeBytes, sha256: source.sha256)
    try verify(job: job, target: target, source: source)
    if job.state == "cancelled" { throw NativeFailure("MOBILE_UPLOAD_CANCELLED") }
    try ensureNoOtherActive(scope: scope, record: record)
    if let active = current, active.state == "uploading", active.record != job.record {
      throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_BUSY")
    }
    if let active = current, active.state == "uploading", active.scope == job.scope, active.record == job.record,
      active.targetId == target.targetId { return projection(active) }
    if current != nil { generation &+= 1 }
    if current?.state == "uploading" { pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED") }
    job.targetId = target.targetId
    job.state = "uploading"
    job.assetId = nil
    job.errorCode = nil
    currentStep = .status
    try persist(job)
    current = job
    emit(job)
    scheduleStep()
    return projection(job)
  }

  func status(scope: String, target: NativeUploadTarget, localId: String) throws -> [String: Any] {
    try validate(target: target, localId: localId)
    let record = recordName(target.identityKey, localId)
    guard var job = try load(scope: scope, record: record) else { throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_NOT_FOUND") }
    if let source = try io.source(scope, localId) {
      try validate(source: source)
      try verify(job: job, target: target, source: source)
    } else if job.state != "ready" && job.state != "cancelled" {
      throw NativeFailure("MOBILE_ATTACHMENT_NOT_FOUND")
    }
    try ensureNoOtherActive(scope: scope, record: record)
    if let active = current, active.state == "uploading", active.record != job.record {
      throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_BUSY")
    }
    if let active = current, active.state == "paused" && (currentStep == .cancelStatus || currentStep == .cancel) {
      throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_BUSY")
    }
    if let active = current, active.state == "uploading",
      (active.scope != job.scope || active.record != job.record) {
      pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED")
    }
    if current != nil { generation &+= 1 }
    job.targetId = target.targetId
    if job.state == "cancelled" { return projection(job) }
    let wasReady = job.state == "ready"
    job.state = wasReady ? "ready" : "paused"
    currentStep = .query
    current = job
    try persist(job)
    scheduleStep()
    var snapshot = projection(job)
    if wasReady { snapshot["state"] = "paused"; snapshot["assetId"] = NSNull() }
    return snapshot
  }

  func cancel(scope: String, target: NativeUploadTarget, localId: String) throws -> [String: Any] {
    try validate(target: target, localId: localId)
    let record = recordName(target.identityKey, localId)
    guard var job = try load(scope: scope, record: record) else { throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_NOT_FOUND") }
    if let source = try io.source(scope, localId) {
      try validate(source: source)
      try verify(job: job, target: target, source: source)
    } else if job.state != "ready" && job.state != "cancelled" {
      throw NativeFailure("MOBILE_ATTACHMENT_NOT_FOUND")
    }
    try ensureNoOtherActive(scope: scope, record: record)
    if let active = current, active.state == "uploading", active.record != job.record {
      throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_BUSY")
    }
    if job.state == "ready" || job.state == "cancelled" { return projection(job) }
    job.targetId = target.targetId
    current = job
    generation &+= 1 // Invalidates queued work; an in-flight SDK call remains bounded and cannot be preempted.
    currentStep = .cancelStatus
    job.state = "paused"
    job.errorCode = nil
    try persist(job)
    emit(job)
    scheduleStep()
    return projection(job)
  }

  func pause(scope: String, target: NativeUploadTarget, localId: String) throws -> [String: Any] {
    try validate(target: target, localId: localId)
    let record = recordName(target.identityKey, localId)
    guard var job = try load(scope: scope, record: record) else { throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_NOT_FOUND") }
    if let source = try io.source(scope, localId) {
      try validate(source: source)
      try verify(job: job, target: target, source: source)
    } else if job.state != "ready" && job.state != "cancelled" {
      throw NativeFailure("MOBILE_ATTACHMENT_NOT_FOUND")
    }
    try ensureNoOtherActive(scope: scope, record: record)
    if job.state == "ready" || job.state == "cancelled" { return projection(job) }
    if let active = current, active.record != record {
      if active.state == "uploading" || (active.state == "paused" && (currentStep == .cancelStatus || currentStep == .cancel)) {
        throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_BUSY")
      }
    }
    job.targetId = target.targetId
    job.state = "paused"
    job.errorCode = nil
    generation &+= 1
    currentStep = .status
    current = job
    try persist(job)
    emit(job)
    return projection(job)
  }

  func pause(_ code: String? = nil) {
    guard var job = current else { return }
    if job.state == "ready" && currentStep == .query {
      generation &+= 1
      currentStep = .status
      return
    }
    if job.state == "paused" && (currentStep == .query || currentStep == .cancelStatus || currentStep == .cancel) {
      generation &+= 1
      currentStep = .status
      job.errorCode = code
      current = job
      try? persist(job)
      emit(job)
      return
    }
    guard job.state == "uploading" else { return }
    generation &+= 1
    job.state = "paused"
    job.errorCode = code
    current = job
    try? persist(job)
    emit(job)
  }

  func pauseForTarget(_ targetId: String) {
    if let job = current, (job.state == "uploading" || (["paused", "ready"].contains(job.state) && (currentStep == .query || currentStep == .cancelStatus || currentStep == .cancel))), job.targetId != targetId {
      pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED")
    }
  }

  func pauseUnlessScope(_ scope: String) {
    if let job = current, job.scope != scope, (job.state == "uploading" || (["paused", "ready"].contains(job.state) && (currentStep == .query || currentStep == .cancelStatus || currentStep == .cancel))) {
      pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED")
    }
  }

  func validateTargets(scope: String, items: [[String: Any]]) {
    guard let job = current, job.scope == scope,
      job.state == "uploading" || (["paused", "ready"].contains(job.state) && (currentStep == .query || currentStep == .cancelStatus || currentStep == .cancel)) else { return }
    let approved = items.contains { item in
      item["targetId"] as? String == job.targetId && item["identityKey"] as? String == job.identityKey &&
        item["agentId"] as? String == job.agentId
    }
    if !approved { pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED") }
  }

  func blocksRemoval(scope: String, localId: String) throws -> Bool {
    guard isCanonicalUuid(localId) else { throw NativeFailure("MOBILE_ATTACHMENT_INVALID") }
    if let job = current, job.scope == scope, job.localId == localId, job.state == "uploading" { return true }
    for key in try index(scope) {
      guard let job = try load(scope: scope, record: key) else { return true }
      if job.localId == localId && (job.state == "uploading" || job.state == "paused") { return true }
    }
    return false
  }

  func clearRemovedSource(scope: String, localId: String) throws {
    let active = try blocksRemoval(scope: scope, localId: localId)
    guard !active else { throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_ACTIVE") }
    let keys = try index(scope)
    var remaining: [String] = []
    for key in keys {
      guard let job = try load(scope: scope, record: key) else { remaining.append(key); continue }
      if job.localId == localId && (job.state == "ready" || job.state == "cancelled") {
        try io.removeRecord(scope, key)
      } else { remaining.append(key) }
    }
    try writeIndex(scope, remaining)
  }

  private func scheduleStep() {
    let token = generation
    schedule { [weak self] in
      guard let self, token == self.generation, var job = self.current else { return }
      guard job.state == "uploading" || (job.state == "ready" && self.currentStep == .query) ||
        (job.state == "paused" && (self.currentStep == .query || self.currentStep == .cancelStatus || self.currentStep == .cancel)) else { return }
      guard self.allowed() else { self.pause("MOBILE_ATTACHMENT_UPLOAD_PAUSED"); return }
      self.runStep(&job, token: token)
    }
  }

  private func runStep(_ job: inout Job, token: UInt64) {
    do {
      switch currentStep {
      case .status, .query, .cancelStatus:
        let queryOnly = currentStep == .query
        let isCancel = currentStep == .cancelStatus
        let result = try rpc(job, "upload.status")
        if isNotFound(result) {
          if isCancel { try finishCancelled(&job) }
          else if queryOnly {
            job.state = "paused"; job.assetId = nil; job.errorCode = "MOBILE_UPLOAD_NOT_FOUND"
            try persist(job); emit(job); current = nil
          } else { currentStep = .begin; current = job; scheduleStep() }
          return
        }
        let upload = try requireUpload(result, job: job, allowCancelled: true)
        if upload.state == "cancelled" { try finishCancelled(&job); return }
        job.receivedBytes = upload.receivedBytes
        if queryOnly {
          if upload.state == "ready", job.assetId != nil { job.state = "ready"; job.receivedBytes = job.totalBytes }
          else { job.state = "paused"; job.assetId = nil }
          job.errorCode = nil
          try persist(job); emit(job); current = nil
          return
        } else if isCancel && upload.state == "ready" {
          job.state = "uploading"
          job.errorCode = nil
          currentStep = .finish
        }
        else if isCancel { currentStep = .cancel }
        else if upload.state == "ready" { currentStep = .finish }
        else { currentStep = .chunk }
        current = job
        try persist(job); emit(job); scheduleStep()
      case .begin:
        let result = try rpc(job, "upload.begin", ["name": job.name, "mimeType": job.mimeType,
          "sizeBytes": job.totalBytes, "sha256": job.sha256])
        let upload = try requireUpload(result, job: job, allowCancelled: false)
        guard upload.state == "uploading", upload.receivedBytes == 0 else {
          throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID")
        }
        job.receivedBytes = upload.receivedBytes
        currentStep = .chunk
        current = job
        try persist(job); emit(job); scheduleStep()
      case .chunk:
        if job.receivedBytes >= job.totalBytes { currentStep = .finish; current = job; scheduleStep(); return }
        var chunk = try io.readChunk(job.scope, job.localId, UInt64(job.receivedBytes))
        defer { chunk.bytes.resetBytes(in: 0..<chunk.bytes.count) }
        try verify(job: job, target: NativeUploadTarget(targetId: job.targetId, identityKey: job.identityKey, agentId: job.agentId), source: chunk.source)
        guard !chunk.bytes.isEmpty, chunk.bytes.count <= chunkBytes, job.receivedBytes + chunk.bytes.count <= job.totalBytes else {
          throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_SOURCE_INVALID")
        }
        let result = try rpc(job, "upload.chunk", ["offset": job.receivedBytes,
          "dataBase64": chunk.bytes.base64EncodedString(), "sha256": digest(chunk.bytes)])
        let upload = try requireUpload(result, job: job, allowCancelled: false)
        guard upload.state != "cancelled", upload.receivedBytes == job.receivedBytes + chunk.bytes.count else {
          throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_OFFSET_INVALID")
        }
        job.receivedBytes = upload.receivedBytes
        currentStep = upload.state == "ready" || job.receivedBytes == job.totalBytes ? .finish : .chunk
        current = job
        try persist(job); emit(job); scheduleStep()
      case .finish:
        guard job.receivedBytes == job.totalBytes else { throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID") }
        let result = try rpc(job, "upload.finish")
        guard result["kind"] as? String == "asset", strictInteger(result["version"]) == 1,
          result["agentId"] as? String == job.agentId, result["uploadId"] as? String == job.uploadId,
          let assetId = result["assetId"] as? String, isCanonicalUuid(assetId),
          result["name"] as? String == job.name, result["mimeType"] as? String == job.mimeType,
          strictInteger(result["sizeBytes"]) == job.totalBytes, result["sha256"] as? String == job.sha256 else {
          throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID")
        }
        job.assetId = assetId
        job.receivedBytes = job.totalBytes
        job.state = "ready"
        job.errorCode = nil
        try persist(job); emit(job); current = nil
      case .cancel:
        let result = try rpc(job, "upload.cancel")
        let upload = try requireUpload(result, job: job, allowCancelled: true)
        guard upload.state == "cancelled" else { throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID") }
        try finishCancelled(&job)
      }
    } catch {
      guard token == generation, current?.record == job.record else { return }
      let code = (error as? NativeFailure)?.code ?? "MOBILE_ATTACHMENT_UPLOAD_UNAVAILABLE"
      pause(code)
    }
  }

  private func finishCancelled(_ job: inout Job) throws {
    job.state = "cancelled"
    job.errorCode = nil
    try persist(job); emit(job); current = nil
  }

  private func requireUpload(_ value: [String: Any], job: Job, allowCancelled: Bool) throws -> (receivedBytes: Int, state: String) {
      guard value["kind"] as? String == "upload", strictInteger(value["version"]) == 1,
      value["agentId"] as? String == job.agentId, value["uploadId"] as? String == job.uploadId,
      strictInteger(value["totalBytes"]) == job.totalBytes,
      let received = strictInteger(value["receivedBytes"]), received >= 0, received <= job.totalBytes,
      let state = value["state"] as? String,
      (allowCancelled ? ["uploading", "ready", "cancelled"] : ["uploading", "ready"]).contains(state) else {
      throw NativeFailure(errorCode(value) ?? "MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID")
    }
    guard state != "ready" || received == job.totalBytes else { throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID") }
    return (received, state)
  }

  private func rpc(_ job: Job, _ kind: String, _ fields: [String: Any] = [:]) throws -> [String: Any] {
    var request = fields
    request["version"] = 1; request["kind"] = kind; request["agentId"] = job.agentId; request["uploadId"] = job.uploadId
    let result = try io.request(job.targetId, ["version": 1, "kind": "assets", "targetId": job.targetId, "request": request])
    if let code = errorCode(result), !(kind == "upload.status" && isNotFound(result)) { throw NativeFailure(code) }
    return result
  }

  private func isNotFound(_ value: [String: Any]) -> Bool {
    Set(value.keys) == Set(["kind", "version", "code"]) && (value["kind"] as? String) == "error" &&
      strictInteger(value["version"]) == 1 && value["code"] as? String == "ASSET_NOT_FOUND"
  }
  private func errorCode(_ value: [String: Any]) -> String? {
    guard value["kind"] as? String == "error", let code = value["code"] as? String,
      code.range(of: "^[A-Z0-9_]{1,128}$", options: .regularExpression) != nil else { return nil }
    return code
  }

  private func validate(target: NativeUploadTarget, localId: String) throws {
    guard target.targetId.range(of: "^[A-Za-z0-9._:-]{1,256}$", options: .regularExpression) != nil,
      target.identityKey.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      target.agentId.range(of: "^[A-Za-z0-9._:-]{1,256}$", options: .regularExpression) != nil,
      isCanonicalUuid(localId) else { throw NativeFailure("MOBILE_TARGET_INVALID") }
  }
  private func validate(source: NativeUploadSource) throws {
    guard isCanonicalUuid(source.localId), (1...256).contains(source.name.utf16.count), source.name != ".", source.name != "..",
      !source.name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || $0 == "/" || $0 == "\\" }),
      source.mimeType.range(of: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$", options: .regularExpression) != nil,
      (1...maxBytes).contains(source.sizeBytes), source.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
      throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_SOURCE_INVALID")
    }
  }
  private func verify(job: Job, target: NativeUploadTarget, source: NativeUploadSource) throws {
    guard job.localId == source.localId, job.identityKey == target.identityKey, job.agentId == target.agentId,
      job.name == source.name, job.mimeType == source.mimeType, job.totalBytes == source.sizeBytes, job.sha256 == source.sha256 else {
      throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED")
    }
  }

  private func persist(_ job: Job) throws {
    let oldIndex = try index(job.scope)
    let needsReservation = !oldIndex.contains(job.record)
    guard !needsReservation || oldIndex.count < maxJobs else { throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_LIMIT") }
    if needsReservation {
      do { try writeIndex(job.scope, oldIndex + [job.record]) }
      catch { try? writeIndex(job.scope, oldIndex); throw error }
    }
    let bytes = try JSONSerialization.data(withJSONObject: encoded(job), options: [.sortedKeys])
    do {
      try io.writeRecord(job.scope, job.record, bytes)
      guard try io.readRecord(job.scope, job.record) == bytes else { throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_PERSISTENCE_UNCONFIRMED") }
    } catch {
      if needsReservation {
        try? io.removeRecord(job.scope, job.record)
        try? writeIndex(job.scope, oldIndex)
      }
      throw error
    }
  }

  private func load(scope: String, record: String) throws -> Job? {
    guard let bytes = try io.readRecord(scope, record) else { return nil }
    guard let value = try JSONSerialization.jsonObject(with: bytes) as? [String: Any], Set(value.keys) == Self.jobFields,
      strictInteger(value["version"]) == 1, value["record"] as? String == record,
      let localId = value["localId"] as? String, let targetId = value["targetId"] as? String,
      let identityKey = value["identityKey"] as? String, let agentId = value["agentId"] as? String,
      let uploadId = value["uploadId"] as? String, let name = value["name"] as? String,
      let mimeType = value["mimeType"] as? String, let total = strictInteger(value["totalBytes"]),
      let sha = value["sha256"] as? String, let received = strictInteger(value["receivedBytes"]),
      let state = value["state"] as? String, states.contains(state) else {
      throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_JOURNAL_INVALID")
    }
    let asset = value["assetId"] as? String
    let code = value["errorCode"] as? String
    guard isCanonicalUuid(localId), isCanonicalUuid(uploadId),
      targetId.range(of: "^[A-Za-z0-9._:-]{1,256}$", options: .regularExpression) != nil,
      identityKey.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      agentId.range(of: "^[A-Za-z0-9._:-]{1,256}$", options: .regularExpression) != nil,
      record == recordName(identityKey, localId),
      (1...256).contains(name.utf16.count), name != ".", name != "..",
      !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || $0 == "/" || $0 == "\\" }),
      mimeType.range(of: "^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$", options: .regularExpression) != nil,
      sha.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
      (1...maxBytes).contains(total), (0...total).contains(received),
      asset == nil || isCanonicalUuid(asset!), (state == "ready") == (asset != nil), state != "ready" || received == total,
      code == nil || code!.range(of: "^[A-Z0-9_]{1,128}$", options: .regularExpression) != nil else {
      throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_JOURNAL_INVALID")
    }
    return Job(scope: scope, record: record, localId: localId, targetId: targetId, identityKey: identityKey,
      agentId: agentId, uploadId: uploadId, name: name, mimeType: mimeType, totalBytes: total,
      sha256: sha, receivedBytes: received, state: state, assetId: asset, errorCode: code)
  }

  private func encoded(_ job: Job) -> [String: Any] {
    ["version": 1, "record": job.record, "localId": job.localId, "targetId": job.targetId,
     "identityKey": job.identityKey, "agentId": job.agentId, "uploadId": job.uploadId, "name": job.name,
     "mimeType": job.mimeType, "totalBytes": job.totalBytes, "sha256": job.sha256,
     "receivedBytes": job.receivedBytes, "state": job.state, "assetId": nullValue(job.assetId),
     "errorCode": nullValue(job.errorCode)]
  }

  private func index(_ scope: String) throws -> [String] {
    guard let bytes = try io.readRecord(scope, indexRecord) else { return [] }
    guard let values = try JSONSerialization.jsonObject(with: bytes) as? [String], values.count <= maxJobs,
      Set(values).count == values.count,
      values.allSatisfy({ $0.range(of: "^attachment-upload-v1:[0-9a-f]{64}:[0-9a-f-]{36}$", options: .regularExpression) != nil }) else {
      throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_JOURNAL_INVALID")
    }
    return values
  }
  private func writeIndex(_ scope: String, _ values: [String]) throws {
    let bytes = try JSONSerialization.data(withJSONObject: values, options: [.sortedKeys])
    try io.writeRecord(scope, indexRecord, bytes)
    guard try io.readRecord(scope, indexRecord) == bytes else { throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_PERSISTENCE_UNCONFIRMED") }
  }
  private func ensureNoOtherActive(scope: String, record: String) throws {
    for key in try index(scope) where key != record {
      guard let other = try load(scope: scope, record: key) else { throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_JOURNAL_INVALID") }
      guard other.state != "uploading" && other.state != "paused" else { throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_BUSY") }
    }
  }

  private func projection(_ job: Job) -> [String: Any] {
    ["kind": "attachment-upload", "localId": job.localId, "targetId": job.targetId,
     "identityKey": job.identityKey, "agentId": job.agentId, "uploadId": job.uploadId,
     "state": job.state, "receivedBytes": job.receivedBytes, "totalBytes": job.totalBytes,
     "assetId": nullValue(job.assetId), "errorCode": nullValue(job.errorCode)]
  }
  private func nullValue(_ value: String?) -> Any { value.map { $0 as Any } ?? NSNull() }
  private func emit(_ job: Job) { onChanged(projection(job)) }
  private func recordName(_ identity: String, _ localId: String) -> String { "attachment-upload-v1:\(identity):\(localId)" }
  private func isCanonicalUuid(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
  private func strictInteger(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber else { return nil }
    let type = String(cString: number.objCType)
    guard ["s", "i", "l", "q"].contains(type) else { return nil }
    return Int(number.stringValue)
  }
  private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

  private static let jobFields: Set<String> = ["version", "record", "localId", "targetId", "identityKey", "agentId", "uploadId", "name", "mimeType", "totalBytes", "sha256", "receivedBytes", "state", "assetId", "errorCode"]
}
