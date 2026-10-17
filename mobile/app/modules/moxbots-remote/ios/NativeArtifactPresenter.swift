import Foundation
import UIKit
import QuickLook

private final class ArtifactQuickLookController: QLPreviewController, QLPreviewControllerDataSource {
  private let artifactURL: URL
  init(url: URL) {
    artifactURL = url
    super.init(nibName: nil, bundle: nil)
    dataSource = self
  }
  required init?(coder: NSCoder) { return nil }
  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
    artifactURL as NSURL
  }
}

enum NativeArtifactPresenter {
  static func present(_ artifact: NativeReadyArtifactFile, share: Bool) throws {
    guard UIApplication.shared.applicationState == .active,
      let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene,
      var presenter = scene.windows.first(where: \.isKeyWindow)?.rootViewController else {
      throw NativeFailure("MOBILE_ARTIFACT_FOREGROUND_REQUIRED")
    }
    while let shown = presenter.presentedViewController { presenter = shown }
    if share {
      let controller = UIActivityViewController(activityItems: [artifact.url], applicationActivities: nil)
      if let popover = controller.popoverPresentationController {
        popover.sourceView = presenter.view
        popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
      }
      presenter.present(controller, animated: true)
    } else {
      presenter.present(ArtifactQuickLookController(url: artifact.url), animated: true)
    }
  }
}
