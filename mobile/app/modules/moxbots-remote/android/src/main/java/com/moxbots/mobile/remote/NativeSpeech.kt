package com.moxbots.mobile.remote

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.util.Locale

/** Owns one foreground, on-device-only speech capture. Call every method on the main thread. */
internal class NativeSpeech(
  context: Context,
  private val locale: String = "zh-CN",
  private val onEvent: (SpeechEvent) -> Unit,
) {
  private val appContext = context.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private var recognizer: SpeechRecognizer? = null
  private var generation = 0L
  private var startCompletion: ((Result<Unit>) -> Unit)? = null
  private var stopCompletion: ((Result<Unit>) -> Unit)? = null
  private var stopTimeout: Runnable? = null
  private var captureTimeout: Runnable? = null

  var current: SpeechEvent = SpeechEvent(state = "idle", text = "", final = false)
    private set

  fun start(completion: (Result<Unit>) -> Unit = {}) {
    checkMainThread()
    if (current.state != "idle") return completion(Result.failure(SpeechFailure("MOBILE_SPEECH_ALREADY_ACTIVE")))
    if (locale !in SUPPORTED_LOCALES) return completion(Result.failure(SpeechFailure("MOBILE_SPEECH_LOCALE_UNSUPPORTED")))
    if (appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      return completion(Result.failure(SpeechFailure("MOBILE_SPEECH_PERMISSION_REQUIRED")))
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || !SpeechRecognizer.isOnDeviceRecognitionAvailable(appContext)) {
      return completion(Result.failure(SpeechFailure("MOBILE_SPEECH_ON_DEVICE_UNAVAILABLE")))
    }

    val token = ++generation
    startCompletion = completion
    try {
      val recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(appContext)
      this.recognizer = recognizer
      recognizer.setRecognitionListener(listener(token))
      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, locale)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
      }
      recognizer.startListening(intent)
      emit("recording", "", false)
      if (!isCurrent(token) || current.state != "recording") return
      val callback = startCompletion
      startCompletion = null
      callback?.invoke(Result.success(Unit))
      if (!isCurrent(token) || current.state != "recording") return
      val timeout = Runnable {
        if (generation == token && current.state == "recording") stop {}
      }
      captureTimeout = timeout
      main.postDelayed(timeout, MAX_CAPTURE_MS)
    } catch (_: SecurityException) {
      failStart(token, "MOBILE_SPEECH_PERMISSION_REQUIRED")
    } catch (_: UnsupportedOperationException) {
      failStart(token, "MOBILE_SPEECH_ON_DEVICE_UNAVAILABLE")
    } catch (_: Exception) {
      failStart(token, "MOBILE_SPEECH_START_FAILED")
    }
  }

  fun stop(completion: (Result<Unit>) -> Unit = {}) {
    checkMainThread()
    if (current.state != "recording") return completion(Result.failure(SpeechFailure("MOBILE_SPEECH_NOT_RECORDING")))
    stopCompletion = completion
    val token = generation
    captureTimeout?.let(main::removeCallbacks)
    captureTimeout = null
    emit("transcribing", current.text, false)
    if (!isCurrent(token) || current.state != "transcribing") return
    try {
      recognizer?.stopListening() ?: run { finishStop(Result.failure(SpeechFailure("MOBILE_SPEECH_SERVICE_UNAVAILABLE")), current.text, false); return }
    } catch (_: Exception) {
      finishStop(Result.failure(SpeechFailure("MOBILE_SPEECH_STOP_FAILED")), current.text, false)
      return
    }

    val timeout = Runnable {
      if (generation == token && current.state == "transcribing") {
        finishStop(Result.failure(SpeechFailure("MOBILE_SPEECH_TIMEOUT")), current.text, false)
      }
    }
    stopTimeout = timeout
    main.postDelayed(timeout, STOP_TIMEOUT_MS)
  }

  fun cancel() {
    checkMainThread()
    if (current.state == "idle") return
    generation += 1
    val startCallback = startCompletion
    val stopCallback = stopCompletion
    startCompletion = null
    stopCompletion = null
    releaseRecognizer()
    emit("idle", current.text, false, "MOBILE_SPEECH_CANCELLED")
    startCallback?.invoke(Result.failure(SpeechFailure("MOBILE_SPEECH_CANCELLED")))
    stopCallback?.invoke(Result.failure(SpeechFailure("MOBILE_SPEECH_CANCELLED")))
  }

  private fun listener(token: Long) = object : RecognitionListener {
    override fun onReadyForSpeech(params: android.os.Bundle?) = Unit
    override fun onBeginningOfSpeech() = Unit
    override fun onRmsChanged(rmsdB: Float) = Unit
    override fun onBufferReceived(buffer: ByteArray?) = Unit
    override fun onEndOfSpeech() = Unit
    override fun onEvent(eventType: Int, params: android.os.Bundle?) = Unit

    override fun onPartialResults(partialResults: android.os.Bundle?) {
      onMain {
        if (!isCurrent(token) || current.state == "idle") return@onMain
        val transcript = firstTranscript(partialResults) ?: return@onMain
        emit(current.state, transcript, false)
      }
    }

    override fun onResults(results: android.os.Bundle?) {
      onMain {
        if (!isCurrent(token)) return@onMain
        val transcript = firstTranscript(results) ?: current.text
        finishStop(Result.success(Unit), transcript, true)
      }
    }

    override fun onError(error: Int) {
      onMain {
        if (!isCurrent(token) || current.state == "idle") return@onMain
        finishStop(Result.failure(SpeechFailure(errorCode(error))), current.text, false)
      }
    }
  }

  private fun firstTranscript(bundle: android.os.Bundle?): String? =
    bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.takeIf(String::isNotBlank)

  private fun errorCode(error: Int): String = when (error) {
    SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "MOBILE_SPEECH_PERMISSION_DENIED"
    SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED,
    SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "MOBILE_SPEECH_LOCALE_UNAVAILABLE"
    SpeechRecognizer.ERROR_NO_MATCH,
    SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "MOBILE_SPEECH_NO_MATCH"
    SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "MOBILE_SPEECH_BUSY"
    SpeechRecognizer.ERROR_NETWORK,
    SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "MOBILE_SPEECH_ON_DEVICE_SERVICE_FAILED"
    else -> "MOBILE_SPEECH_RECOGNITION_FAILED"
  }

  private fun failStart(token: Long, code: String) {
    if (!isCurrent(token)) return
    generation += 1
    val startCallback = startCompletion
    val stopCallback = stopCompletion
    startCompletion = null
    stopCompletion = null
    releaseRecognizer()
    emit("idle", current.text, false, code)
    startCallback?.invoke(Result.failure(SpeechFailure(code)))
    stopCallback?.invoke(Result.failure(SpeechFailure(code)))
  }

  private fun finishStop(result: Result<Unit>, text: String, final: Boolean) {
    generation += 1
    val startCallback = startCompletion
    val stopCallback = stopCompletion
    startCompletion = null
    stopCompletion = null
    stopTimeout?.let(main::removeCallbacks)
    stopTimeout = null
    captureTimeout?.let(main::removeCallbacks)
    captureTimeout = null
    releaseRecognizer()
    val code = (result.exceptionOrNull() as? SpeechFailure)?.code
    emit("idle", text, final, code)
    stopCallback?.invoke(result)
    startCallback?.invoke(result)
  }

  private fun releaseRecognizer() {
    stopTimeout?.let(main::removeCallbacks)
    stopTimeout = null
    captureTimeout?.let(main::removeCallbacks)
    captureTimeout = null
    recognizer?.cancel()
    recognizer?.destroy()
    recognizer = null
  }

  private fun emit(state: String, text: String, final: Boolean, code: String? = null) {
    current = SpeechEvent(state, text, final, code)
    onEvent(current)
  }

  private fun isCurrent(token: Long) = generation == token

  private fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post { block() }
  }

  private fun checkMainThread() {
    check(Looper.myLooper() == Looper.getMainLooper()) { "NativeSpeech must be called on the main thread" }
  }

  companion object {
    val RECORD_AUDIO_PERMISSION: String = Manifest.permission.RECORD_AUDIO
    private val SUPPORTED_LOCALES = setOf("zh-CN", "en-US", "ja-JP")
    private const val MAX_CAPTURE_MS = 60_000L
    private const val STOP_TIMEOUT_MS = 12_000L
  }
}

internal data class SpeechEvent(val state: String, val text: String, val final: Boolean, val code: String? = null) {
  fun projection(): Map<String, Any> = buildMap {
    put("kind", "speech")
    put("state", state)
    put("text", text)
    put("final", final)
    code?.let { put("code", it) }
  }
}

internal class SpeechFailure(val code: String) : Exception(code)
