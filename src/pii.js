// src/pii.js - PII detection, pseudonymization, and restoration
// Supports all Woolsocks markets (NL, DE, BE, FR, IT, ES, IE) + UK and EU

// ============================================================================
// PATTERN DEFINITIONS BY TYPE
// ============================================================================

// Phone patterns by country
// Most require country code or local prefix to avoid false positives
const PHONE_PATTERNS = {
  // Netherlands: +31/0031/0 followed by 9 digits (mobile starts with 6)
  NL: /(?:\+31|0031|0)[\s.-]?[1-9](?:[\s.-]?\d){8}/g,

  // Germany: +49/0049/0 followed by area code + number (10-11 digits total)
  DE: /(?:\+49|0049)[\s.-]?\d{2,4}[\s.-]?\d{3,8}(?:[\s.-]?\d{1,4})?/g,

  // France: +33/0033/0 followed by 9 digits (mobile starts with 6/7)
  FR: /(?:\+33|0033|0)[\s.-]?[1-9](?:[\s.-]?\d{2}){4}/g,

  // Belgium: +32/0032/0 followed by 8-9 digits
  BE: /(?:\+32|0032|0)[\s.-]?[1-9](?:[\s.-]?\d){7,8}/g,

  // Italy: +39 followed by 9-10 digits (mobile starts with 3)
  IT: /(?:\+39|0039)[\s.-]?3\d{2}[\s.-]?\d{6,7}/g,

  // Spain: +34 followed by 9 digits (mobile starts with 6/7)
  ES: /(?:\+34|0034)[\s.-]?[6-9]\d{2}[\s.-]?\d{3}[\s.-]?\d{3}/g,

  // Ireland: +353 followed by 9 digits (mobile starts with 8)
  IE: /(?:\+353|00353)[\s.-]?8[3-9][\s.-]?\d{3}[\s.-]?\d{4}/g,

  // UK: +44 followed by 10 digits (mobile starts with 7)
  UK: /(?:\+44|0044)[\s.-]?7\d{3}[\s.-]?\d{6}/g,
};

// Postal code patterns by country
const POSTCODE_PATTERNS = {
  // Netherlands: 4 digits + 2 letters (e.g., 1234 AB)
  NL: /\b\d{4}\s?[A-Z]{2}\b/gi,

  // UK: Alphanumeric format (e.g., SW1A 1AA, M1 1AE)
  UK: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/gi,

  // Ireland: Eircode - letter + 2 digits + space + 4 alphanumeric (e.g., D02 AF30)
  IE: /\b[A-Z]\d{2}\s?[A-Z0-9]{4}\b/gi,

  // Note: DE/FR/IT/ES/BE use 4-5 digit codes which have high false positive risk
  // These are handled separately with context awareness
};

// National ID patterns by country
const NATIONAL_ID_PATTERNS = {
  // Netherlands BSN: 9 digits (with optional separators)
  NL_BSN: /\b\d{3}[\s.-]?\d{3}[\s.-]?\d{3}\b/g,

  // Germany Steuer-ID: 11 digits (tax ID, not SSN equivalent)
  DE_STEUER: /\b\d{11}\b/g,

  // France NIR (INSEE): 15 digits starting with 1 or 2 (social security)
  // Format: 1 85 01 75 123 456 78 (sex + year + month + dept + commune + order + key)
  FR_NIR: /\b[12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}\s?\d{2}\b/g,

  // Belgium Rijksregisternummer: 11 digits (YY.MM.DD-XXX.XX format)
  BE_RRN: /\b\d{2}[\s.-]?\d{2}[\s.-]?\d{2}[\s.-]?\d{3}[\s.-]?\d{2}\b/g,

  // Italy Codice Fiscale: 16 alphanumeric (e.g., RSSMRA85A01H501Z)
  IT_CF: /\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi,

  // Spain NIF: 8 digits + letter (e.g., 12345678Z)
  ES_NIF: /\b\d{8}[A-Z]\b/gi,

  // Spain NIE: X/Y/Z + 7 digits + letter (e.g., X1234567L)
  ES_NIE: /\b[XYZ]\d{7}[A-Z]\b/gi,

  // Ireland PPS: 7 digits + 1-2 letters (e.g., 1234567FA)
  IE_PPS: /\b\d{7}[A-Z]{1,2}\b/gi,

  // UK NIN: 2 letters + 6 digits + letter (e.g., AB123456C)
  UK_NIN: /\b[A-Z]{2}\d{6}[A-Z]\b/gi,
};

// ============================================================================
// COMBINED PATTERNS ARRAY
// Order matters: more specific patterns first to avoid conflicts
// ============================================================================

