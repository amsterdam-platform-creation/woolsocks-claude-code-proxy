#!/usr/bin/swift
// Apple Vision OCR - returns JSON with text and bounding boxes

import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: vision-ocr <image-path>\n", stderr)
    exit(1)
}

let imagePath = CommandLine.arguments[1]
guard let image = NSImage(contentsOfFile: imagePath),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    fputs("Error: Could not load image\n", stderr)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["nl-NL", "en-US", "de-DE"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try? handler.perform([request])

var allText = ""
var observations: [[String: Any]] = []

if let results = request.results {
    for result in results {
        guard let text = result.topCandidates(1).first?.string else { continue }
        allText += text + "\n"

        let box = result.boundingBox
        observations.append([
            "text": text,
            "x": box.minX,
            "y": 1 - box.maxY,  // Flip Y coordinate
            "width": box.width,
            "height": box.height
        ])
    }
}

// Output as JSON
let output: [String: Any] = [
    "texts": allText.trimmingCharacters(in: .whitespacesAndNewlines),
    "width": cgImage.width,
    "height": cgImage.height,
    "observations": observations
]

if let data = try? JSONSerialization.data(withJSONObject: output, options: .prettyPrinted),
   let json = String(data: data, encoding: .utf8) {
    print(json)
}
