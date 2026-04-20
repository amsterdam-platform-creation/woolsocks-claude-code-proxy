// test/test-http-endpoints.js — Full HTTP tests for every endpoint except POST /v1/messages
// (that lives in test-streaming.js / test-proxy.js since it needs Vertex).
// We import the Express `app` from src/index.js and bind it to an ephemeral port.

// Disable any real GCP init so BIGQUERY status reflects "not initialized" — all endpoints
// must still respond sensibly in that state.
process.env.BIGQUERY_ENABLED = 'false';
process.env.VERTEX_REGION = process.env.VERTEX_REGION || 'europe-west1';

import { app } from '../src/index.js';

let passed = 0;
let failed = 0;

function assert(condition, label, got = '') {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}${got ? ' — got: ' + JSON.stringify(got).slice(0, 200) : ''}`); failed++; }
}

// Bind Express to an ephemeral port so we don't collide with a running proxy.
const server = app.listen(0);
await new Promise(resolve => server.on('listening', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`🧪 HTTP endpoint tests (bound to ${base})\n`);

async function get(path) {
  const r = await fetch(base + path);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text };
}
async function post(path, body) {
  const r = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text };
}

try {
  // ─── GET /health ────────────────────────────────────────────────────────────
  console.log('GET /health:');
  {
    const { status, json } = await get('/health');
    assert(status === 200, `status 200 (${status})`);
    assert(json?.status === 'ok', 'status field = "ok"');
    assert(typeof json?.region === 'string', 'region field is string');
  }

  // ─── GET /stats ─────────────────────────────────────────────────────────────
  console.log('\nGET /stats:');
  {
    const { status, json } = await get('/stats');
    assert(status === 200, `status 200 (${status})`);
    assert('toolUsage' in (json || {}), 'has toolUsage key');
  }

  // ─── GET /costs ─────────────────────────────────────────────────────────────
  console.log('\nGET /costs:');
  {
    const { status, json } = await get('/costs');
    assert(status === 200, `status 200 (${status})`);
    assert(typeof json?.totalCostUSD === 'number', 'totalCostUSD is number');
    assert(typeof json?.requests === 'number', 'requests is number');
  }

  // ─── GET /pricing ───────────────────────────────────────────────────────────
  console.log('\nGET /pricing:');
  {
    const { status, json } = await get('/pricing');
    assert(status === 200, `status 200 (${status})`);
    assert(typeof json === 'object' && json !== null, 'body is object');
    assert(typeof json?.region === 'string' && json.region.length > 0, 'region field is non-empty string');
    const modelKeys = Object.keys(json?.models || {});
    assert(modelKeys.some(k => k.startsWith('claude-')), 'pricing.models has claude-* keys');
  }

  // ─── GET /threshold ─────────────────────────────────────────────────────────
  console.log('\nGET /threshold:');
  {
    const { status, json } = await get('/threshold');
    assert(status === 200, `status 200 (${status})`);
    assert(typeof json?.threshold === 'number' && json.threshold > 0, 'threshold > 0');
    assert(typeof json?.expensiveAllowed === 'boolean', 'expensiveAllowed is boolean');
  }

  // ─── POST /allow-expensive ──────────────────────────────────────────────────
  console.log('\nPOST /allow-expensive:');
  {
    const { status, json } = await post('/allow-expensive');
    assert(status === 200, `status 200 (${status})`);
    assert(json?.status === 'approved', 'status="approved"');
    assert(typeof json?.threshold === 'number', 'threshold is number');

    // After approval, /threshold should reflect expensiveAllowed=true
    const { json: thr } = await get('/threshold');
    assert(thr?.expensiveAllowed === true, 'GET /threshold now reports expensiveAllowed=true');
  }

  // ─── GET /v1/bigquery/status ────────────────────────────────────────────────
  console.log('\nGET /v1/bigquery/status:');
  {
    const { status, json } = await get('/v1/bigquery/status');
    assert(status === 200, `status 200 (${status})`);
    assert(typeof json?.validator_ready === 'boolean', 'validator_ready is boolean');
    assert(typeof json?.scan_limit_gb === 'number' && json.scan_limit_gb > 0, 'scan_limit_gb > 0');
    assert(typeof json?.message === 'string', 'message is string');
    // With BIGQUERY_ENABLED=false, validator should not be ready
    assert(json?.validator_ready === false, 'validator_ready=false when BIGQUERY_ENABLED=false');
  }

  // ─── GET /budget ────────────────────────────────────────────────────────────
  console.log('\nGET /budget:');
  {
    const { status, json } = await get('/budget');
    assert(status === 200, `status 200 (${status})`);
    assert(json?.status === 'OK' || json?.status === 'BLOCKED', `status OK|BLOCKED (${json?.status})`);
    assert(json?.monthly?.claude && typeof json.monthly.claude.limitUSD === 'number', 'monthly.claude.limitUSD is number');
    assert(json?.monthly?.bigquery && typeof json.monthly.bigquery.limitEUR === 'number', 'monthly.bigquery.limitEUR is number');
    assert(typeof json?.bigquery?.dailyLimitGB === 'number', 'bigquery.dailyLimitGB is number');
    assert(Array.isArray(json?.limits?.bigquery?.allowedRegions), 'limits.bigquery.allowedRegions is array');
    assert(typeof json?.limits?.bigquery?.blockNonEuTables === 'boolean', 'limits.bigquery.blockNonEuTables is boolean');
    assert(typeof json?.session?.costUSD === 'number', 'session.costUSD is number');
  }

  // ─── POST /v1/bigquery/validate ─────────────────────────────────────────────
  console.log('\nPOST /v1/bigquery/validate:');
  {
    // Missing sql → 400
    const { status, json } = await post('/v1/bigquery/validate', {});
    assert(status === 400, `no sql → 400 (${status})`);
    assert(json?.error?.type === 'invalid_request', 'error.type=invalid_request');
  }
  {
    // Wrong type for sql → 400
    const { status, json } = await post('/v1/bigquery/validate', { sql: 123 });
    assert(status === 400, `non-string sql → 400 (${status})`);
    assert(json?.error?.type === 'invalid_request', 'error.type=invalid_request');
  }
  {
    // Valid-ish sql with no referenced tables; validator not initialized (BQ disabled)
    // → table check passes (no tables), dry-run skipped with warning, returns 200.
    const { status, json } = await post('/v1/bigquery/validate', { sql: 'SELECT 1' });
    assert(status === 200, `valid sql (no tables) → 200 (${status})`);
    assert(json?.type === 'success', 'type=success');
    assert(typeof json?.request_id === 'string', 'request_id is uuid string');
    assert(json?.query_validation?.status === 'approved', 'query_validation.status=approved');
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
} finally {
  await new Promise(resolve => server.close(resolve));
}

process.exit(failed === 0 ? 0 : 1);
