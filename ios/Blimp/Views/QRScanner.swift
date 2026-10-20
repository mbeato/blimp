// The camera view that reads the QR code `blimpd pair` shows: VisionKit's scanner, QR codes only.
// It hands over the first code it reads, once; PairView checks it like a pasted link.
import SwiftUI
import VisionKit

struct QRScanner: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        return scanner
    }

    // Scanning starts once the view is up; startScanning before that does nothing.
    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
        if !scanner.isScanning, !context.coordinator.done { try? scanner.startScanning() }
    }

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }

    @MainActor final class Coordinator: DataScannerViewControllerDelegate {
        let onScan: (String) -> Void
        var done = false

        init(onScan: @escaping (String) -> Void) { self.onScan = onScan }

        func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for case .barcode(let code) in addedItems {
                guard let text = code.payloadStringValue else { continue }
                done = true
                scanner.stopScanning()
                onScan(text)
                return
            }
        }
    }
}
