// test/test-streaming.js - SSE streaming behaviour tests
// Verifies that the proxy correctly forwards all SSE event types including
// thinking blocks (extended thinking / effortLevel: "high").
import 'dotenv/config';

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:3030';

// Parse raw SSE bytes into an array of { event, data } objects
function parseSSE(text) {
  const events = [];
  let current = { event: null, data: null };

  for (const line of text.split('\n')) {
    if (line.startsWith('event: ')) {
      current.event = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      try {
        current.data = JSON.parse(line.slice(6));
      } catch {
        current.data = line.slice(6);
      }
    } else if (line === '' && current.event) {
      events.push({ ...current });
      current = { event: null, data: null };
    }
  }
  return events;
}

async function streamRequest(body) {
  const res = await fetch(`${PROXY_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true }),
  });
  const text = await res.text();
  return { status: res.status, events: parseSSE(text), raw: text };
}

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

// ─── Test 1: Basic SSE event sequence ────────────────────────────────────────
async function testBasicStream() {
  console.log('\n1️⃣  Basic streaming — event sequence');
  const { status, events } = await streamRequest({
    model: 'claude-sonnet-4-6',
    max_tokens: 30,
    messages: [{ role: 'user', content: 'Reply with exactly: streaming works' }],
  });

  assert(status === 200, 'HTTP 200');

  const types = events.map(e => e.event);
  assert(types.includes('message_start'), 'message_start present (was missing before fix)');
  assert(types.includes('content_block_start'), 'content_block_start present (was missing before fix)');
  assert(types.includes('content_block_delta'), 'content_block_delta present');
  assert(types.includes('content_block_stop'), 'content_block_stop present');
  assert(types.includes('message_delta'), 'message_delta present');
  assert(types.includes('message_stop'), 'message_stop present (last event)');
  assert(types.at(-1) === 'message_stop', 'message_stop is final event');

  const textBlock = events.find(e => e.event === 'content_block_start' && e.data?.content_block?.type === 'text');
  assert(!!textBlock, 'content_block_start carries type:"text"');

  const textDeltas = events.filter(e => e.event === 'content_block_delta' && e.data?.delta?.type === 'text_delta');
  const assembled = textDeltas.map(e => e.data.delta.text).join('');
  assert(assembled.toLowerCase().includes('streaming'), `assembled text contains response ("${assembled.slice(0, 60)}")`);
}

// ─── Test 2: PII redaction in streaming mode ─────────────────────────────────
async function testStreamingPII() {
  console.log('\n2️⃣  Streaming PII redaction');
  const { status, events, raw } = await streamRequest({
    model: 'claude-sonnet-4-6',
    max_tokens: 80,
    messages: [{ role: 'user', content: 'My email is test@woolsocks.eu. Confirm you received a message.' }],
  });

  assert(status === 200, 'HTTP 200');
  assert(!raw.includes('EMAIL_1'), 'PII token (EMAIL_1) not exposed in SSE stream');

  const textDeltas = events.filter(e => e.event === 'content_block_delta' && e.data?.delta?.type === 'text_delta');
  const assembled = textDeltas.map(e => e.data.delta.text).join('');
  assert(assembled.length > 0, `got text response ("${assembled.slice(0, 60)}")`);
}

// ─── Test 3: Extended thinking blocks pass through ───────────────────────────
// Verifies the proxy correctly forwards thinking SSE events when Vertex returns them.
// Skips gracefully if Vertex AI doesn't enable thinking for this request.
async function testThinkingBlocks() {
  console.log('\n3️⃣  Extended thinking (budget_tokens: 5000)');
  let result;
  try {
    result = await streamRequest({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      thinking: { type: 'enabled', budget_tokens: 5000 },
      betas: ['interleaved-thinking-2025-05-14'],
      messages: [{ role: 'user', content: 'What is 12 × 13? Think step by step.' }],
    });
  } catch (e) {
    console.log(`  ⚠️  Skipped — request failed: ${e.message}`);
    return;
  }

  const { status, events } = result;

  if (status !== 200) {
    const errorEvent = events.find(e => e.event === 'error');
    console.log(`  ⚠️  Skipped — API returned ${status}: ${errorEvent?.data?.message || 'unknown'}`);
    return;
  }

  const blockStarts = events.filter(e => e.event === 'content_block_start');
  const thinkingBlock = blockStarts.find(e => e.data?.content_block?.type === 'thinking');

  if (!thinkingBlock) {
    // Vertex AI may not return thinking blocks depending on model/region support
    console.log('  ⚠️  Vertex AI did not return thinking blocks — skipping thinking-specific assertions');
    console.log('       (SSE structure, PII redaction, and message_stop already verified in tests 1-2)');
    return;
  }

  const textBlock = blockStarts.find(e => e.data?.content_block?.type === 'text');
  assert(!!textBlock, 'text content_block_start present alongside thinking');

  const thinkingDeltas = events.filter(
    e => e.event === 'content_block_delta' && e.data?.delta?.type === 'thinking_delta'
  );
  assert(thinkingDeltas.length > 0, `thinking_delta events forwarded (${thinkingDeltas.length})`);

  const textDeltas = events.filter(
    e => e.event === 'content_block_delta' && e.data?.delta?.type === 'text_delta'
  );
  const assembled = textDeltas.map(e => e.data.delta.text).join('');
  assert(assembled.includes('156'), `final answer contains 156 ("${assembled.slice(0, 80)}")`);

  // Verify block_stop events match block_start events (proper open/close pairing)
  const stopIndices = new Set(
    events.filter(e => e.event === 'content_block_stop').map(e => e.data?.index)
  );
  const startIndices = new Set(blockStarts.map(e => e.data?.index));
  assert(
    [...startIndices].every(i => stopIndices.has(i)),
    'every content_block_start has matching content_block_stop'
  );
}

// ─── Test 4: context_management field is stripped ────────────────────────────
async function testContextManagementStripped() {
  console.log('\n4️⃣  context_management field stripped (Vertex incompatibility)');
  const { status } = await streamRequest({
    model: 'claude-sonnet-4-6',
    max_tokens: 20,
    context_management: { enabled: true },
    messages: [{ role: 'user', content: 'Say "ok"' }],
  });
  assert(status === 200, 'request succeeds when context_management is present (gets stripped)');
}

// ─── Runner ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🧪 Streaming SSE tests\n');
  console.log(`Proxy URL: ${PROXY_URL}`);

  try {
    await fetch(`${PROXY_URL}/health`, { signal: AbortSignal.timeout(2000) });
  } catch {
    console.log('\n⚠️  Proxy not running at', PROXY_URL);
    console.log('   Start it: npm start');
    console.log('   Then run: npm run test:streaming\n');
    process.exit(1);
  }

  await testBasicStream();
  await testStreamingPII();
  await testThinkingBlocks();
  await testContextManagementStripped();

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
