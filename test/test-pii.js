// test/test-pii.js - PII detection and pseudonymization tests
// Covers all Woolsocks markets (NL, DE, BE, FR, IT, ES, IE) + UK
import { PIIPseudonymizer, detectPII } from '../src/pii.js';

console.log('🧪 Running PII tests...\n');

// Test cases: [input, expectedDetectedTypes]
const testCases = [
  // ============================================================================
  // Universal patterns
  // ============================================================================

  // Emails
  ['Contact: jan@example.com', ['EMAIL']],
  ['Multiple: a@b.com and c@d.nl', ['EMAIL', 'EMAIL']],
  ['German email: hans@example.de', ['EMAIL']],
  ['French email: jean@example.fr', ['EMAIL']],

  // IBAN (works for all EU countries)
  ['Dutch: NL91ABNA0417164300', ['IBAN']],
  ['German: DE89370400440532013000', ['IBAN']],
  ['French: FR7630006000011234567890189', ['IBAN']],
  ['Belgian: BE68539007547034', ['IBAN']],
  ['Italian: IT60X0542811101000000123456', ['IBAN']],
  ['Spanish: ES9121000418450200051332', ['IBAN']],
  ['Irish: IE29AIBK93115212345678', ['IBAN']],
  ['UK: GB29NWBK60161331926819', ['IBAN']],
  ['IBAN with spaces: NL91 ABNA 0417 1643 00', ['IBAN']],

  // ============================================================================
  // Phone numbers by country
  // ============================================================================

  // Netherlands
  ['Dutch mobile: 06-12345678', ['PHONE_NL']],
  ['Dutch intl: +31 6 1234 5678', ['PHONE_NL']],
  ['Dutch landline: 020-1234567', ['PHONE_NL']],
  ['Dutch format: 0031612345678', ['PHONE_NL']],

  // Germany
  ['German mobile: +49 170 1234567', ['PHONE_DE']],
  ['German landline: +49 30 12345678', ['PHONE_DE']],
  ['German format: 0049 89 12345678', ['PHONE_DE']],

  // France
  ['French mobile: +33 6 12 34 56 78', ['PHONE_FR']],
  ['French landline: +33 1 23 45 67 89', ['PHONE_FR']],
  ['French format: 0033612345678', ['PHONE_FR']],

  // Belgium
  ['Belgian mobile: +32 470 12 34 56', ['PHONE_BE']],
  ['Belgian landline: +32 2 123 45 67', ['PHONE_BE']],
  ['Belgian format: 0032470123456', ['PHONE_BE']],

  // Italy
  ['Italian mobile: +39 333 1234567', ['PHONE_IT']],
  ['Italian format: 0039 320 1234567', ['PHONE_IT']],

  // Spain
  ['Spanish mobile: +34 612 345 678', ['PHONE_ES']],
  ['Spanish format: 0034 612 345 678', ['PHONE_ES']],

  // Ireland
  ['Irish mobile: +353 87 123 4567', ['PHONE_IE']],
  ['Irish format: 00353 85 123 4567', ['PHONE_IE']],

  // UK
  ['UK mobile: +44 7911 123456', ['PHONE_UK']],
  ['UK format: 0044 7700 900123', ['PHONE_UK']],

  // ============================================================================
  // National IDs by country
  // ============================================================================

  // Netherlands - BSN
  ['BSN: 123456789', ['BSN']],
  ['BSN formatted: 123.456.789', ['BSN']],
  ['BSN with dashes: 123-456-789', ['BSN']],

  // Germany - Steuer-ID (11 digits)
  ['German Steuer-ID: 12345678901', ['STEUER_ID']],
  ['Tax ID: 98765432109', ['STEUER_ID']],

  // France - NIR (15 digits starting with 1 or 2)
  ['French NIR: 1 85 01 75 123 456 78', ['NIR']],
  ['NIR compact: 185017512345678', ['NIR']],

  // Belgium - Rijksregisternummer (11 digits)
  ['Belgian RRN: 85.01.01-123.45', ['RRN']],
  ['RRN compact: 85010112345', ['RRN']],

  // Italy - Codice Fiscale (16 alphanumeric)
  ['Italian CF: RSSMRA85A01H501Z', ['CODICE_FISCALE']],
  ['Codice Fiscale: BNCMRA80A01F205X', ['CODICE_FISCALE']],

  // Spain - NIF (8 digits + letter)
  ['Spanish NIF: 12345678Z', ['NIF']],
  ['DNI: 87654321X', ['NIF']],

  // Spain - NIE (X/Y/Z + 7 digits + letter)
  ['Spanish NIE: X1234567L', ['NIE']],
  ['Foreigner ID: Y7654321H', ['NIE']],

  // Ireland - PPS (7 digits + 1-2 letters)
  ['Irish PPS: 1234567FA', ['PPS']],
  ['PPS number: 9876543W', ['PPS']],

  // UK - National Insurance Number
  ['UK NIN: AB123456C', ['UK_NIN']],
  ['National Insurance: QQ123456A', ['UK_NIN']],

  // ============================================================================
  // Postcodes by country
  // ============================================================================

  // Netherlands
  ['Dutch: 1234 AB Amsterdam', ['POSTCODE_NL']],
  ['Postcode: 1234AB', ['POSTCODE_NL']],

  // UK
  ['UK full: SW1A 1AA', ['POSTCODE_UK']],
  ['UK short: M1 1AE', ['POSTCODE_UK']],
  ['UK format: EC1A 1BB', ['POSTCODE_UK']],
  ['UK compact: W1A0AX', ['POSTCODE_UK']],

  // Ireland - Eircode
  ['Irish Eircode: D02 AF30', ['POSTCODE_IE']],
  ['Eircode: A65 F4E2', ['POSTCODE_IE']],

  // ============================================================================
  // False positive tests (should NOT match)
  // ============================================================================

  // UUIDs - NOT redacted (pseudonymous, not directly identifying)
  ['User: 550e8400-e29b-41d4-a716-446655440000', []],
  ['UserID: a2fd77a3-db1a-40eb-bf39-2c98cf364a89', []],

  // Common numbers that should NOT be detected
  ['No PII: Hello world', []],
  ['Price: €123.45', []],
  ['Year: 2024', []],
  ['Order number: 12345', []],
  ['Short number: 1234', []],

  // ============================================================================
  // Mixed content (multiple countries in one text)
  // ============================================================================

  ['Jan (jan@test.nl, 06-11111111) at 1234 AB', ['EMAIL', 'PHONE_NL', 'POSTCODE_NL']],
  ['German customer hans@test.de called from +49 170 9876543', ['EMAIL', 'PHONE_DE']],
  ['UK user with SW1A 2AA and NIN AB654321D', ['POSTCODE_UK', 'UK_NIN']],
  ['Italian RSSMRA85A01H501Z from Rome', ['CODICE_FISCALE']],
  ['Irish customer with PPS 1234567WA at D02 X285', ['PPS', 'POSTCODE_IE']],
];

