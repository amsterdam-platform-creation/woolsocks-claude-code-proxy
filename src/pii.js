// src/pii.js - PII detection, pseudonymization, and restoration

// Dutch + international PII patterns
// Order matters: more specific patterns first (IBAN before PHONE to avoid conflicts)
// NOTE: UUIDs are NOT included - they are pseudonymous identifiers, not directly identifying
// UUIDs only become personal data when combined with a lookup database
const PATTERNS = [
  { type: 'EMAIL', regex: /[\w.-]+@[\w.-]+\.\w{2,}/gi },
  { type: 'IBAN', regex: /\b[A-Z]{2}\d{2}\s?[A-Z]{4}\s?(\d{4}\s?){2,4}\d{0,2}\b/gi },
  { type: 'PHONE_NL', regex: /(?:\+31|0031|0)[\s.-]?[1-9](?:[\s.-]?\d){8}/g },
  { type: 'BSN', regex: /\b\d{3}[\s.-]?\d{3}[\s.-]?\d{3}\b/g },
  { type: 'POSTCODE_NL', regex: /\b\d{4}\s?[A-Z]{2}\b/g },
];

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
