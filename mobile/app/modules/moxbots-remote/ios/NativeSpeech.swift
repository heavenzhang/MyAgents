import AVFoundation
import Foundation
import Speech

/// Owns one foreground, on-device-only speech capture. Call every method on the main queue.
final class NativeSpeech {
  struct Event {
    let state: String
    let text: String
    let final: Bool
    let code: String? = nil

    var projection: [String: Any] {
      var value: [String: Any] = ["kind": "speech", "state": state, "text": text, "final": final]
      if let code { value["code"] = code }
      return value
    }
  }

  struct Failure: Error {
    let code: String
    init(_ code: String) { self.code = code }
  }

  static let supportedLocales: Set<String> = ["zh-CN", "en-US", "ja-JP"]
  private let locale: String
  private let onEvent: (Event) -> Void
  private var recognizer: SFSpeechRecognizer?
  private var engine: AVAudioEngine?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var stopTimer: DispatchWorkItem?
  private var captureTimer: DispatchWorkItem?
  private var tapInstalled = false
  private var generation = 0
  private var isStarting = false
  private var startCompletion: ((Result<Void, Failure>) -> Void)?
  private var stopCompletion: ((Result<Void, Failure>) -> Void)?
  private(set) var current = Event(state: "idle", text: "", final: false)

  init(locale: String = "zh-CN", onEvent: @escaping (Event) -> Void) {
    self.locale = locale
    self.onEvent = onEvent
  }

  func start(completion: @escaping (Result<Void, Failure>) -> Void) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard NativeSpeech.supportedLocales.contains(locale) else {
      completion(.failure(Failure("MOBILE_SPEECH_LOCALE_UNSUPPORTED")))
      return
    }
    guard current.state == "idle", !isStarting else {
      completion(.failure(Failure("MOBILE_SPEECH_ALREADY_ACTIVE")))
      return
    }