let passed = 0;
let failed = 0;

console.log('📋 Individual pattern tests:\n');

for (const [input, expectedTypes] of testCases) {
  const detected = detectPII(input);
  const detectedTypes = detected.map(d => d.type);

  // Check if all expected types are found (order may vary, duplicates allowed)
  const expectedCounts = {};
  const detectedCounts = {};
  expectedTypes.forEach(t => expectedCounts[t] = (expectedCounts[t] || 0) + 1);
  detectedTypes.forEach(t => detectedCounts[t] = (detectedCounts[t] || 0) + 1);

  let match = true;
  for (const [type, count] of Object.entries(expectedCounts)) {
    if ((detectedCounts[type] || 0) < count) {
      match = false;
      break;
    }
  }
  // Also check we didn't match anything unexpected when expecting empty
  if (expectedTypes.length === 0 && detectedTypes.length > 0) {
    match = false;
  }

  if (match) {
    console.log(`✅ "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}" → ${expectedTypes.join(', ') || '(none)'}`);
    passed++;
  } else {
    console.log(`❌ "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`);
    console.log(`   Expected: ${expectedTypes.join(', ') || '(none)'}`);
    console.log(`   Got: ${detectedTypes.join(', ') || '(none)'}`);
    failed++;
  }
}

// ============================================================================
// Roundtrip tests
// ============================================================================

