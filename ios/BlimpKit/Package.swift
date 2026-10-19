// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "BlimpKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "BlimpKit", targets: ["BlimpKit"])],
    targets: [
        .target(name: "BlimpKit"),
        .testTarget(name: "BlimpKitTests", dependencies: ["BlimpKit"]),
    ]
)