    generation += 1
    let token = generation
    isStarting = true
    startCompletion = completion
    requestSpeechAuthorization(token: token)
  }

  func stop(completion: @escaping (Result<Void, Failure>) -> Void) {
    dispatchPrecondition(condition: .onQueue(.main))
    guard current.state == "recording", let request, let engine else {
      completion(.failure(Failure("MOBILE_SPEECH_NOT_RECORDING")))
      return
    }
    stopCompletion = completion
    let token = generation
    emit(state: "transcribing", text: current.text, final: false)
    guard generation == token, current.state == "transcribing" else { return }
    captureTimer?.cancel()
    captureTimer = nil
    request.endAudio()
    engine.stop()
    removeInputTap(from: engine)
    let timeout = DispatchWorkItem { [weak self] in
      guard let self, self.generation == token, self.current.state == "transcribing" else { return }
      self.finishStop(.failure(Failure("MOBILE_SPEECH_TIMEOUT")), final: false)
    }
    stopTimer = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 12, execute: timeout)
  }

  func cancel() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard current.state != "idle" || isStarting else { return }
    generation += 1
    isStarting = false
    stopTimer?.cancel()
    stopTimer = nil
    let startCompletion = self.startCompletion
    let stopCompletion = self.stopCompletion
    self.startCompletion = nil
    self.stopCompletion = nil
    tearDown()
    emit(state: "idle", text: current.text, final: false, code: "MOBILE_SPEECH_CANCELLED")
    startCompletion?(.failure(Failure("MOBILE_SPEECH_CANCELLED")))
    stopCompletion?(.failure(Failure("MOBILE_SPEECH_CANCELLED")))
  }

  private func requestSpeechAuthorization(token: Int) {
    let status = SFSpeechRecognizer.authorizationStatus()
    guard status == .notDetermined else {
      guard status == .authorized else { failStart("MOBILE_SPEECH_PERMISSION_DENIED"); return }
      requestMicrophoneAuthorization(token: token)
      return
    }
    SFSpeechRecognizer.requestAuthorization { [weak self] status in
      DispatchQueue.main.async {
        guard let self, self.generation == token else { return }
        guard status == .authorized else { self.failStart("MOBILE_SPEECH_PERMISSION_DENIED"); return }
        self.requestMicrophoneAuthorization(token: token)
      }
    }
  }

  private func requestMicrophoneAuthorization(token: Int) {
    let session = AVAudioSession.sharedInstance()
    let continueStart: (Bool) -> Void = { [weak self] granted in
      DispatchQueue.main.async {
        guard let self, self.generation == token else { return }
        guard granted else { self.failStart("MOBILE_SPEECH_MICROPHONE_DENIED"); return }
        self.beginCapture(token: token)
      }
    }
    switch session.recordPermission {
    case .granted:
      continueStart(true)
    case .denied:
      continueStart(false)
    case .undetermined:
      session.requestRecordPermission(continueStart)
    @unknown default:
      continueStart(false)
    }
  }

  private func beginCapture(token: Int) {
    guard generation == token else { return }
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable else {
      failStart("MOBILE_SPEECH_SERVICE_UNAVAILABLE")
      return
    }
    guard recognizer.supportsOnDeviceRecognition else {
      failStart("MOBILE_SPEECH_ON_DEVICE_UNAVAILABLE")
      return
    }

    do {
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(.record, mode: .measurement, options: [.duckOthers])
      try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

      let engine = AVAudioEngine()
      let request = SFSpeechAudioBufferRecognitionRequest()
      request.shouldReportPartialResults = true
      request.requiresOnDeviceRecognition = true
      let input = engine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.channelCount > 0, format.sampleRate > 0 else {
        failStart("MOBILE_SPEECH_AUDIO_INPUT_UNAVAILABLE")
        return
      }
      self.recognizer = recognizer
      self.engine = engine
      self.request = request
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        request.append(buffer)
      }
      tapInstalled = true
      engine.prepare()
      try engine.start()

      self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
        DispatchQueue.main.async {
          guard let self, self.generation == token, self.current.state != "idle" else { return }
          if let result {
            let text = result.bestTranscription.formattedString
            if result.isFinal {
              self.finishStop(.success(()), text: text, final: true)
            } else {
              self.emit(state: self.current.state, text: text, final: false)
            }
          }
          if let error, self.current.state != "idle" {
            self.finishStop(.failure(Failure("MOBILE_SPEECH_RECOGNITION_FAILED")), final: false,
              code: "MOBILE_SPEECH_RECOGNITION_FAILED")
          }
        }
      }
      emit(state: "recording", text: "", final: false)
      guard generation == token, current.state == "recording" else { return }
      isStarting = false
      let startCompletion = self.startCompletion
      self.startCompletion = nil
      startCompletion?(.success(()))
      guard generation == token, current.state == "recording" else { return }
      let timeout = DispatchWorkItem { [weak self] in
        guard let self, self.generation == token, self.current.state == "recording" else { return }
        self.stop { _ in }
      }
      captureTimer = timeout
      DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: timeout)
    } catch {
      failStart("MOBILE_SPEECH_START_FAILED")
    }
  }

  private func failStart(_ code: String) {
    generation += 1
    isStarting = false
    let startCompletion = self.startCompletion
    let stopCompletion = self.stopCompletion
    self.startCompletion = nil
    self.stopCompletion = nil
    tearDown()
    emit(state: "idle", text: current.text, final: false, code: code)
    startCompletion?(.failure(Failure(code)))
    stopCompletion?(.failure(Failure(code)))
  }

  private func finishStop(_ result: Result<Void, Failure>, text: String? = nil, final: Bool, code: String? = nil) {
    generation += 1
    isStarting = false
    let startCompletion = self.startCompletion
    let stopCompletion = self.stopCompletion
    self.startCompletion = nil
    self.stopCompletion = nil
    stopTimer?.cancel()
    stopTimer = nil
    captureTimer?.cancel()
    captureTimer = nil
    let transcript = text ?? current.text
    tearDown()
    emit(state: "idle", text: transcript, final: final, code: code ?? (result.failureCode))
    stopCompletion?(result)
    if let startCompletion { startCompletion(result) }
  }

  private func tearDown() {
    stopTimer?.cancel()
    stopTimer = nil
    captureTimer?.cancel()
    captureTimer = nil
    task?.cancel()
    task = nil
    if let engine {
      engine.stop()
      removeInputTap(from: engine)
    }
    engine = nil
    request = nil
    recognizer = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func removeInputTap(from engine: AVAudioEngine) {
    guard tapInstalled else { return }
    engine.inputNode.removeTap(onBus: 0)
    tapInstalled = false
  }

  private func emit(state: String, text: String, final: Bool, code: String? = nil) {
    current = Event(state: state, text: text, final: final, code: code)
    onEvent(current)
  }
}

private extension Result where Failure == NativeSpeech.Failure {
  var failureCode: String? {
    guard case let .failure(error) = self else { return nil }
    return error.code
  }
}
