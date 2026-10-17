package com.moxbots.mobile.remote

import android.content.pm.PackageManager
import android.app.Activity
import android.content.Intent
import android.os.Handler
import android.os.Looper
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import expo.modules.interfaces.permissions.PermissionsResponseListener
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

class MoxBotsRemoteModule : Module() {
  private val owner = Executors.newSingleThreadExecutor()
  private val pendingRequests = AtomicInteger(0)
  private val main = Handler(Looper.getMainLooper())
  private var connection: NativeConnection? = null
  @Volatile private var ownerActive = true
  @Volatile private var appForeground = true
  private var speech: NativeSpeech? = null
  private var uploads: NativeUploadScheduler? = null // owner-thread only
  private var artifactDownloads: NativeArtifactScheduler? = null // owner-thread only
  @Volatile private var artifactScope: String? = null
  private val artifactPresentationFence = AtomicLong(0)
  private data class Picker(val scope: String, val image: Boolean, val promise: Promise)
  private var picker: Picker? = null // main-thread owned
  private val pickerCode = 0x4d58
  override fun definition() = ModuleDefinition {
    Name("MoxBotsRemote")
    Events("snapshotChanged", "speechChanged", "attachmentUploadChanged", "artifactDownloadChanged")
    AsyncFunction("request") { input: String, promise: Promise ->
      val intent = try { if (input.toByteArray(Charsets.UTF_8).size <= 64 * 1024) JSONObject(input) else null } catch (_: Exception) { null }
      val kind = intent?.optString("kind")
      if (intent != null && kind != null && kind.startsWith("speech.")) {
        if (intent.length() != 2 || intent.optInt("version") != 1) {
          promise.resolve(failure("MOBILE_INTENT_INVALID"))
        } else main.post { handleSpeech(kind, promise) }
      } else if (intent != null && kind != null && kind.startsWith("attachment.")) {
        handleAttachmentIntent(intent, promise)
      } else if (intent != null && kind != null && kind.startsWith("artifact.")) {
        handleArtifactIntent(intent, promise)
      } else enqueue(promise) {
        try {
          val parsed = intent
          val parsedKind = parsed?.optString("kind")
          if (parsedKind in setOf("account.login.start", "account.login.poll", "account.logout", "connection.suspend")) {
            artifactPresentationFence.incrementAndGet()
            uploads?.pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED")
            artifactDownloads?.pause()
            artifactScope = null
          }
          if (parsedKind in setOf("session", "mobile", "assets")) {
            artifactPresentationFence.incrementAndGet()
            val targetId = parsed?.optString("targetId").orEmpty()
            if (targetId.isNotBlank()) uploads?.pauseForTarget(targetId)
            if (targetId.isNotBlank()) artifactDownloads?.pauseForTarget(targetId)
            val innerKind = parsed?.optJSONObject("request")?.optString("kind")
            if (innerKind == "stop") {
              uploads?.pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED")
              val innerSession = parsed?.optJSONObject("request")?.optString("sessionId").orEmpty()
              if (innerSession.isNotEmpty()) artifactDownloads?.pauseForSession(innerSession)
            }
          }
          if (parsedKind == "targets.list") artifactPresentationFence.incrementAndGet()
          val response = ensureConnection().request(input)
          when (parsedKind) {
            "targets.list" -> runCatching {
              val scope = accountScope()
              val items = JSONObject(response).getJSONArray("items")
              uploads?.validateTargets(scope, items)
              artifactDownloads?.validateTargets(items)
            }.onFailure { uploads?.pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED"); artifactDownloads?.pause() }
            "account.status" -> runCatching {
              val liveScope = accountScope()
              uploads?.pauseUnlessScope(liveScope)
              if (artifactScope != null && artifactScope != liveScope) { artifactPresentationFence.incrementAndGet(); artifactDownloads?.pause(); artifactScope = null }
            }.onFailure {
              artifactPresentationFence.incrementAndGet()
              uploads?.pause("MOBILE_ATTACHMENT_UPLOAD_SCOPE_CHANGED"); artifactDownloads?.pause(); artifactScope = null
            }
          }
          promise.resolve(response)
        } catch (_: Exception) { promise.resolve(failure("MOBILE_CONNECTION_UNAVAILABLE")) }
      }
    }
    OnActivityResult { _, result ->
      if (result.requestCode == pickerCode) {
        val pending = picker
        picker = null
        if (pending != null) {
          val uri = result.data?.data
          if (result.resultCode != Activity.RESULT_OK || uri == null) {
            pending.promise.resolve(failure("MOBILE_ATTACHMENT_CANCELLED"))
          } else if (!ownerActive || owner.isShutdown) pending.promise.resolve(failure("MOBILE_ATTACHMENT_CANCELLED"))
          else enqueue(pending.promise) {
            try {
              check(accountScope() == pending.scope) { "MOBILE_ACCOUNT_CHANGED" }
              val context = requireNotNull(appContext.reactContext)
              val files = NativeAttachments(context, pending.scope)
              val picked = files.importPicked(uri, pending.image)
              if (accountScope() != pending.scope) {
                files.remove(picked.getString("localId"))
                error("MOBILE_ACCOUNT_CHANGED")
              }
              pending.promise.resolve(picked.toString())
            } catch (error: Exception) { pending.promise.resolve(failure(attachmentError(error))) }
          }
        }
      }
    }
    OnActivityEntersBackground {
      appForeground = false
      artifactPresentationFence.incrementAndGet()
      main.post { speech?.cancel() }
      owner.execute {
        try { uploads?.pause("MOBILE_ATTACHMENT_UPLOAD_PAUSED") } catch (_: Exception) { }
        try { artifactDownloads?.pause() } catch (_: Exception) { }
        try { connection?.request("{\"version\":1,\"kind\":\"connection.suspend\"}") } catch (_: Exception) { }
      }
    }
    OnDestroy {
      ownerActive = false
      appForeground = false
      main.post {
        speech?.cancel(); speech = null
        picker?.promise?.resolve(failure("MOBILE_ATTACHMENT_CANCELLED")); picker = null
      }
      owner.execute {
        try { uploads?.pause("MOBILE_ATTACHMENT_UPLOAD_PAUSED") } catch (_: Exception) { }
        try { artifactDownloads?.pause() } catch (_: Exception) { }
        try { connection?.close() } catch (_: Exception) { }
        connection = null; uploads = null
      }
      owner.shutdown()
    }
  }
  private fun enqueue(promise: Promise, work: () -> Unit) {
    if (!ownerActive || owner.isShutdown) { promise.resolve(failure("MOBILE_CONNECTION_UNAVAILABLE")); return }
    if (pendingRequests.incrementAndGet() > 8) {
      pendingRequests.decrementAndGet(); promise.resolve(failure("MOBILE_BUSY")); return
    }
    try {
      owner.execute {
        try { work() } finally { pendingRequests.decrementAndGet() }
      }
    } catch (_: RejectedExecutionException) {
      pendingRequests.decrementAndGet(); promise.resolve(failure("MOBILE_CONNECTION_UNAVAILABLE"))
    }
  }
  private fun ensureConnection(): NativeConnection {
    check(ownerActive) { "MOBILE_CONNECTION_UNAVAILABLE" }
    if (connection == null) {
      val context = requireNotNull(appContext.reactContext)
      val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
      val origin = info.metaData?.getString("com.moxbots.mobile.SERVICE_ORIGIN") ?: "https://140.143.183.232"
      connection = NativeConnection(context, origin)
    }
    return requireNotNull(connection)
  }
  /** Scope comes from the authenticated native account, never caller JSON. */
  private fun accountScope(): String {
    val account = JSONObject(ensureConnection().request("{\"version\":1,\"kind\":\"account.status\"}"))
    check(account.optString("kind") == "account" && account.optString("state") == "signed-in") { "MOBILE_AUTHORIZATION_REQUIRED" }
    val principal = account.getString("principalId")
    check(principal.isNotBlank() && principal.length <= 256) { "MOBILE_AUTHORIZATION_REQUIRED" }
    val context = requireNotNull(appContext.reactContext)
    val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
    return (info.metaData?.getString("com.moxbots.mobile.SERVICE_ORIGIN") ?: "https://140.143.183.232") + "\u0000" + principal
  }
  private fun handleAttachmentIntent(intent: JSONObject, promise: Promise) {
    val kind = intent.optString("kind")
    val valid = intent.optInt("version") == 1 && when (kind) {
      "attachment.pick" -> intent.length() == 3 && intent.optString("source") in setOf("file", "image")
      "attachment.list" -> intent.length() == 2
      "attachment.remove" -> intent.length() == 3 && intent.optString("localId").length == 36
      "attachment.upload", "attachment.upload.status", "attachment.upload.cancel", "attachment.upload.pause" ->
        intent.length() == 4 && isCanonicalUuid(intent.optString("localId")) &&
          intent.optString("targetId").matches(Regex("[A-Za-z0-9._:-]{1,256}"))
      else -> false
    }
    if (!valid) { promise.resolve(failure("MOBILE_INTENT_INVALID")); return }
    if (kind.startsWith("attachment.upload") && (appContext.currentActivity?.hasWindowFocus() != true)) {
      promise.resolve(failure("MOBILE_ATTACHMENT_UPLOAD_FOREGROUND_REQUIRED")); return
    }
    if (kind.startsWith("attachment.upload")) appForeground = true
    enqueue(promise) {
      try {
        val scope = accountScope()
        val context = requireNotNull(appContext.reactContext)
        if (kind.startsWith("attachment.upload")) {
          val scheduler = uploadScheduler(scope, context)
          scheduler.pauseUnlessScope(scope)
          val (target, targetItems) = currentUploadTarget(intent.getString("targetId"))
          scheduler.validateTargets(scope, targetItems)
          scheduler.pauseForTarget(target.targetId)
          val localId = intent.getString("localId")
          val projection = when (kind) {
            "attachment.upload" -> scheduler.start(scope, target, localId)
            "attachment.upload.status" -> scheduler.status(scope, target, localId)
            "attachment.upload.cancel" -> scheduler.cancel(scope, target, localId)
            else -> scheduler.pause(scope, target, localId)
          }
          promise.resolve(projection.toString())
          return@enqueue
        }
        when (kind) {
          "attachment.list" -> promise.resolve(NativeAttachments(context, scope).list().toString())
          "attachment.remove" -> {
            val localId = intent.getString("localId")
            val scheduler = uploadScheduler(scope, context)
            check(!scheduler.blocksRemoval(scope, localId)) { "MOBILE_ATTACHMENT_UPLOAD_ACTIVE" }
            scheduler.clearRemovedSource(scope, localId)
            promise.resolve(NativeAttachments(context, scope).remove(localId).toString())
          }
          else -> main.post {
            val activity = appContext.currentActivity
            if (activity == null || activity.isFinishing || !activity.hasWindowFocus()) {
              promise.resolve(failure("MOBILE_ATTACHMENT_FOREGROUND_REQUIRED"))
            } else if (picker != null) promise.resolve(failure("MOBILE_ATTACHMENT_PICKER_BUSY"))
            else {
              val image = intent.getString("source") == "image"
              picker = Picker(scope, image, promise)
              try {
                @Suppress("DEPRECATION")
                activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                  addCategory(Intent.CATEGORY_OPENABLE)
                  type = if (image) "image/*" else "*/*"
                  putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
                  addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }, pickerCode)
              } catch (_: Exception) {
                picker = null; promise.resolve(failure("MOBILE_ATTACHMENT_PICKER_UNAVAILABLE"))
              }
            }
          }
        }
      } catch (error: Exception) { promise.resolve(failure(attachmentError(error))) }
    }
  }
  private fun attachmentError(error: Exception): String = error.message
    ?.takeIf { it.matches(Regex("MOBILE_[A-Z0-9_]{1,110}")) } ?: "MOBILE_ATTACHMENT_UNAVAILABLE"
  private fun currentUploadTarget(targetId: String): Pair<UploadTarget, org.json.JSONArray> {
    val items = JSONObject(ensureConnection().request("{\"version\":1,\"kind\":\"targets.list\"}"))
      .getJSONArray("items")
    val target = (0 until items.length()).mapNotNull { items.optJSONObject(it) }
      .firstOrNull { it.optString("targetId") == targetId }
      ?: error("MOBILE_TARGET_INVALID")
    return UploadTarget(targetId, target.getString("identityKey"), target.getString("agentId")) to items
  }
  private fun uploadScheduler(scope: String, context: android.content.Context): NativeUploadScheduler {
    uploads?.let { return it }
    val records = SecureRecords(context)
    val scheduler = NativeUploadScheduler(
      io = object : NativeUploadScheduler.IO {
        override fun readRecord(scope: String, name: String) = records.read(scope, name)
        override fun writeRecord(scope: String, name: String, bytes: ByteArray) = records.write(scope, name, bytes)
        override fun removeRecord(scope: String, name: String) = records.remove(scope, name)
        override fun source(scope: String, localId: String): UploadSource? {
          val items = NativeAttachments(context, scope).list().getJSONArray("items")
          val item = (0 until items.length()).mapNotNull { items.optJSONObject(it) }
            .firstOrNull { it.optString("localId") == localId } ?: return null
          return UploadSource(localId, item.getString("name"), item.getString("mimeType"), item.getLong("sizeBytes"), item.getString("sha256"))
        }
        override fun readChunk(scope: String, localId: String, offset: Long): UploadChunk {
          val (metadata, bytes) = NativeAttachments(context, scope).readChunk(localId, offset)
          val source = UploadSource(localId, metadata.getString("name"), metadata.getString("mimeType"),
            metadata.getLong("sizeBytes"), metadata.getString("sha256"))
          return UploadChunk(source, bytes)
        }
        override fun request(targetId: String, request: JSONObject) = ensureConnection().request(request.toString())
      },
      schedule = { next -> owner.execute(next) },
      allowed = { ownerActive && appForeground },
      onChanged = { event -> if (ownerActive) sendEvent("attachmentUploadChanged", uploadEventProjection(event)) },
    )
    uploads = scheduler
    return scheduler
  }
  private fun uploadEventProjection(event: JSONObject): Map<String, Any?> = mapOf(
    "kind" to event.optString("kind"),
    "localId" to event.optString("localId"),
    "targetId" to event.optString("targetId"),
    "identityKey" to event.optString("identityKey"),
    "agentId" to event.optString("agentId"),
    "uploadId" to event.optString("uploadId"),
    "state" to event.optString("state"),
    "receivedBytes" to event.optLong("receivedBytes"),
    "totalBytes" to event.optLong("totalBytes"),
    "assetId" to event.opt("assetId").let { if (it == null || it === JSONObject.NULL) null else it },
    "errorCode" to event.opt("errorCode").let { if (it == null || it === JSONObject.NULL) null else it },
  )
  private fun handleArtifactIntent(intent: JSONObject, promise: Promise) {
    val kind = intent.optString("kind")
    val version = intent.opt("version")
    val targetId = intent.optString("targetId")
    val sessionId = intent.optString("sessionId")
    val id = intent.optString("artifactId")
    val shapeValid = when (kind) {
      "artifact.list" -> intent.keys().asSequence().toSet() == (if (intent.has("before")) setOf("version", "kind", "targetId", "sessionId", "limit", "before") else setOf("version", "kind", "targetId", "sessionId", "limit")) &&
        (intent.opt("limit") is Int || intent.opt("limit") is Long) && intent.optLong("limit", 0) in 1..30 && (!intent.has("before") || intent.opt("before") is String)
      "artifact.download" -> intent.keys().asSequence().toSet() == setOf("version", "kind", "targetId", "sessionId", "artifact") && intent.optJSONObject("artifact") != null
      "artifact.status", "artifact.pause", "artifact.remove", "artifact.preview", "artifact.share" ->
        intent.keys().asSequence().toSet() == setOf("version", "kind", "targetId", "sessionId", "artifactId") && isCanonicalUuid(id)
      else -> false
    }
    if (version !is Int || version != 1 || !shapeValid ||
      !targetId.matches(Regex("[A-Za-z0-9._:-]{1,256}")) || !sessionId.matches(Regex("[A-Za-z0-9-]{1,99}"))) {
      promise.resolve(failure("MOBILE_INTENT_INVALID")); return
    }
    if (appContext.currentActivity?.hasWindowFocus() != true) {
      promise.resolve(failure("MOBILE_ARTIFACT_FOREGROUND_REQUIRED")); return
    }
    appForeground = true
    artifactPresentationFence.incrementAndGet()
    enqueue(promise) {
      try {
        val scope = accountScope()
        val context = requireNotNull(appContext.reactContext)
        val (target, targetItems) = runCatching { currentArtifactTarget(targetId) }
          .onFailure { artifactDownloads?.pause() }.getOrThrow()
        artifactDownloads?.validateTargets(targetItems)
        artifactDownloads?.pauseForTarget(target.targetId)
        val scheduler = artifactScheduler(scope, context)
        val result = when (kind) {
          "artifact.list" -> scheduler.list(target, sessionId, intent.getLong("limit").toInt(), if (intent.has("before")) intent.getString("before") else null)
          "artifact.download" -> scheduler.download(target, sessionId, parseArtifactDescriptor(intent.getJSONObject("artifact")))
          "artifact.status" -> scheduler.status(target, sessionId, id)
          "artifact.pause" -> scheduler.pause(target, sessionId, id)
          "artifact.remove" -> scheduler.remove(target, sessionId, id)
          else -> {
            val readyFile = scheduler.readyFile(target, sessionId, id)
            check(accountScope() == scope && artifactScope == scope) { "MOBILE_ACCOUNT_CHANGED" }
            val presentationFence = artifactPresentationFence.get()
            main.post {
              try {
                check(ownerActive && artifactScope == scope && artifactPresentationFence.get() == presentationFence) { "MOBILE_ACCOUNT_CHANGED" }
                val activity = appContext.currentActivity
                check(activity != null && !activity.isFinishing && activity.hasWindowFocus()) { "MOBILE_ARTIFACT_FOREGROUND_REQUIRED" }
                check(artifactScope == scope) { "MOBILE_ACCOUNT_CHANGED" }
                NativeArtifactPresenter.present(activity, context.packageName + ".moxbots.artifacts",
                  context.contentResolver, readyFile, kind == "artifact.share")
                promise.resolve(JSONObject().put("kind", "artifact-action").put("action", kind.removePrefix("artifact."))
                  .put("targetId", target.targetId).put("identityKey", target.identityKey).put("agentId", target.agentId)
                  .put("sessionId", sessionId).put("artifactId", id).put("state", "presented").put("errorCode", JSONObject.NULL).toString())
              } catch (problem: Exception) { promise.resolve(failure(artifactError(problem))) }
            }
            return@enqueue
          }
        }
        promise.resolve(result.toString())
      } catch (error: Exception) {
        artifactDownloads?.pause()
        if (isArtifactAuthorityFailure(artifactError(error))) {
          artifactPresentationFence.incrementAndGet(); artifactDownloads?.pause(); artifactScope = null
        }
        promise.resolve(failure(artifactError(error)))
      }
    }
  }
  private fun currentArtifactTarget(targetId: String): Pair<ArtifactTarget, org.json.JSONArray> {
    val items = JSONObject(ensureConnection().request("{\"version\":1,\"kind\":\"targets.list\"}"))
      .getJSONArray("items")
    val target = (0 until items.length()).mapNotNull { items.optJSONObject(it) }
      .firstOrNull { it.opt("targetId") is String && it.optString("targetId") == targetId } ?: error("MOBILE_TARGET_INVALID")
    check(target.opt("identityKey") is String && target.opt("agentId") is String) { "MOBILE_TARGET_INVALID" }
    val value = ArtifactTarget(targetId, target.getString("identityKey"), target.getString("agentId"))
    check(value.identityKey.matches(Regex("[0-9a-f]{64}")) && value.agentId.matches(Regex("[A-Za-z0-9._:-]{1,256}"))) { "MOBILE_TARGET_INVALID" }
    return value to items
  }
  private fun parseArtifactDescriptor(value: JSONObject): ArtifactDescriptor {
    check(value.keys().asSequence().toSet() == setOf("artifactId", "name", "mimeType", "sizeBytes", "sha256") &&
      value.opt("artifactId") is String && value.opt("name") is String && value.opt("mimeType") is String && value.opt("sha256") is String &&
      (value.opt("sizeBytes") is Int || value.opt("sizeBytes") is Long)) { "MOBILE_INTENT_INVALID" }
    return ArtifactDescriptor(value.getString("artifactId"), value.getString("name"), value.getString("mimeType"),
      value.getLong("sizeBytes"), value.getString("sha256"))
  }
  private fun artifactScheduler(scope: String, context: android.content.Context): NativeArtifactScheduler {
    if (artifactScope == scope) artifactDownloads?.let { return it }
    artifactDownloads?.pause()
    val records = SecureRecords(context)
    val cache = NativeArtifactCache(context, records, scope)
    val scheduler = NativeArtifactScheduler(cache, scope, { next -> owner.execute(next) }, { targetId, inner ->
      val envelope = JSONObject().put("version", 1).put("kind", "assets").put("targetId", targetId).put("request", inner)
      JSONObject(ensureConnection().request(envelope.toString()))
    }, { ownerActive && appForeground && artifactScope == scope }, { event ->
      if (ownerActive && artifactScope == scope) sendEvent("artifactDownloadChanged", artifactProjection(event))
    })
    artifactScope = scope
    artifactDownloads = scheduler
    return scheduler
  }
  private fun artifactProjection(event: JSONObject): Map<String, Any?> = mapOf(
    "kind" to event.optString("kind"), "targetId" to event.optString("targetId"),
    "identityKey" to event.optString("identityKey"), "agentId" to event.optString("agentId"),
    "sessionId" to event.optString("sessionId"), "artifactId" to event.optString("artifactId"),
    "name" to event.optString("name"), "mimeType" to event.optString("mimeType"), "sha256" to event.optString("sha256"),
    "state" to event.optString("state"), "receivedBytes" to event.optLong("receivedBytes"),
    "totalBytes" to event.optLong("totalBytes"),
    "errorCode" to event.opt("errorCode").let { if (it == null || it === JSONObject.NULL) null else it },
  )
  private fun artifactError(error: Exception): String = error.message
    ?.takeIf { it.matches(Regex("[A-Z0-9_]{1,128}")) } ?: "MOBILE_ARTIFACT_UNAVAILABLE"
  private fun isArtifactAuthorityFailure(code: String) = code.startsWith("ACCOUNT_") || code.startsWith("TARGET_") ||
    code.startsWith("HOST_MANAGEMENT_") || code in setOf("MOBILE_AUTHORIZATION_REQUIRED", "MOBILE_ACCOUNT_CHANGED")
  private fun isCanonicalUuid(value: String) = runCatching { java.util.UUID.fromString(value).toString() == value }.getOrDefault(false)
  private fun handleSpeech(kind: String, promise: Promise) {
    val context = appContext.reactContext ?: run { promise.resolve(failure("MOBILE_SPEECH_SERVICE_UNAVAILABLE")); return }
    if (kind == "speech.start" && appContext.currentActivity?.hasWindowFocus() != true) {
      promise.resolve(failure("MOBILE_SPEECH_FOREGROUND_REQUIRED")); return
    }
    if (speech == null) speech = NativeSpeech(context) { event -> sendEvent("speechChanged", event.projection()) }
    val engine = speech ?: run { promise.resolve(failure("MOBILE_SPEECH_SERVICE_UNAVAILABLE")); return }
    val settle: (Result<Unit>) -> Unit = { result ->
      result.fold(
        onSuccess = { promise.resolve(JSONObject(engine.current.projection()).toString()) },
        onFailure = { error -> promise.resolve(failure((error as? SpeechFailure)?.code ?: "MOBILE_SPEECH_RECOGNITION_FAILED")) }
      )
    }
    when (kind) {
      "speech.start" -> {
        if (context.checkSelfPermission(NativeSpeech.RECORD_AUDIO_PERMISSION) == PackageManager.PERMISSION_GRANTED) engine.start(settle)
        else {
          val permissions = appContext.permissions
          if (permissions == null) promise.resolve(failure("MOBILE_SPEECH_PERMISSION_REQUIRED"))
          else permissions.askForPermissions(PermissionsResponseListener {
            main.post {
              if (appContext.currentActivity == null || appContext.currentActivity?.isFinishing == true) promise.resolve(failure("MOBILE_SPEECH_FOREGROUND_REQUIRED"))
              else if (context.checkSelfPermission(NativeSpeech.RECORD_AUDIO_PERMISSION) == PackageManager.PERMISSION_GRANTED) engine.start(settle)
              else promise.resolve(failure("MOBILE_SPEECH_PERMISSION_DENIED"))
            }
          }, NativeSpeech.RECORD_AUDIO_PERMISSION)
        }
      }
      "speech.stop" -> engine.stop(settle)
      "speech.cancel" -> { engine.cancel(); settle(Result.success(Unit)) }
      else -> promise.resolve(failure("MOBILE_INTENT_UNSUPPORTED"))
    }
  }
  private fun failure(code: String) = JSONObject().put("kind", "error").put("code", code).toString()
}
