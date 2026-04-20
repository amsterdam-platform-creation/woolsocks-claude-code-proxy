// test/test-bigquery.js — Unit tests for BigQuery modules (pure-logic surface only)
// Network calls (dry-run, table metadata, streaming insert) are NOT exercised here.
import {
  extractTableReferences,
  getMaxTableSizeGB,
  getAllowedRegions,
  isBlockingNonEuTables,
  clearCache,
} from '../src/bigquery-table-checker.js';
import {
  formatValidationResponse,
  formatValidationLog,
  getScanLimit,
  getDailyLimitGB,
  getMonthlyLimitEUR,
} from '../src/bigquery-validator.js';
import { formatMetadata } from '../src/bigquery-logger.js';

let passed = 0;
let failed = 0;

function assert(condition, label, got = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${got ? ' — got: ' + JSON.stringify(got) : ''}`);
    failed++;
  }
}

console.log('🧪 BigQuery module tests\n');

// ─── extractTableReferences — SQL parser ──────────────────────────────────────
console.log('extractTableReferences:');
{
  const tables = extractTableReferences('SELECT * FROM `proj.ds.tbl` WHERE x = 1');
  assert(tables.includes('proj.ds.tbl'), 'fully-qualified backticked table', tables);
}
{
  const tables = extractTableReferences('SELECT * FROM proj.ds.tbl');
  assert(tables.includes('proj.ds.tbl'), 'fully-qualified unquoted table', tables);
}
{
  const tables = extractTableReferences('SELECT * FROM ds.tbl');
  assert(tables.includes('ds.tbl'), 'dataset.table short form', tables);
}
{
  const sql = 'SELECT * FROM `p.d.a` JOIN `p.d.b` ON a.id = b.id';
  const tables = extractTableReferences(sql);
  assert(tables.includes('p.d.a') && tables.includes('p.d.b'), 'extracts both sides of JOIN', tables);
}
{
  const tables = extractTableReferences('SELECT 1 -- FROM fake.table\nFROM real.tbl');
  assert(tables.includes('real.tbl') && !tables.includes('fake.table'), 'ignores tables in line comments', tables);
}
{
  const tables = extractTableReferences("SELECT 'FROM quoted.string' FROM real.tbl");
  assert(tables.includes('real.tbl') && !tables.includes('quoted.string'), 'ignores tables in string literals', tables);
}
{
  const tables = extractTableReferences('SELECT a FROM t WHERE a.b = 1 GROUP BY a.b');
  assert(!tables.some(t => t.startsWith('GROUP.') || t.startsWith('WHERE.')), 'skips SQL keywords as pseudo-tables', tables);
}
{
  const tables = extractTableReferences('SELECT 1');
  assert(Array.isArray(tables) && tables.length === 0, 'no tables → empty array', tables);
}

// ─── formatValidationResponse ─────────────────────────────────────────────────
console.log('\nformatValidationResponse:');
{
  const resp = formatValidationResponse({
    approved: true,
    bytesScanned: 5_000_000_000,
    estimatedGB: '4.66',
    scanLimitGB: 10,
    reason: 'within_limit',
    message: 'OK',
  });
  assert(resp.query_validation.status === 'approved', 'approved → status=approved');
  assert(resp.query_validation.bytes_scanned === 5_000_000_000, 'passes through bytes_scanned');
  assert(resp.query_validation.error === null, 'error defaults to null when absent');
  assert(resp.query_validation.warning === null, 'warning defaults to null when absent');
}
{
  const resp = formatValidationResponse({
    approved: false,
    bytesScanned: 20e9,
    estimatedGB: '18.6',
    scanLimitGB: 10,
    reason: 'exceeds_scan_limit',
    message: 'too big',
    error: 'scan_exceeded',
  });
  assert(resp.query_validation.status === 'blocked', 'not-approved → status=blocked');
  assert(resp.query_validation.error === 'scan_exceeded', 'passes through error');
}

// ─── formatValidationLog ──────────────────────────────────────────────────────
console.log('\nformatValidationLog:');
{
  const log = formatValidationLog(
    'SELECT * FROM t',
    { approved: true, bytesScanned: 1234, estimatedGB: '0.00', scanLimitGB: 10, reason: 'ok' },
    'req-123'
  );
  assert(log.event_type === 'query_validation', 'event_type set');
  assert(log.request_id === 'req-123', 'request_id passed through');
  assert(typeof log.query_hash === 'string' && log.query_hash.length === 16, 'query_hash is 16-char hex');
  assert(log.query_length === 'SELECT * FROM t'.length, 'query_length matches');
  assert(log.timestamp instanceof Date, 'timestamp is Date');
  assert(log.insertion_timestamp instanceof Date, 'insertion_timestamp is Date');
  assert(log.approved === true, 'approved passed through');

  // Hash is deterministic
  const log2 = formatValidationLog('SELECT * FROM t', { approved: true, bytesScanned: 0, estimatedGB: '0', scanLimitGB: 10, reason: 'ok' }, 'req-456');
  assert(log.query_hash === log2.query_hash, 'same SQL → same query_hash');
}

// ─── formatMetadata ───────────────────────────────────────────────────────────
console.log('\nformatMetadata:');
{
  const meta = formatMetadata({
    request_id: 'abc',
    model: 'claude-sonnet-4-6',
    messages_count: 3,
    stream: true,
    max_tokens: 1024,
    estimated_input_tokens: 500,
    actual_input_tokens: 512,
    actual_cost_usd: 0.0123,
  });
  assert(meta.request_id === 'abc', 'request_id coerced to string');
  assert(meta.model === 'claude-sonnet-4-6', 'model passed through');
  assert(meta.region === 'eu', 'region defaults to "eu"');
  assert(meta.stream === true, 'stream=true preserved');
  assert(meta.messages_count === 3, 'messages_count as number');
  assert(meta.actual_cost_usd === 0.0123, 'actual_cost_usd as float');
  assert(meta.timestamp instanceof Date, 'timestamp is Date');
  assert(meta.insertion_timestamp instanceof Date, 'insertion_timestamp is Date');
}
{
  const meta = formatMetadata({});
  assert(meta.model === 'unknown', 'missing model → "unknown"');
  assert(meta.stream === false, 'missing stream → false');
  assert(meta.messages_count === null, 'missing numeric field → null');
  assert(meta.user_context === null, 'missing user_context → null');
  assert(meta.request_id === '', 'missing request_id → empty string');
}
{
  // stream: anything-not-true is coerced to false
  const m1 = formatMetadata({ stream: 'true' });
  const m2 = formatMetadata({ stream: 1 });
  assert(m1.stream === false && m2.stream === false, 'stream non-boolean-true coerces to false');
}

// ─── Environment-backed getters ───────────────────────────────────────────────
console.log('\nenv-backed getters:');
assert(typeof getScanLimit() === 'number' && getScanLimit() > 0, `getScanLimit > 0 (${getScanLimit()})`);
assert(typeof getDailyLimitGB() === 'number' && getDailyLimitGB() > 0, `getDailyLimitGB > 0 (${getDailyLimitGB()})`);
assert(typeof getMonthlyLimitEUR() === 'number' && getMonthlyLimitEUR() > 0, `getMonthlyLimitEUR > 0 (${getMonthlyLimitEUR()})`);
assert(typeof getMaxTableSizeGB() === 'number' && getMaxTableSizeGB() > 0, `getMaxTableSizeGB > 0 (${getMaxTableSizeGB()})`);
{
  const regions = getAllowedRegions();
  assert(Array.isArray(regions) && regions.length > 0, 'getAllowedRegions is non-empty array');
  assert(regions.every(r => r === r.toUpperCase()), 'allowed regions are upper-cased');
  assert(regions.includes('EU') || regions.some(r => r.startsWith('EUROPE-')), 'allowed regions include EU / europe-*');
}
assert(typeof isBlockingNonEuTables() === 'boolean', 'isBlockingNonEuTables returns boolean');

// ─── clearCache — idempotent, no throw ────────────────────────────────────────
console.log('\nclearCache:');
{
  let threw = false;
  try { clearCache(); clearCache(); } catch { threw = true; }
  assert(!threw, 'clearCache is idempotent and safe to call twice');
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
