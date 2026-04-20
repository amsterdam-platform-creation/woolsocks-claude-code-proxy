// test/test-model-translation.js — Unit tests for Anthropic → Vertex model name translation
import { translateModel, isModelDisabled, getDisabledModels } from '../src/model-translator.js';

let passed = 0;
let failed = 0;

function assert(condition, label, got = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${got ? ' — got: ' + got : ''}`);
    failed++;
  }
}

function eq(input, expected) {
  const result = translateModel(input);
  assert(result === expected, `${input} → ${expected}`, result);
}

console.log('🧪 Model translation tests\n');

// Static map entries (no date suffix)
console.log('Static map (undated):');
eq('claude-opus-4-7',    'claude-opus-4-7');
eq('claude-opus-4-6',    'claude-opus-4-6');
eq('claude-sonnet-4-6',  'claude-sonnet-4-6');
eq('claude-opus-4-5',    'claude-opus-4-5');
eq('claude-sonnet-4',    'claude-sonnet-4');
eq('claude-haiku-4-5',   'claude-haiku-4-5');
eq('claude-3-5-haiku',   'claude-3-5-haiku');

// Static map entries (dated — dash → @)
console.log('\nStatic map (dated):');
eq('claude-opus-4-5-20251101',    'claude-opus-4-5@20251101');
eq('claude-sonnet-4-20250514',    'claude-sonnet-4@20250514');
eq('claude-haiku-4-5-20251001',   'claude-haiku-4-5@20251001');
eq('claude-3-5-haiku-20241022',   'claude-3-5-haiku@20241022');

// Dynamic fallback (not in static map, but has date suffix)
console.log('\nDynamic fallback (unknown models with date):');
eq('claude-opus-5-20260101',    'claude-opus-5@20260101');
eq('claude-sonnet-5-20260601',  'claude-sonnet-5@20260601');
eq('claude-haiku-5-20260315',   'claude-haiku-5@20260315');

// Pass-through (no date, not in map)
console.log('\nPass-through (no translation possible):');
eq('claude-opus-5',    'claude-opus-5');
eq('gpt-4',            'gpt-4');
eq('',                 '');

// Disabled models (not yet available on Vertex europe-west1)
console.log('\nDisabled models:');
assert(isModelDisabled('claude-opus-4-7'),  'Opus 4.7 is disabled (not on Vertex EU yet)');
assert(!isModelDisabled('claude-opus-4-6'), 'Opus 4.6 is NOT disabled (available on Vertex EU)');
assert(!isModelDisabled('claude-sonnet-4-6'), 'Sonnet 4.6 is NOT disabled');
assert(!isModelDisabled('unknown-model'),   'unknown models default to not disabled');

const disabled = getDisabledModels();
assert(Array.isArray(disabled),                'getDisabledModels returns array');
assert(disabled.includes('claude-opus-4-7'),   'getDisabledModels includes Opus 4.7');

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
