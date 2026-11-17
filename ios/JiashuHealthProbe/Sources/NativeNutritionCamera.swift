import SwiftUI
import UIKit
import AVFoundation

enum NativeNutritionCameraAccess: Equatable {
    case ready, needsPermission, denied, restricted, unavailable

    static func resolve(available: Bool, authorization: AVAuthorizationStatus) -> Self {
        guard available else { return .unavailable }
        switch authorization {
        case .authorized: return .ready
        case .notDetermined: return .needsPermission
        case .denied: return .denied
        case .restricted: return .restricted
        @unknown default: return .restricted
        }
    }

    /// Called only by the explicit camera button, never from page loading.
    @MainActor static func requestForUserAction() async -> Self {
        let available = UIImagePickerController.isSourceTypeAvailable(.camera)
        let state = resolve(available: available, authorization: AVCaptureDevice.authorizationStatus(for: .video))
        guard state == .needsPermission else { return state }
        let allowed = await AVCaptureDevice.requestAccess(for: .video)
        return allowed ? .ready : resolve(available: available, authorization: AVCaptureDevice.authorizationStatus(for: .video))
    }
}

/// A camera-only presentation. It never falls back to UIImagePickerController's
/// photo-library mode, so PhotosPicker remains the sole library-selection path.
@MainActor
struct NativeNutritionCamera: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    let onCancel: () -> Void
    let onUnavailable: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCapture: onCapture, onCancel: onCancel, onUnavailable: onUnavailable) }

    func makeUIViewController(context: Context) -> UIViewController {
        let host = NutritionCameraHost()
        host.view.backgroundColor = .systemBackground
        host.onReady = { [weak coordinator = context.coordinator] controller in
            guard let coordinator, coordinator.active else { return }
            guard UIImagePickerController.isSourceTypeAvailable(.camera),
                  AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
                coordinator.active = false; coordinator.onUnavailable(); return
            }
            let picker = UIImagePickerController()
            picker.sourceType = .camera
            picker.mediaTypes = ["public.image"]
            picker.cameraCaptureMode = .photo
            picker.allowsEditing = false
            picker.delegate = coordinator
            picker.modalPresentationStyle = .fullScreen
            controller.present(picker, animated: false)
        }
        return host
    }
    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}
    static func dismantleUIViewController(_ uiViewController: UIViewController, coordinator: Coordinator) {
        coordinator.active = false
        uiViewController.dismiss(animated: false)
    }

    @MainActor
    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        var active = true
        let onCapture: (UIImage) -> Void
        let onCancel: () -> Void
        let onUnavailable: () -> Void
        init(onCapture: @escaping (UIImage) -> Void, onCancel: @escaping () -> Void, onUnavailable: @escaping () -> Void) {
            self.onCapture = onCapture; self.onCancel = onCancel; self.onUnavailable = onUnavailable
        }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            guard active else { return }
            active = false
            guard let image = info[.originalImage] as? UIImage else { onUnavailable(); return }
            onCapture(image)
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            guard active else { return }; active = false; onCancel()
        }
    }
}

@MainActor
private final class NutritionCameraHost: UIViewController {
    var onReady: ((UIViewController) -> Void)?
    private var appeared = false
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !appeared else { return }; appeared = true; onReady?(self)
    }
}