console.log('\n🔄 Testing roundtrip pseudonymization...\n');

// Test with multi-country content
const multiCountryText = `
Customer Database Entry:
------------------------
Name: Jan van der Berg
Email: jan.vanderberg@woolsocks.nl
Phone (NL): 06-98765432
BSN: 987654321
IBAN: NL02RABO0123456789
Address: 5678 CD Rotterdam

German Partner:
Email: hans.muller@partner.de
Phone: +49 170 1234567
Steuer-ID: 12345678901

UK Customer:
Email: john.smith@example.co.uk
Phone: +44 7911 234567
NIN: AB123456C
Postcode: SW1A 1AA

Italian Contact:
Codice Fiscale: RSSMRA85A01H501Z

Irish Customer:
PPS: 1234567FA
Eircode: D02 AF30
`;

const p = new PIIPseudonymizer();
const pseudonymized = p.pseudonymize(multiCountryText);
const restored = p.depseudonymize(pseudonymized);

// Verify no PII leaked in pseudonymized version
const leakedPII = detectPII(pseudonymized);
// Filter out false positives (tokens that look like PII)
const realLeaks = leakedPII.filter(pii =>
  !pii.value.includes('_') && // Tokens contain underscore
  !pii.value.match(/^[A-Z_]+_\d+$/) // Token format
);

if (realLeaks.length === 0) {
  console.log('✅ No PII leaked in pseudonymized text');
  passed++;
} else {
  console.log('❌ PII leaked:', realLeaks.map(l => `${l.type}: ${l.value}`).join(', '));
  failed++;
}

// Verify restored matches original
if (restored === multiCountryText) {
  console.log('✅ Roundtrip successful - restored matches original');
  passed++;
} else {
  console.log('❌ Roundtrip failed');
  console.log('Diff:');
  // Show first difference
  for (let i = 0; i < Math.max(multiCountryText.length, restored.length); i++) {
    if (multiCountryText[i] !== restored[i]) {
      console.log(`   Position ${i}: original="${multiCountryText.substring(i, i + 20)}" restored="${restored.substring(i, i + 20)}"`);
      break;
    }
  }
  failed++;
}

// Show stats
console.log('\n📊 Pseudonymization stats:');
const stats = p.getStats();
console.log(`   Total redacted: ${stats.totalRedacted}`);
console.log(`   By type:`, stats.byType);

// ============================================================================
// Duplicate handling tests
// ============================================================================

console.log('\n🔄 Testing duplicate PII handling...\n');

const p2 = new PIIPseudonymizer();
const dupText = 'Contact jan@test.nl or jan@test.nl again. Call +31 6 12345678 or +31 6 12345678';
const dupPseudo = p2.pseudonymize(dupText);
const dupRestored = p2.depseudonymize(dupPseudo);

// Same email should get same token
if (dupPseudo.split('EMAIL_1').length === 3) { // Appears twice
  console.log('✅ Duplicate emails get same token');
  passed++;
} else {
  console.log('❌ Duplicate emails should get same token');
  console.log('   Got:', dupPseudo);
  failed++;
}

// Same phone should get same token
if (dupPseudo.split('PHONE_NL_1').length === 3) { // Appears twice
  console.log('✅ Duplicate phones get same token');
  passed++;
} else {
  console.log('❌ Duplicate phones should get same token');
  console.log('   Got:', dupPseudo);
  failed++;
}

if (dupRestored === dupText) {
  console.log('✅ Duplicate roundtrip successful');
  passed++;
} else {
  console.log('❌ Duplicate roundtrip failed');
  failed++;
}

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${'─'.repeat(50)}`);
console.log(`📊 Results: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(50)}`);

if (failed > 0) {
  console.log('\n⚠️  Some tests failed. Review patterns for edge cases.');
}

process.exit(failed > 0 ? 1 : 0);