const PATTERNS = [
  // === Universal patterns ===
  { type: 'EMAIL', regex: /[\w.-]+@[\w.-]+\.\w{2,}/gi },
  // IBAN: 2 letters (country) + 2 digits (check) + 10-30 alphanumeric (BBAN varies by country)
  // Supports both compact (DE89370400440532013000) and spaced (NL91 ABNA 0417 1643 00) formats
  { type: 'IBAN', regex: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4})+(?:\s?[A-Z0-9]{1,4})?\b/gi },

  // === National IDs (most specific, check before generic numbers) ===
  { type: 'CODICE_FISCALE', regex: NATIONAL_ID_PATTERNS.IT_CF },
  { type: 'UK_NIN', regex: NATIONAL_ID_PATTERNS.UK_NIN },
  { type: 'PPS', regex: NATIONAL_ID_PATTERNS.IE_PPS },
  { type: 'NIF', regex: NATIONAL_ID_PATTERNS.ES_NIF },
  { type: 'NIE', regex: NATIONAL_ID_PATTERNS.ES_NIE },
  { type: 'NIR', regex: NATIONAL_ID_PATTERNS.FR_NIR },
  { type: 'RRN', regex: NATIONAL_ID_PATTERNS.BE_RRN },
  { type: 'BSN', regex: NATIONAL_ID_PATTERNS.NL_BSN },
  { type: 'STEUER_ID', regex: NATIONAL_ID_PATTERNS.DE_STEUER },

  // === Phone numbers (require country code to avoid false positives) ===
  { type: 'PHONE_NL', regex: PHONE_PATTERNS.NL },
  { type: 'PHONE_DE', regex: PHONE_PATTERNS.DE },
  { type: 'PHONE_FR', regex: PHONE_PATTERNS.FR },
  { type: 'PHONE_BE', regex: PHONE_PATTERNS.BE },
  { type: 'PHONE_IT', regex: PHONE_PATTERNS.IT },
  { type: 'PHONE_ES', regex: PHONE_PATTERNS.ES },
  { type: 'PHONE_IE', regex: PHONE_PATTERNS.IE },
  { type: 'PHONE_UK', regex: PHONE_PATTERNS.UK },

  // === Postcodes (specific formats first) ===
  { type: 'POSTCODE_NL', regex: POSTCODE_PATTERNS.NL },
  { type: 'POSTCODE_UK', regex: POSTCODE_PATTERNS.UK },
  { type: 'POSTCODE_IE', regex: POSTCODE_PATTERNS.IE },

  // Note: We deliberately don't add generic 4-5 digit postcode patterns
  // as they would cause too many false positives (years, prices, etc.)
  // The national ID patterns above catch the more sensitive identifiers
];

// ============================================================================
// PSEUDONYMIZATION CLASS
// ============================================================================

export class PIIPseudonymizer {
  constructor() {
    this.mappings = new Map();  // TOKEN -> original
    this.counters = {};         // type -> count
  }

  pseudonymize(text) {
    if (!text || typeof text !== 'string') return text;

    let result = text;
    for (const { type, regex } of PATTERNS) {
      // Reset regex lastIndex for global patterns
      regex.lastIndex = 0;

      result = result.replace(regex, (match) => {
        // Check if already mapped (same PII appearing twice)
        for (const [token, original] of this.mappings) {
          if (original === match) return token;
        }
        // Create new token
        this.counters[type] = (this.counters[type] || 0) + 1;
        const token = `${type}_${this.counters[type]}`;
        this.mappings.set(token, match);
        return token;
      });
    }
    return result;
  }

  depseudonymize(text) {
    if (!text || typeof text !== 'string') return text;

    let result = text;
    for (const [token, original] of this.mappings) {
      result = result.replaceAll(token, original);
    }
    return result;
  }

  // Process Anthropic message content (handles arrays and strings)
  processContent(content) {
    if (typeof content === 'string') {
      return this.pseudonymize(content);
    }
    if (Array.isArray(content)) {
      return content.map(block => {
        if (block.type === 'text') {
          return { ...block, text: this.pseudonymize(block.text) };
        }
        // Images handled separately
        return block;
      });
    }
    return content;
  }

  getStats() {
    return {
      totalRedacted: this.mappings.size,
      byType: { ...this.counters }
    };
  }
}

// Standalone function for quick tests
export function detectPII(text) {
  const found = [];
  for (const { type, regex } of PATTERNS) {
    // Reset regex lastIndex for global patterns
    regex.lastIndex = 0;
    const matches = text.match(regex) || [];
    found.push(...matches.map(m => ({ type, value: m })));
  }
  return found;
}
