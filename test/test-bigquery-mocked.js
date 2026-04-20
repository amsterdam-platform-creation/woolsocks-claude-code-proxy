// test/test-bigquery-mocked.js — Tests for BQ network paths using mocked clients + fs fixtures.
// Disables real GCP calls via BIGQUERY_ENABLED=false, and injects a stub BigQuery client
// into the table-checker (which accepts one via initTableChecker).
//
// The validator holds module-level state (currentDateKey, dailyBytesScanned, client).
// Each scenario uses a cache-busting dynamic import so state doesn't leak between tests.

process.env.BIGQUERY_ENABLED = 'false';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COSTS_FILE = path.join(__dirname, '..', 'costs-history.json');

let passed = 0;
let failed = 0;

function assert(condition, label, got = '') {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}${got ? ' — got: ' + JSON.stringify(got) : ''}`); failed++; }
}

// ─── costs-history.json fixture helpers ───────────────────────────────────────
let savedCostsFile = null;
function backupCostsFile() {
  if (fs.existsSync(COSTS_FILE)) savedCostsFile = fs.readFileSync(COSTS_FILE, 'utf-8');
  else savedCostsFile = null;
}
function restoreCostsFile() {
  if (savedCostsFile === null) { try { fs.unlinkSync(COSTS_FILE); } catch {} }
  else fs.writeFileSync(COSTS_FILE, savedCostsFile);
}
function writeCostsFile(daily) {
  fs.writeFileSync(COSTS_FILE, JSON.stringify({ daily, monthly: {} }, null, 2));
}
function todayKey() { return new Date().toISOString().slice(0, 10); }
function monthKey() { return new Date().toISOString().slice(0, 7); }

// Fresh validator module per scenario — bypasses module-level caching.
let cbCounter = 0;
async function freshValidator() {
  const mod = await import(`../src/bigquery-validator.js?cb=${++cbCounter}`);
  await mod.initValidator();
  return mod;
}

console.log('🧪 BigQuery mocked-network tests\n');
backupCostsFile();

// ─── isTransientError (pure) ──────────────────────────────────────────────────
console.log('isTransientError:');
{
  const { isTransientError } = await import('../src/bigquery-logger.js');
  assert(isTransientError({ code: 'ECONNREFUSED' }),      'ECONNREFUSED → transient');
  assert(isTransientError({ code: 'ETIMEDOUT' }),         'ETIMEDOUT → transient');
  assert(isTransientError({ code: 'ENOTFOUND' }),         'ENOTFOUND → transient');
  assert(isTransientError({ status: 429 }),               '429 → transient');
  assert(isTransientError({ status: 502 }),               '502 → transient');
  assert(isTransientError({ status: 503 }),               '503 → transient');
  assert(isTransientError({ status: 504 }),               '504 → transient');
  assert(isTransientError({ code: 'DEADLINE_EXCEEDED' }), 'DEADLINE_EXCEEDED → transient');
  assert(isTransientError({ code: 'UNAVAILABLE' }),       'UNAVAILABLE → transient');
  assert(!isTransientError({ status: 400 }),              '400 → NOT transient');
  assert(!isTransientError({ status: 401 }),              '401 → NOT transient');
  assert(!isTransientError({ status: 403 }),              '403 → NOT transient');
  assert(!isTransientError({ code: 'PERMISSION_DENIED' }),'PERMISSION_DENIED → NOT transient');
  assert(!isTransientError({}),                           'empty error → NOT transient');
}

// ─── validator: not-initialized (BIGQUERY_ENABLED=false) ──────────────────────
console.log('\nbigquery-validator — not initialized:');
{
  writeCostsFile({}); // clean slate
  const v = await freshValidator();
  assert(!v.isValidatorReady(), 'validator NOT ready when BIGQUERY_ENABLED=false');

  const result = await v.estimateQueryScan('SELECT 1');
  assert(result.approved === true,                      'uninit → approved=true (skip)');
  assert(result.reason === 'validator_not_initialized', 'reason=validator_not_initialized');
  assert(typeof result.warning === 'string',            'warning string present');
}

// ─── validator: daily-limit-exceeded path ─────────────────────────────────────
console.log('\nbigquery-validator — daily limit:');
{
  // Default DAILY_LIMIT_GB=50. Seed 100 decimal-GB for today.
  writeCostsFile({ [todayKey()]: { bytesScanned: 100 * 1e9, totalCost: 0, requests: 0, byModel: {} } });
  const v = await freshValidator();

  const result = await v.estimateQueryScan('SELECT 1');
  assert(result.approved === false,                'over daily limit → approved=false');
  assert(result.reason === 'daily_limit_exceeded', 'reason=daily_limit_exceeded');
  assert(typeof result.message === 'string',       'message present');
}

// ─── validator: monthly-limit-exceeded path ───────────────────────────────────
console.log('\nbigquery-validator — monthly limit:');
{
  // MONTHLY_LIMIT_EUR default = 20 at €0.006/GB → ~3333GB. Seed >€20 worth across days.
  // Keep today's usage tiny so daily check doesn't trip first.
  const today = todayKey();
  const m = monthKey();
  const otherDay = `${m}-01` === today ? `${m}-02` : `${m}-01`;
  const fourTB_decimal = 4 * 1e12; // ~€24
  writeCostsFile({
    [today]:    { bytesScanned: 1 * 1e9,           totalCost: 0, requests: 0, byModel: {} },
    [otherDay]: { bytesScanned: fourTB_decimal,    totalCost: 0, requests: 0, byModel: {} },
  });
  const v = await freshValidator();

  const result = await v.estimateQueryScan('SELECT 1');
  assert(result.approved === false,                  'over monthly limit → approved=false');
  assert(result.reason === 'monthly_limit_exceeded', 'reason=monthly_limit_exceeded');
  assert(typeof result.monthlySpentEUR === 'number', 'monthlySpentEUR is number');
}

// ─── status getters reflect costs-history.json ────────────────────────────────
console.log('\nstatus getters reflect costs-history.json:');
{
  writeCostsFile({ [todayKey()]: { bytesScanned: 2 * 1e9, totalCost: 0, requests: 0, byModel: {} } });
  const v = await freshValidator();

  const daily = v.getDailyBytesStatus();
  assert(daily.scannedGB === '2.00',   `daily scannedGB=2.00 (${daily.scannedGB})`);
  assert(Number(daily.percentUsed) > 0, 'daily percentUsed > 0');

  const monthly = v.getMonthlyBytesStatus();
  assert(monthly.scannedGB === '2.00',         `monthly scannedGB=2.00 (${monthly.scannedGB})`);
  assert(typeof monthly.spentEUR === 'string', 'monthly spentEUR is string (fixed-2)');
}

restoreCostsFile();

// ─── table-checker: inject mock client ────────────────────────────────────────
console.log('\nbigquery-table-checker with injected mock client:');
const {
  initTableChecker,
  checkTableSizes,
  clearCache,
  isTableCheckerReady,
} = await import('../src/bigquery-table-checker.js');

clearCache();

// Metadata fixture per tableRef (key uses projectId.datasetId.tableId)
const TABLE_META = {
  'proj.ds.tiny': { numBytes: String(1 * 1024 ** 3),   location: 'EU' },   // 1 GiB EU
  'proj.ds.huge': { numBytes: String(200 * 1024 ** 3), location: 'EU' },   // 200 GiB EU (> 50 limit)
  'proj.ds.us':   { numBytes: String(2 * 1024 ** 3),   location: 'US' },   // 2 GiB US (non-EU)
};

const stubClient = {
  dataset(datasetId, opts) {
    const projectId = opts?.projectId || 'proj';
    return {
      table(tableId) {
        const key = `${projectId}.${datasetId}.${tableId}`;
        return {
          async getMetadata() {
            const meta = TABLE_META[key];
            if (!meta) throw new Error(`mock: no metadata for ${key}`);
            return [meta];
          },
        };
      },
    };
  },
};

initTableChecker(stubClient);
assert(isTableCheckerReady(), 'table checker ready after injecting mock client');

{
  const res = await checkTableSizes('SELECT 1');
  assert(res.approved === true && res.tablesChecked.length === 0, 'no tables → approved with empty list');
}
{
  const res = await checkTableSizes('SELECT * FROM `proj.ds.tiny`');
  assert(res.approved === true, 'small EU table → approved');
}
{
  const res = await checkTableSizes('SELECT * FROM `proj.ds.huge`');
  assert(res.approved === false,                      'huge EU table → blocked');
  assert(res.reason === 'table_too_large',            `reason=table_too_large (${res.reason})`);
  assert(Array.isArray(res.blockedTables) && res.blockedTables.some(t => t.table === 'proj.ds.huge'),
    'blockedTables lists the offending table');
}
{
  const res = await checkTableSizes('SELECT * FROM `proj.ds.us`');
  assert(res.approved === false,         'US-region table → blocked');
  assert(res.reason === 'non_eu_region', `reason=non_eu_region (${res.reason})`);
}

// Cache behavior: second call for same table uses cache; clearCache refreshes.
console.log('\ntable-checker cache:');
{
  clearCache();
  const first = await checkTableSizes('SELECT * FROM `proj.ds.tiny`');
  assert(first.approved === true, 'priming call resolves EU tiny');

  const original = TABLE_META['proj.ds.tiny'];
  TABLE_META['proj.ds.tiny'] = { numBytes: String(500 * 1024 ** 3), location: 'US' };
  const second = await checkTableSizes('SELECT * FROM `proj.ds.tiny`');
  assert(second.approved === true, 'second call served from cache (ignores new blocked metadata)');

  clearCache();
  const afterClear = await checkTableSizes('SELECT * FROM `proj.ds.tiny`');
  assert(afterClear.approved === false, 'after clearCache, fresh metadata surfaces block');

  TABLE_META['proj.ds.tiny'] = original;
  clearCache();
}

// ─── formatMetadata sanity (logger surface is importable) ─────────────────────
console.log('\nformatMetadata (re-check exported shape):');
{
  const { formatMetadata } = await import('../src/bigquery-logger.js');
  const m = formatMetadata({ request_id: 'x', model: 'claude-sonnet-4-6' });
  assert(m.request_id === 'x' && m.model === 'claude-sonnet-4-6', 'basic formatMetadata still works');
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
