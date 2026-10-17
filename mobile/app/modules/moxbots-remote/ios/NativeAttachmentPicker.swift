import UIKit
import PhotosUI
import UniformTypeIdentifiers

/// Uses system-provided selections; no photo-library enumeration or broad grant.
final class NativeAttachmentPicker: NSObject, UIDocumentPickerDelegate, PHPickerViewControllerDelegate {
  private let importer: (URL, Bool, String?) throws -> [String: Any]
  private var completion: ((Result<[String: Any], Error>) -> Void)?
  private weak var controller: UIViewController?
  init(importer: @escaping (URL, Bool, String?) throws -> [String: Any],
    completion: @escaping (Result<[String: Any], Error>) -> Void) {
    self.importer = importer; self.completion = completion
  }
  func present(image: Bool) {
    guard UIApplication.shared.applicationState == .active,
      let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
      var presenter = scene.windows.first(where: \.isKeyWindow)?.rootViewController else {
      finish(.failure(NativeFailure("MOBILE_ATTACHMENT_FOREGROUND_REQUIRED"))); return
    }
    while let presented = presenter.presentedViewController { presenter = presented }
    if image {
      var configuration = PHPickerConfiguration()
      configuration.selectionLimit = 1; configuration.filter = .images
      let picker = PHPickerViewController(configuration: configuration)
      picker.delegate = self; controller = picker
      presenter.present(picker, animated: true)
    } else {
      let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.content], asCopy: true)
      picker.allowsMultipleSelection = false; picker.delegate = self; controller = picker
      presenter.present(picker, animated: true)
    }
  }
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { cancel() }
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard urls.count == 1, let url = urls.first else { cancel(); return }
    // asCopy:true gives a local document. Import off the UI thread.
    DispatchQueue.global(qos: .userInitiated).async {
      let result = Result { try self.importer(url, false, nil) }
      DispatchQueue.main.async { self.finish(result) }
    }
  }
  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    guard results.count == 1, let provider = results.first?.itemProvider,
      provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) else { cancel(); return }
    provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
      let result: Result<[String: Any], Error>
      if let url {
        // The provider URL expires when this closure returns; import before then.
        result = Result { try self.importer(url, true, provider.suggestedName) }
      } else { result = .failure(NativeFailure("MOBILE_ATTACHMENT_UNREADABLE")) }
      DispatchQueue.main.async { self.finish(result) }
    }
  }
  func cancel() { controller?.dismiss(animated: false); finish(.failure(NativeFailure("MOBILE_ATTACHMENT_CANCELLED"))) }
  private func finish(_ result: Result<[String: Any], Error>) {
    guard let callback = completion else { return }
    completion = nil; callback(result)
  }
}
