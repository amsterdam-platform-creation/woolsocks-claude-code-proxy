// test/test-pii.js - PII detection and pseudonymization tests
import { PIIPseudonymizer, detectPII } from '../src/pii.js';

console.log('🧪 Running PII tests...\n');

// Test cases: [input, expectedDetectedTypes]
const testCases = [
  // Emails
  ['Contact: jan@example.com', ['EMAIL']],
  ['Multiple: a@b.com and c@d.nl', ['EMAIL', 'EMAIL']],

  // Dutch phones
  ['Call 06-12345678', ['PHONE_NL']],
  ['Phone: +31 6 1234 5678', ['PHONE_NL']],
  ['Landline: 020-1234567', ['PHONE_NL']],

  // BSN
  ['BSN: 123456789', ['BSN']],
  ['ID: 123.456.789', ['BSN']],

  // IBAN
  ['Account: NL91ABNA0417164300', ['IBAN']],
  ['IBAN NL91 ABNA 0417 1643 00', ['IBAN']],

  // Postcodes
  ['Address: 1234 AB Amsterdam', ['POSTCODE_NL']],
  ['Postcode 1234AB', ['POSTCODE_NL']],

  // UUIDs - NOT redacted (pseudonymous, not directly identifying)
  ['User: 550e8400-e29b-41d4-a716-446655440000', []],
  ['UserID: a2fd77a3-db1a-40eb-bf39-2c98cf364a89', []],

  // Mixed
  ['Jan (jan@test.nl, 06-11111111) at 1234 AB', ['EMAIL', 'PHONE_NL', 'POSTCODE_NL']],

  // No PII
  ['Hello world, how are you?', []],
  ['Price: €123.45', []],
];

let passed = 0;
let failed = 0;

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

  if (match) {
    console.log(`✅ "${input.substring(0, 40)}${input.length > 40 ? '...' : ''}" → ${expectedTypes.join(', ') || '(none)'}`);
    passed++;
  } else {
    console.log(`❌ "${input.substring(0, 40)}${input.length > 40 ? '...' : ''}"`);
    console.log(`   Expected: ${expectedTypes.join(', ') || '(none)'}`);
    console.log(`   Got: ${detectedTypes.join(', ') || '(none)'}`);
    failed++;
  }
}

// Test roundtrip pseudonymization
console.log('\n🔄 Testing roundtrip...');
const complexText = `
Customer: jan.jansen@woolsocks.nl
Phone: 06-98765432
BSN: 987654321
IBAN: NL02RABO0123456789
Address: 5678 CD Rotterdam
`;

const p = new PIIPseudonymizer();
const pseudonymized = p.pseudonymize(complexText);
const restored = p.depseudonymize(pseudonymized);

// Verify no PII leaked in pseudonymized version
const leakedPII = detectPII(pseudonymized);
// Filter out false positives (tokens that look like PII)
const realLeaks = leakedPII.filter(pii =>
  !pii.value.includes('_') && // Tokens contain underscore
  !pii.value.match(/^[A-Z]+_\d+$/) // Token format
);

if (realLeaks.length === 0) {
  console.log('✅ No PII leaked in pseudonymized text');
  passed++;
} else {
  console.log('❌ PII leaked:', realLeaks);
  failed++;
}

// Verify restored matches original
if (restored === complexText) {
  console.log('✅ Roundtrip successful - restored matches original');
  passed++;
} else {
  console.log('❌ Roundtrip failed');
  console.log('Original:', complexText);
  console.log('Restored:', restored);
  failed++;
}

// Test duplicate PII handling
console.log('\n🔄 Testing duplicate PII...');
const p2 = new PIIPseudonymizer();
const dupText = 'Contact jan@test.nl or jan@test.nl again';
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

if (dupRestored === dupText) {
  console.log('✅ Duplicate roundtrip successful');
  passed++;
} else {
  console.log('❌ Duplicate roundtrip failed');
  failed++;
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
