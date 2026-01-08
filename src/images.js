// src/images.js - Image PII detection and redaction using Apple Vision
import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import sharp from 'sharp';
import { detectPII } from './pii.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OCR_BINARY = join(__dirname, '..', 'bin', 'vision-ocr');

// Check if OCR is available
export function isOCRAvailable() {
  return existsSync(OCR_BINARY);
}

// Run OCR on an image, return detected text regions
async function runOCR(base64Data, mediaType) {
  const ext = mediaType?.split('/')[1] || 'png';
  const tempFile = join(tmpdir(), `ocr-${Date.now()}.${ext}`);

  try {
    writeFileSync(tempFile, Buffer.from(base64Data, 'base64'));
    const result = execFileSync(OCR_BINARY, [tempFile], { encoding: 'utf8' });
    return JSON.parse(result);
  } finally {
    if (existsSync(tempFile)) unlinkSync(tempFile);
  }
}

// Redact PII from an image
export async function redactImagePII(base64Data, mediaType) {
  if (!isOCRAvailable()) {
    console.warn('[Images] OCR binary not found, skipping image redaction');
    return base64Data;
  }

  try {
    // 1. Run OCR
    const ocr = await runOCR(base64Data, mediaType);
    if (!ocr.texts) return base64Data;

    // 2. Find PII in detected text
    const piiItems = detectPII(ocr.texts);
    if (piiItems.length === 0) return base64Data;

    console.log(`[Images] Found ${piiItems.length} PII items in image`);

    // 3. Find which observations contain PII
    const regionsToRedact = [];
    for (const obs of ocr.observations) {
      if (piiItems.some(pii => obs.text.includes(pii.value))) {
        regionsToRedact.push({
          x: Math.floor(obs.x * ocr.width),
          y: Math.floor(obs.y * ocr.height),
          width: Math.ceil(obs.width * ocr.width),
          height: Math.ceil(obs.height * ocr.height)
        });
      }
    }

    if (regionsToRedact.length === 0) return base64Data;

    // 4. Draw black rectangles over PII regions
    const buffer = Buffer.from(base64Data, 'base64');

    // Create overlay with black rectangles
    const svgRects = regionsToRedact.map(r =>
      `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="black"/>`
    ).join('');

    const svg = Buffer.from(
      `<svg width="${ocr.width}" height="${ocr.height}">${svgRects}</svg>`
    );

    const redacted = await sharp(buffer)
      .composite([{ input: svg, blend: 'over' }])
      .toBuffer();

    console.log(`[Images] Redacted ${regionsToRedact.length} regions`);
    return redacted.toString('base64');
  } catch (err) {
    console.warn('[Images] OCR/redaction failed:', err.message);
    return base64Data; // Graceful degradation
  }
}
