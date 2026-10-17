import ExpoModulesCore
import Foundation
import UIKit

public final class MoxBotsRemoteModule: Module {
  private let queue = DispatchQueue(label: "com.moxbots.mobile.remote.owner", qos: .userInitiated)
  private let requestSlots = DispatchSemaphore(value: 8)
  private var connection: NativeConnection?
  private var ownerActive = true // owner queue only
  private let lifecycleLock = NSLock()
  private var destroyed = false
  private var appForeground = true
  private var artifactPresentationFence = 0 // protected by lifecycleLock
  private var backgroundObserver: NSObjectProtocol?
  private var uploads: NativeUploadScheduler? // owner queue only
  private var artifactDownloads: NativeArtifactScheduler? // owner queue only
  private var artifactScope: String?
  private var attachmentPicker: NativeAttachmentPicker? // main-thread owned
  private lazy var speech = NativeSpeech { [weak self] event in
    self?.sendEvent("speechChanged", event.projection)
  }

  public func definition() -> ModuleDefinition {
    Name("MoxBotsRemote")
    Events("snapshotChanged", "speechChanged", "attachmentUploadChanged", "artifactDownloadChanged")
    OnCreate { [weak self] in
      self?.backgroundObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
      ) { [weak self] _ in
        guard let self else { return }
        self.lifecycleLock.lock(); self.appForeground = false; self.lifecycleLock.unlock()
        self.bumpArtifactPresentationFence()
        DispatchQueue.main.async { [weak self] in self?.speech.cancel() }
        self?.queue.async { [weak self] in
          self?.uploads?.pause("MOBILE_ATTACHMENT_UPLOAD_PAUSED")
          self?.artifactDownloads?.pause()
          _ = try? self?.connection?.request("{\"version\":1,\"kind\":\"connection.suspend\"}")
        }
      }
    }
    AsyncFunction("request") { [weak self] (input: String, promise: Promise) in
      guard let self else { promise.resolve(Self.failure("MOBILE_CONNECTION_UNAVAILABLE")); return }
      if let bytes = input.data(using: .utf8), bytes.count <= 64 * 1024,
        let intent = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
        let kind = intent["kind"] as? String, kind.hasPrefix("speech.") {
        guard intent.count == 2, intent["version"] as? Int == 1 else {
          promise.resolve(Self.failure("MOBILE_INTENT_INVALID")); return
        }
        DispatchQueue.main.async { self.handleSpeech(kind, promise: promise) }
        return
      }
      if let bytes = input.data(using: .utf8), bytes.count <= 64 * 1024,
        let intent = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
        let kind = intent["kind"] as? String, kind.hasPrefix("attachment.") {
        self.handleAttachmentIntent(intent, promise: promise); return
      }
      if let bytes = input.data(using: .utf8), bytes.count <= 64 * 1024,
        let intent = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
        let kind = intent["kind"] as? String, kind.hasPrefix("artifact.") {
        self.handleArtifactIntent(intent, promise: promise); return
      }
      self.enqueue(promise) {
        do {
          let intent = (try? JSONSerialization.jsonObject(with: Data(input.utf8))) as? [String: Any]
          let kind = intent?["kind"] as? String
          if ["account.login.start", "account.login.poll", "account.logout", "connection.suspend"].contains(kind ?? "") {
            self.bumpArtifactPresentationFence()
            self.uploads?.pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED")
            self.artifactDownloads?.pause()
            self.artifactScope = nil
          }
          if ["session", "mobile", "assets"].contains(kind ?? ""), let intent {
            self.bumpArtifactPresentationFence()
            if let targetId = intent["targetId"] as? String, !targetId.isEmpty { self.uploads?.pauseForTarget(targetId) }
            if let targetId = intent["targetId"] as? String, !targetId.isEmpty { self.artifactDownloads?.pauseForTarget(targetId) }
            let request = intent["request"] as? [String: Any]
            if (request?["kind"] as? String) == "stop" {
              self.uploads?.pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED")
              if let session = request?["sessionId"] as? String, !session.isEmpty { self.artifactDownloads?.pauseForSession(session) }
            }
          }
          if kind == "targets.list" { self.bumpArtifactPresentationFence() }
          let response = try self.ensureConnection().request(input)
          switch kind {
          case "targets.list":
            do {
              let scope = try self.accountScope()
              if let data = response.data(using: .utf8),
                let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                let items = value["items"] as? [[String: Any]] {
                self.uploads?.validateTargets(scope: scope, items: items)
                self.artifactDownloads?.validateTargets(items)
              } else { self.uploads?.pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED"); self.artifactDownloads?.pause() }
            } catch { self.uploads?.pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED"); self.artifactDownloads?.pause() }
          case "account.status":
            do {
              let liveScope = try self.accountScope()
              self.uploads?.pauseUnlessScope(liveScope)
              if self.artifactScope != nil && self.artifactScope != liveScope { self.bumpArtifactPresentationFence(); self.artifactDownloads?.pause(); self.artifactScope = nil }
            } catch {
              self.bumpArtifactPresentationFence()
              self.uploads?.pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED"); self.artifactDownloads?.pause(); self.artifactScope = nil
            }
          default: break
          }
          promise.resolve(response)
        } catch let error as NativeFailure { promise.resolve(Self.failure(error.code)) }
        catch { promise.resolve(Self.failure("MOBILE_CONNECTION_UNAVAILABLE")) }
      }
    }
    OnDestroy { [weak self] in
      guard let self else { return }
      self.lifecycleLock.lock(); self.destroyed = true; self.lifecycleLock.unlock()
      if let observer = self.backgroundObserver { NotificationCenter.default.removeObserver(observer) }
      DispatchQueue.main.async { self.speech.cancel(); self.attachmentPicker?.cancel(); self.attachmentPicker = nil }
      self.queue.async {
        self.ownerActive = false
        self.uploads?.pause("MOBILE_ATTACHMENT_UPLOAD_PAUSED")
        self.artifactDownloads?.pause()
        self.connection?.close(); self.connection = nil; self.uploads = nil
      }
    }
  }
  private func enqueue(_ promise: Promise, work: @escaping () -> Void) {
    guard requestSlots.wait(timeout: .now()) == .success else {
      promise.resolve(Self.failure("MOBILE_BUSY")); return
    }
    queue.async {
      defer { self.requestSlots.signal() }
      work()
    }
  }
  private func ensureConnection() throws -> NativeConnection {
    guard ownerActive else { throw NativeFailure("MOBILE_CONNECTION_UNAVAILABLE") }
    if connection == nil {
      connection = try NativeConnection(
        origin: Bundle.main.object(forInfoDictionaryKey: "MoxBotsServiceOrigin") as? String ?? "https://140.143.183.232",
        bundle: Bundle.main.bundleIdentifier ?? "com.moxbots.mobile.internal")
    }
    guard let connection else { throw NativeFailure("MOBILE_CONNECTION_UNAVAILABLE") }
    return connection
  }
  private func accountScope() throws -> String {
    let raw = try ensureConnection().request("{\"version\":1,\"kind\":\"account.status\"}")
    guard let data = raw.data(using: .utf8),
      let account = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      account["kind"] as? String == "account", account["state"] as? String == "signed-in",
      let principal = account["principalId"] as? String, !principal.isEmpty, principal.utf8.count <= 256 else {
      throw NativeFailure("MOBILE_AUTHORIZATION_REQUIRED")
    }
    return (Bundle.main.object(forInfoDictionaryKey: "MoxBotsServiceOrigin") as? String ?? "https://140.143.183.232") + "\u{0}" + principal
  }
  private func attachmentOwner(_ scope: String) throws -> NativeAttachments {
    try NativeAttachments(scope: scope, bundle: Bundle.main.bundleIdentifier ?? "com.moxbots.mobile.internal")
  }
  private func resolve(_ value: [String: Any], promise: Promise) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: value), let text = String(data: bytes, encoding: .utf8) else {
      promise.resolve(Self.failure("MOBILE_ATTACHMENT_RESPONSE_INVALID")); return
    }
    promise.resolve(text)
  }
  private func handleAttachmentIntent(_ intent: [String: Any], promise: Promise) {
    guard intent["version"] as? Int == 1, let kind = intent["kind"] as? String else {
      promise.resolve(Self.failure("MOBILE_INTENT_INVALID")); return
    }
    let isUpload = ["attachment.upload", "attachment.upload.status", "attachment.upload.cancel", "attachment.upload.pause"].contains(kind)
    let localId = intent["localId"] as? String ?? ""
    let targetId = intent["targetId"] as? String ?? ""
    let valid = (kind == "attachment.list" && intent.count == 2)
      || (kind == "attachment.pick" && intent.count == 3 && ["file", "image"].contains(intent["source"] as? String ?? ""))
      || (kind == "attachment.remove" && intent.count == 3 && (intent["localId"] as? String)?.count == 36)
      || (isUpload && intent.count == 4 && UUID(uuidString: localId)?.uuidString.lowercased() == localId
        && targetId.range(of: "^[A-Za-z0-9._:-]{1,256}$", options: .regularExpression) != nil)
    guard valid else { promise.resolve(Self.failure("MOBILE_INTENT_INVALID")); return }
    if isUpload && UIApplication.shared.applicationState != .active {
      promise.resolve(Self.failure("MOBILE_ATTACHMENT_UPLOAD_FOREGROUND_REQUIRED")); return
    }
    if isUpload {
      lifecycleLock.lock(); appForeground = true; lifecycleLock.unlock()
    }
    enqueue(promise) {
      do {
        let scope = try self.accountScope()
        if isUpload {
          let scheduler = try self.uploadScheduler(scope: scope)
          scheduler.pauseUnlessScope(scope)
          let raw = try self.ensureConnection().request("{\"version\":1,\"kind\":\"targets.list\"}")
          guard let data = raw.data(using: .utf8), let catalog = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let items = catalog["items"] as? [[String: Any]],
            let value = items.first(where: { $0["targetId"] as? String == targetId }),
            let identityKey = value["identityKey"] as? String, let agentId = value["agentId"] as? String else {
            throw NativeFailure("MOBILE_TARGET_INVALID")
          }
          let target = NativeUploadTarget(targetId: targetId, identityKey: identityKey, agentId: agentId)
          scheduler.validateTargets(scope: scope, items: items)
          scheduler.pauseForTarget(targetId)
          let projection: [String: Any]
          switch kind {
          case "attachment.upload": projection = try scheduler.start(scope: scope, target: target, localId: localId)
          case "attachment.upload.status": projection = try scheduler.status(scope: scope, target: target, localId: localId)
          case "attachment.upload.cancel": projection = try scheduler.cancel(scope: scope, target: target, localId: localId)
          default: projection = try scheduler.pause(scope: scope, target: target, localId: localId)
          }
          self.resolve(projection, promise: promise)
        }
        else if kind == "attachment.list" { self.resolve(try self.attachmentOwner(scope).list(), promise: promise) }
        else if kind == "attachment.remove", let id = intent["localId"] as? String {
          let scheduler = try self.uploadScheduler(scope: scope)
          let active = try scheduler.blocksRemoval(scope: scope, localId: id)
          guard !active else { throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_ACTIVE") }
          try scheduler.clearRemovedSource(scope: scope, localId: id)
          self.resolve(try self.attachmentOwner(scope).remove(id), promise: promise)
        } else {
          DispatchQueue.main.async {
            guard self.attachmentPicker == nil else { promise.resolve(Self.failure("MOBILE_ATTACHMENT_PICKER_BUSY")); return }
            self.attachmentPicker = NativeAttachmentPicker(importer: { [weak self] url, image, name in
              guard let self else { throw NativeFailure("MOBILE_ATTACHMENT_CANCELLED") }
              return try self.queue.sync {
                guard try self.accountScope() == scope else { throw NativeFailure("MOBILE_ACCOUNT_CHANGED") }
                let files = try self.attachmentOwner(scope)
                let picked = try files.importPicked(url, image: image, suggestedName: name)
                guard try self.accountScope() == scope else {
                  if let id = picked["localId"] as? String { _ = try? files.remove(id) }
                  throw NativeFailure("MOBILE_ACCOUNT_CHANGED")
                }
                return picked
              }
            }, completion: { result in
              self.attachmentPicker = nil
              switch result {
              case .success(let value): self.resolve(value, promise: promise)
              case .failure(let error): promise.resolve(Self.failure((error as? NativeFailure)?.code ?? "MOBILE_ATTACHMENT_UNAVAILABLE"))
              }
            })
            self.attachmentPicker?.present(image: intent["source"] as? String == "image")
          }
        }
      } catch let error as NativeFailure { promise.resolve(Self.failure(error.code)) }
      catch { promise.resolve(Self.failure("MOBILE_ATTACHMENT_UNAVAILABLE")) }
    }
  }
  private func uploadScheduler(scope: String) throws -> NativeUploadScheduler {
    if let uploads { return uploads }
    let records = SecureRecords(bundle: Bundle.main.bundleIdentifier ?? "com.moxbots.mobile.internal")
    let scheduler = NativeUploadScheduler(
      io: .init(
        readRecord: { try records.read(scope: $0, record: $1) },
        writeRecord: { try records.write(scope: $0, record: $1, bytes: $2) },
        removeRecord: { try records.remove(scope: $0, record: $1) },
        source: { scope, localId in
          let owner = try NativeAttachments(scope: scope, bundle: Bundle.main.bundleIdentifier ?? "com.moxbots.mobile.internal")
          let listed = try owner.list()
          guard let items = listed["items"] as? [[String: Any]],
            let value = items.first(where: { $0["localId"] as? String == localId }),
            let name = value["name"] as? String, let mime = value["mimeType"] as? String,
            let size = value["sizeBytes"] as? Int, let sha = value["sha256"] as? String else { return nil }
          return NativeUploadSource(localId: localId, name: name, mimeType: mime, sizeBytes: size, sha256: sha)
        },
        readChunk: { scope, localId, offset in
          let (metadata, bytes) = try NativeAttachments(scope: scope, bundle: Bundle.main.bundleIdentifier ?? "com.moxbots.mobile.internal")
            .readChunk(localId, offset: offset)
          guard let name = metadata["name"] as? String, let mime = metadata["mimeType"] as? String,
            let size = metadata["sizeBytes"] as? Int, let sha = metadata["sha256"] as? String else {
            throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_SOURCE_INVALID")
          }
          return NativeUploadChunk(source: NativeUploadSource(localId: localId, name: name, mimeType: mime,
            sizeBytes: size, sha256: sha), bytes: bytes)
        },
        request: { _, request in
          let raw = try self.ensureConnection().request(String(data: try JSONSerialization.data(withJSONObject: request), encoding: .utf8)!)
          guard let data = raw.data(using: .utf8), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NativeFailure("MOBILE_ATTACHMENT_UPLOAD_RESPONSE_INVALID")
          }
          return value
        }),
      schedule: { [weak self] next in self?.queue.async(execute: next) },
      allowed: { [weak self] in self?.uploadAllowed() ?? false },
      onChanged: { [weak self] event in
        guard let self, self.uploadAllowed() else { return }
        self.sendEvent("attachmentUploadChanged", event)
      })
    uploads = scheduler
    return scheduler
  }
  private func uploadAllowed() -> Bool {
    lifecycleLock.lock(); defer { lifecycleLock.unlock() }
    return !destroyed && appForeground
  }
  private func handleArtifactIntent(_ intent: [String: Any], promise: Promise) {
    guard let kind = intent["kind"] as? String, NativeArtifactInteger.value(intent["version"]) == 1 else {
      promise.resolve(Self.failure("MOBILE_INTENT_INVALID")); return
    }
    let targetId = intent["targetId"] as? String ?? ""
    let session = intent["sessionId"] as? String ?? ""
    let artifactId = intent["artifactId"] as? String ?? ""
    let pageLimit = NativeArtifactInteger.value(intent["limit"])
    let validShape: Bool
    switch kind {
    case "artifact.list":
      validShape = Set(intent.keys) == Set(intent["before"] == nil ? ["version", "kind", "targetId", "sessionId", "limit"] : ["version", "kind", "targetId", "sessionId", "limit", "before"]) && pageLimit != nil && (intent["before"] == nil || intent["before"] is String)
    case "artifact.download": validShape = Set(intent.keys) == Set(["version", "kind", "targetId", "sessionId", "artifact"]) && intent["artifact"] as? [String: Any] != nil
    case "artifact.status", "artifact.pause", "artifact.remove", "artifact.preview", "artifact.share":
      validShape = Set(intent.keys) == Set(["version", "kind", "targetId", "sessionId", "artifactId"]) && UUID(uuidString: artifactId)?.uuidString.lowercased() == artifactId
    default: validShape = false
    }
    guard validShape, targetId.range(of: "^[A-Za-z0-9._:-]{1,256}$", options: .regularExpression) != nil,
      session.range(of: "^[A-Za-z0-9-]{1,99}$", options: .regularExpression) != nil else {
      promise.resolve(Self.failure("MOBILE_INTENT_INVALID")); return
    }
    lifecycleLock.lock(); let foreground = !destroyed && appForeground; lifecycleLock.unlock()
    guard foreground, UIApplication.shared.applicationState == .active else { promise.resolve(Self.failure("MOBILE_ARTIFACT_FOREGROUND_REQUIRED")); return }
    lifecycleLock.lock(); appForeground = true; lifecycleLock.unlock()
    bumpArtifactPresentationFence()
    enqueue(promise) {
      do {
        let scope = try self.accountScope()
        let targetAndItems: (NativeArtifactTarget, [[String: Any]])
        do { targetAndItems = try self.currentArtifactTarget(targetId) }
        catch { self.artifactDownloads?.pause(); throw error }
        let (target, items) = targetAndItems
        self.artifactDownloads?.validateTargets(items)
        self.artifactDownloads?.pauseForTarget(targetId)
        let scheduler = try self.artifactScheduler(scope: scope)
        let result: [String: Any]
        switch kind {
        case "artifact.list":
          guard let pageLimit else { throw NativeFailure("MOBILE_INTENT_INVALID") }
          result = try scheduler.list(target: target, session: session, limit: pageLimit, before: intent["before"] as? String)
        case "artifact.download":
          guard let value = intent["artifact"] as? [String: Any] else { throw NativeFailure("MOBILE_INTENT_INVALID") }
          result = try scheduler.download(target: target, session: session, descriptor: try Self.parseArtifactDescriptor(value))
        case "artifact.status": result = try scheduler.status(target: target, session: session, id: artifactId)
        case "artifact.pause": result = try scheduler.pause(target: target, session: session, id: artifactId)
        case "artifact.remove": result = try scheduler.remove(target: target, session: session, id: artifactId)
        default:
          let ready = try scheduler.readyFile(target: target, session: session, id: artifactId)
          guard try self.accountScope() == scope, self.artifactScope == scope else { throw NativeFailure("MOBILE_ACCOUNT_CHANGED") }
          let presentationFence = self.artifactPresentationToken()
          DispatchQueue.main.async {
            do {
              self.lifecycleLock.lock(); let alive = !self.destroyed && self.appForeground; self.lifecycleLock.unlock()
              guard alive, self.artifactScope == scope, self.artifactPresentationToken() == presentationFence,
                UIApplication.shared.applicationState == .active else { throw NativeFailure("MOBILE_ACCOUNT_CHANGED") }
              try NativeArtifactPresenter.present(ready, share: kind == "artifact.share")
              self.resolveArtifactAction(kind, target: target, session: session, id: artifactId, promise: promise)
            } catch let error as NativeFailure { promise.resolve(Self.failure(error.code)) }
            catch { promise.resolve(Self.failure("MOBILE_ARTIFACT_UNAVAILABLE")) }
          }
          return
        }
        guard try self.accountScope() == scope else { throw NativeFailure("MOBILE_ACCOUNT_CHANGED") }
        self.resolve(result, promise: promise)
      } catch let error as NativeFailure {
        self.artifactDownloads?.pause()
        if Self.isArtifactAuthorityFailure(error.code) {
          self.bumpArtifactPresentationFence(); self.artifactDownloads?.pause(); self.artifactScope = nil
        }
        promise.resolve(Self.failure(error.code))
      }
      catch { self.artifactDownloads?.pause(); promise.resolve(Self.failure("MOBILE_ARTIFACT_UNAVAILABLE")) }
    }
  }
  private static func isArtifactAuthorityFailure(_ code: String) -> Bool {
    code.hasPrefix("ACCOUNT_") || code.hasPrefix("TARGET_") || code.hasPrefix("HOST_MANAGEMENT_") ||
      ["MOBILE_AUTHORIZATION_REQUIRED", "MOBILE_ACCOUNT_CHANGED"].contains(code)
  }
  private func currentArtifactTarget(_ targetId: String) throws -> (NativeArtifactTarget, [[String: Any]]) {
    let raw = try ensureConnection().request("{\"version\":1,\"kind\":\"targets.list\"}")
    guard let data = raw.data(using: .utf8), let result = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let items = result["items"] as? [[String: Any]],
      let value = items.first(where: { $0["targetId"] as? String == targetId }),
      let identity = value["identityKey"] as? String, let agent = value["agentId"] as? String else { throw NativeFailure("MOBILE_TARGET_INVALID") }
    let target = NativeArtifactTarget(targetId: targetId, identityKey: identity, agentId: agent)
    try NativeArtifactScheduler.validateTarget(target)
    return (target, items)
  }
  private func artifactScheduler(scope: String) throws -> NativeArtifactScheduler {
    if artifactScope == scope, let artifactDownloads { return artifactDownloads }
    artifactDownloads?.pause()
    let bundle = Bundle.main.bundleIdentifier ?? "com.moxbots.mobile.internal"
    let cache = try NativeArtifactCache(scope: scope, bundle: bundle)
    let scheduler = NativeArtifactScheduler(cache: cache, scope: scope, io: .init(
      request: { targetId, request in
        var envelope: [String: Any] = ["version": 1, "kind": "assets", "targetId": targetId, "request": request]
        let raw = try self.ensureConnection().request(String(data: try JSONSerialization.data(withJSONObject: envelope), encoding: .utf8)!)
        guard let data = raw.data(using: .utf8), let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NativeFailure("MOBILE_ARTIFACT_RESPONSE_INVALID") }
        return value
      },
      schedule: { [weak self] next in self?.queue.async(execute: next) },
      allowed: { [weak self] in guard let self else { return false }; self.lifecycleLock.lock(); defer { self.lifecycleLock.unlock() }; return !self.destroyed && self.appForeground && self.artifactScope == scope },
      onChanged: { [weak self] event in guard let self, self.artifactScope == scope, self.ownerActive else { return }; self.sendEvent("artifactDownloadChanged", event) }
    ))
    artifactScope = scope; artifactDownloads = scheduler
    return scheduler
  }
  private static func parseArtifactDescriptor(_ value: [String: Any]) throws -> NativeArtifactDescriptor {
    guard Set(value.keys) == Set(["artifactId", "name", "mimeType", "sizeBytes", "sha256"]),
      let id = value["artifactId"] as? String, let name = value["name"] as? String,
      let mime = value["mimeType"] as? String, let size = NativeArtifactInteger.value(value["sizeBytes"]),
      let hash = value["sha256"] as? String else { throw NativeFailure("MOBILE_INTENT_INVALID") }
    let descriptor = NativeArtifactDescriptor(artifactId: id, name: name, mimeType: mime, sizeBytes: size, sha256: hash)
    try NativeArtifactScheduler.validateDescriptor(descriptor)
    return descriptor
  }
  private func resolveArtifactAction(_ kind: String, target: NativeArtifactTarget, session: String, id: String, promise: Promise) {
    resolve(["kind": "artifact-action", "action": kind.replacingOccurrences(of: "artifact.", with: ""),
      "targetId": target.targetId, "identityKey": target.identityKey, "agentId": target.agentId,
      "sessionId": session, "artifactId": id, "state": "presented", "errorCode": NSNull()], promise: promise)
  }
  private func bumpArtifactPresentationFence() {
    lifecycleLock.lock(); artifactPresentationFence &+= 1; lifecycleLock.unlock()
  }
  private func artifactPresentationToken() -> Int {
    lifecycleLock.lock(); defer { lifecycleLock.unlock() }; return artifactPresentationFence
  }
  private func handleSpeech(_ kind: String, promise: Promise) {
    if kind == "speech.start", UIApplication.shared.applicationState != .active {
      promise.resolve(Self.failure("MOBILE_SPEECH_FOREGROUND_REQUIRED")); return
    }
    let settle: (Result<Void, NativeSpeech.Failure>) -> Void = { [weak self] result in
      switch result {
      case .success:
        guard let self, let data = try? JSONSerialization.data(withJSONObject: self.speech.current.projection),
          let text = String(data: data, encoding: .utf8) else {
          promise.resolve(Self.failure("MOBILE_SPEECH_RESPONSE_INVALID")); return
        }
        promise.resolve(text)
      case .failure(let error): promise.resolve(Self.failure(error.code))
      }
    }
    switch kind {
    case "speech.start": speech.start(completion: settle)
    case "speech.stop": speech.stop(completion: settle)
    case "speech.cancel": speech.cancel(); settle(.success(()))
    default: promise.resolve(Self.failure("MOBILE_INTENT_UNSUPPORTED"))
    }
  }
  private static func failure(_ code: String) -> String { "{\"kind\":\"error\",\"code\":\"\(code)\"}" }
}
