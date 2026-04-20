// test/test-cost-tracker.js — Unit tests for cost estimation and calculation
import { estimateCost, calculateCost, COST_THRESHOLD, resetSessionCosts, getSessionCosts } from '../src/cost-tracker.js';

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function near(a, b, tolerance = 0.0001) {
  return Math.abs(a - b) < tolerance;
}

console.log('🧪 Cost tracker tests\n');

// ─── calculateCost: known pricing sanity checks ───────────────────────────────
console.log('calculateCost — known models:');

// Sonnet 4.6: input $3.30/M, output $16.50/M
const sonnetCost = calculateCost(
  { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  'claude-sonnet-4-6'
);
assert(near(sonnetCost.inputCost, 3.30),   `Sonnet 4.6 input: $3.30 (got ${sonnetCost.inputCost})`);
assert(near(sonnetCost.outputCost, 16.50), `Sonnet 4.6 output: $16.50 (got ${sonnetCost.outputCost})`);
assert(near(sonnetCost.totalCost, 19.80),  `Sonnet 4.6 total: $19.80 (got ${sonnetCost.totalCost})`);

// Opus 4.7: same pricing tier as Opus 4.6
const opus47Cost = calculateCost(
  { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  'claude-opus-4-7'
);
assert(near(opus47Cost.inputCost, 5.50),   `Opus 4.7 input: $5.50 (got ${opus47Cost.inputCost})`);
assert(near(opus47Cost.outputCost, 27.50), `Opus 4.7 output: $27.50 (got ${opus47Cost.outputCost})`);

// Opus 4.6: input $5.50/M, output $27.50/M
const opusCost = calculateCost(
  { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  'claude-opus-4-6'
);
assert(near(opusCost.inputCost, 5.50),   `Opus 4.6 input: $5.50 (got ${opusCost.inputCost})`);
assert(near(opusCost.outputCost, 27.50), `Opus 4.6 output: $27.50 (got ${opusCost.outputCost})`);

// Cache tokens
const cacheCost = calculateCost(
  { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 },
  'claude-sonnet-4-6'
);
assert(near(cacheCost.cacheWriteCost, 4.125), `Sonnet 4.6 cache write: $4.125 (got ${cacheCost.cacheWriteCost})`);
assert(near(cacheCost.cacheReadCost, 0.33),   `Sonnet 4.6 cache read: $0.33 (got ${cacheCost.cacheReadCost})`);

// Unknown model falls back to Opus pricing
const unknownCost = calculateCost({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude-unknown-99');
assert(near(unknownCost.inputCost, 5.50), `Unknown model falls back to Opus pricing (got ${unknownCost.inputCost})`);

// Zero usage = zero cost
const zeroCost = calculateCost({ input_tokens: 0, output_tokens: 0 }, 'claude-sonnet-4-6');
assert(near(zeroCost.totalCost, 0), `Zero tokens = $0 cost (got ${zeroCost.totalCost})`);

// ─── estimateCost: structure and thresholds ───────────────────────────────────
console.log('\nestimateCost — structure:');

const estimate = estimateCost({
  model: 'claude-sonnet-4-6',
  max_tokens: 1000,
  messages: [{ role: 'user', content: 'Hello world' }],
});

assert(typeof estimate.estimatedInputTokens === 'number', 'estimatedInputTokens is number');
assert(typeof estimate.estimatedOutputTokens === 'number', 'estimatedOutputTokens is number');
assert(typeof estimate.totalEstimate === 'number',         'totalEstimate is number');
assert(estimate.estimatedOutputTokens <= 1000,             'output estimate ≤ max_tokens');
assert(estimate.totalEstimate >= 0,                        'totalEstimate ≥ 0');
assert(typeof estimate.exceedsThreshold === 'boolean',     'exceedsThreshold is boolean');
assert(estimate.threshold === COST_THRESHOLD,              `threshold = COST_THRESHOLD ($${COST_THRESHOLD})`);

// Large request should exceed threshold ($2):
// 1M chars ≈ 250K input tokens @ $5.50/M = $1.375
// 100K max_tokens × 25% ≈ 25K output tokens @ $27.50/M = $0.6875 → total ~$2.06
const expensiveEstimate = estimateCost({
  model: 'claude-opus-4-6',
  max_tokens: 100_000,
  messages: [{ role: 'user', content: 'x'.repeat(1_000_000) }],
});
assert(expensiveEstimate.exceedsThreshold, 'large Opus request exceeds threshold');

// Tiny request should not exceed threshold
const cheapEstimate = estimateCost({
  model: 'claude-haiku-4-5',
  max_tokens: 50,
  messages: [{ role: 'user', content: 'Hi' }],
});
assert(!cheapEstimate.exceedsThreshold, 'tiny Haiku request does not exceed threshold');

// System prompt is included in input estimate
const withSystem = estimateCost({
  model: 'claude-sonnet-4-6',
  max_tokens: 100,
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'Hi' }],
});
const withoutSystem = estimateCost({
  model: 'claude-sonnet-4-6',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'Hi' }],
});
assert(
  withSystem.estimatedInputTokens > withoutSystem.estimatedInputTokens,
  'system prompt increases input token estimate'
);

// ─── COST_THRESHOLD is a sensible value ───────────────────────────────────────
console.log('\nCOST_THRESHOLD:');
assert(COST_THRESHOLD > 0,    `COST_THRESHOLD > 0 (${COST_THRESHOLD})`);
assert(COST_THRESHOLD < 100,  `COST_THRESHOLD < $100 (${COST_THRESHOLD})`);

// ─── resetSessionCosts ────────────────────────────────────────────────────────
console.log('\nresetSessionCosts:');
resetSessionCosts();
const session = getSessionCosts();
assert(session.totalCostUSD === 0, 'totalCostUSD = 0 after reset');
assert(session.requests === 0,     'requests = 0 after reset');

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
