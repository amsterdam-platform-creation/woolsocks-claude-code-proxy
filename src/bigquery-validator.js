/**
 * BigQuery Query Validator
 *
 * Estimates query scan size BEFORE execution and blocks expensive queries.
 * Prevents runaway queries that would scan >10GB of data.
 *
 * Uses BigQuery EXPLAIN (dry run) to estimate bytes scanned without execution cost.
 *
 * Also tracks cumulative daily bytes to prevent volume attacks where many
 * small queries add up to large costs.
 */

import { BigQuery } from '@google-cloud/bigquery';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COSTS_FILE = path.join(__dirname, '..', 'costs-history.json');

// Per-query scan limit (existing)
const SCAN_LIMIT_GB = parseInt(process.env.BIGQUERY_SCAN_LIMIT_GB || '10');
const SCAN_LIMIT_BYTES = SCAN_LIMIT_GB * 1024 * 1024 * 1024;

// Daily cumulative scan limit (NEW - prevents volume attacks)
const DAILY_LIMIT_GB = parseInt(process.env.BIGQUERY_DAILY_LIMIT_GB || '50');
const DAILY_LIMIT_BYTES = DAILY_LIMIT_GB * 1024 * 1024 * 1024;

// Monthly BigQuery cost limit in EUR (converted to bytes based on €0.006/GB)
const MONTHLY_LIMIT_EUR = parseFloat(process.env.BIGQUERY_MONTHLY_LIMIT_EUR || '20');
const EUR_PER_GB = 0.006; // BigQuery EU pricing: ~€0.006 per GB scanned
const MONTHLY_LIMIT_GB = MONTHLY_LIMIT_EUR / EUR_PER_GB;
const MONTHLY_LIMIT_BYTES = MONTHLY_LIMIT_GB * 1024 * 1024 * 1024;

let client = null;
let validatorInitialized = false;
let validationFailed = false;

// Daily bytes tracking (synced with costs-history.json)
let dailyBytesScanned = 0;
let currentDateKey = '';

/**
 * Get current date key (YYYY-MM-DD)
 */
function getDateKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Load daily bytes from costs-history.json
 */
function loadDailyBytes() {
  try {
    if (fs.existsSync(COSTS_FILE)) {
      const history = JSON.parse(fs.readFileSync(COSTS_FILE, 'utf-8'));
      const dateKey = getDateKey();
      return history.daily?.[dateKey]?.bytesScanned || 0;
    }
  } catch (err) {
    console.error('[BigQueryValidator] Failed to load daily bytes:', err.message);
  }
  return 0;
}

/**
 * Persist daily bytes to costs-history.json
 */
function persistDailyBytes(bytes) {
  try {
    let history = { daily: {}, monthly: {} };
    if (fs.existsSync(COSTS_FILE)) {
      history = JSON.parse(fs.readFileSync(COSTS_FILE, 'utf-8'));
    }
    const dateKey = getDateKey();
    if (!history.daily[dateKey]) {
      history.daily[dateKey] = { totalCost: 0, requests: 0, byModel: {}, bytesScanned: 0 };
    }
    history.daily[dateKey].bytesScanned = bytes;
    fs.writeFileSync(COSTS_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error('[BigQueryValidator] Failed to persist daily bytes:', err.message);
  }
}

/**
 * Get month key (YYYY-MM)
 */
function getMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

/**
 * Calculate monthly bytes from daily entries in costs-history.json
 */
function loadMonthlyBytes() {
  try {
    if (fs.existsSync(COSTS_FILE)) {
      const history = JSON.parse(fs.readFileSync(COSTS_FILE, 'utf-8'));
      const monthKey = getMonthKey();
      let totalBytes = 0;

      // Sum all daily entries for current month
      for (const [dateKey, dayData] of Object.entries(history.daily || {})) {
        if (dateKey.startsWith(monthKey)) {
          totalBytes += dayData.bytesScanned || 0;
        }
      }
      return totalBytes;
    }
  } catch (err) {
    console.error('[BigQueryValidator] Failed to load monthly bytes:', err.message);
  }
  return 0;
}

/**
 * Initialize BigQuery client for query validation
 * Same as bigquery-logger but kept separate for modularity
 */
export async function initValidator() {
  if (validatorInitialized || validationFailed) return;

  // Check if BigQuery is explicitly disabled
  if (process.env.BIGQUERY_ENABLED === 'false') {
    validationFailed = true;
    console.log('[BigQueryValidator] Validation DISABLED via BIGQUERY_ENABLED=false');
    return;
  }

  try {
    client = new BigQuery({
      projectId: process.env.GCP_PROJECT_ID,
    });

    // Test connectivity with a simple dataset list call
    // This verifies credentials are valid without making expensive operations
    const [datasets] = await client.getDatasets({ maxResults: 1 });
    validatorInitialized = true;
    console.log('[BigQueryValidator] Initialized successfully');
  } catch (err) {
    validationFailed = true;
    console.error('[BigQueryValidator] Initialization failed:', err.message);
    console.error('[BigQueryValidator] Query validation disabled - queries will not be checked');
  }
}

/**
 * Estimate bytes that a query will scan using dry run
 *
 * BigQuery's dryRun mode estimates bytes that will be scanned without actually
 * executing the query, giving instant feedback on query cost.
 *
 * Also checks cumulative daily bytes to prevent volume attacks.
 *
 * @param {string} sql - SQL query to estimate
 * @returns {Promise<{bytesScanned: number, estimatedGB: number, approved: boolean, reason: string}>}
 */
export async function estimateQueryScan(sql) {
  // Reset daily counter at midnight (or on first call of day)
  const dateKey = getDateKey();
  if (dateKey !== currentDateKey) {
    dailyBytesScanned = loadDailyBytes();
    currentDateKey = dateKey;
    console.log(`[BigQueryValidator] Daily bytes loaded for ${dateKey}: ${(dailyBytesScanned / 1e9).toFixed(2)}GB`);
  }

  // Check if already at daily limit BEFORE making dry-run call
  if (dailyBytesScanned >= DAILY_LIMIT_BYTES) {
    console.log(`[BigQueryValidator] Daily limit exceeded: ${(dailyBytesScanned / 1e9).toFixed(2)}GB / ${DAILY_LIMIT_GB}GB`);
    return {
      bytesScanned: 0,
      estimatedGB: 0,
      approved: false,
      reason: 'daily_limit_exceeded',
      message: `Daily BigQuery limit exceeded: ${(dailyBytesScanned / 1e9).toFixed(2)}GB / ${DAILY_LIMIT_GB}GB. Resets at midnight UTC.`,
      dailyBytesScanned,
      dailyLimitGB: DAILY_LIMIT_GB,
    };
  }

  // Check monthly BigQuery budget BEFORE making dry-run call
  const monthlyBytesScanned = loadMonthlyBytes();
  const monthlySpentEUR = (monthlyBytesScanned / 1e9) * EUR_PER_GB;
  if (monthlyBytesScanned >= MONTHLY_LIMIT_BYTES) {
    console.log(`[BigQueryValidator] Monthly limit exceeded: €${monthlySpentEUR.toFixed(2)} / €${MONTHLY_LIMIT_EUR}`);
    return {
      bytesScanned: 0,
      estimatedGB: 0,
      approved: false,
      reason: 'monthly_limit_exceeded',
      message: `Monthly BigQuery budget exceeded: €${monthlySpentEUR.toFixed(2)} / €${MONTHLY_LIMIT_EUR}. Resets next month.`,
      monthlyBytesScanned,
      monthlySpentEUR,
      monthlyLimitEUR: MONTHLY_LIMIT_EUR,
    };
  }

  // If validator failed to initialize, return warning but allow query
  if (!validatorInitialized) {
    return {
      bytesScanned: 0,
      estimatedGB: 0,
      approved: true,
      reason: 'validator_not_initialized',
      warning: 'BigQuery validator not initialized - unable to check query cost',
    };
  }

  try {
    // Use dryRun to estimate bytes without executing the query
    // This is instant and doesn't cost money
    const options = {
      query: sql,
      location: 'EU',
      dryRun: true, // Key: estimates bytes without execution
    };

    const [job] = await client.createQueryJob(options);

    // For dry run jobs, statistics are available immediately in the job object
    // The totalBytesProcessed is available from the job's metadata
    const metadata = job.metadata;
    const bytesScanned = parseInt(metadata?.statistics?.query?.totalBytesProcessed || '0');
    const estimatedGB = bytesScanned / (1024 * 1024 * 1024);

    // Check per-query limit
    if (bytesScanned > SCAN_LIMIT_BYTES) {
      return {
        bytesScanned,
        estimatedGB: parseFloat(estimatedGB.toFixed(2)),
        scanLimitGB: SCAN_LIMIT_GB,
        approved: false,
        reason: 'exceeds_limit',
        message: `Query blocked: would scan ${estimatedGB.toFixed(2)}GB (limit: ${SCAN_LIMIT_GB}GB)`,
      };
    }

    // Check if this query would exceed daily cumulative limit
    if (dailyBytesScanned + bytesScanned > DAILY_LIMIT_BYTES) {
      const projectedGB = (dailyBytesScanned + bytesScanned) / 1e9;
      return {
        bytesScanned,
        estimatedGB: parseFloat(estimatedGB.toFixed(2)),
        scanLimitGB: SCAN_LIMIT_GB,
        approved: false,
        reason: 'would_exceed_daily_limit',
        message: `Query would exceed daily limit: ${projectedGB.toFixed(2)}GB / ${DAILY_LIMIT_GB}GB. Wait until midnight UTC or increase BIGQUERY_DAILY_LIMIT_GB.`,
        dailyBytesScanned,
        dailyLimitGB: DAILY_LIMIT_GB,
      };
    }

    // Query approved - within both per-query and daily limits
    return {
      bytesScanned,
      estimatedGB: parseFloat(estimatedGB.toFixed(2)),
      scanLimitGB: SCAN_LIMIT_GB,
      dailyBytesScanned,
      dailyLimitGB: DAILY_LIMIT_GB,
      approved: true,
      reason: 'within_limit',
      message: `Query approved: scans ${estimatedGB.toFixed(2)}GB (limit: ${SCAN_LIMIT_GB}GB). Daily: ${((dailyBytesScanned + bytesScanned) / 1e9).toFixed(2)}GB / ${DAILY_LIMIT_GB}GB`,
    };
  } catch (err) {
    // If dry run fails, it might be a syntax error or other issue
    // Return error so user knows the problem
    console.error('[BigQueryValidator] Dry run estimation failed:', err.message);

    return {
      bytesScanned: 0,
      estimatedGB: 0,
      approved: false,
      reason: 'validation_error',
      error: err.message,
      message: `Query validation failed: ${err.message}. Check your SQL syntax.`,
    };
  }
}

/**
 * Check if validator is ready
 * @returns {boolean}
 */
export function isValidatorReady() {
  return validatorInitialized;
}

/**
 * Get current scan limit in GB
 * @returns {number}
 */
export function getScanLimit() {
  return SCAN_LIMIT_GB;
}

/**
 * Format validation result for API response
 * @param {Object} validation - Result from estimateQueryScan
 * @returns {Object}
 */
export function formatValidationResponse(validation) {
  return {
    query_validation: {
      status: validation.approved ? 'approved' : 'blocked',
      bytes_scanned: validation.bytesScanned,
      estimated_gb: validation.estimatedGB,
      scan_limit_gb: validation.scanLimitGB,
      reason: validation.reason,
      message: validation.message,
      error: validation.error || null,
      warning: validation.warning || null,
    },
  };
}

/**
 * Format query validation for logging to BigQuery
 * @param {string} sql - The query that was validated
 * @param {Object} validation - Result from estimateQueryScan
 * @param {string} requestId - Request UUID for tracing
 * @returns {Object}
 */
export function formatValidationLog(sql, validation, requestId) {
  return {
    timestamp: new Date(),
    request_id: requestId,
    event_type: 'query_validation',
    query_hash: hashQuery(sql),
    query_length: sql.length,
    bytes_scanned: validation.bytesScanned,
    estimated_gb: validation.estimatedGB,
    scan_limit_gb: validation.scanLimitGB,
    approved: validation.approved,
    reason: validation.reason,
    error: validation.error || null,
    insertion_timestamp: new Date(),
  };
}

/**
 * Hash query for logging (don't log actual SQL for privacy)
 * @param {string} sql
 * @returns {string}
 */
function hashQuery(sql) {
  return createHash('sha256')
    .update(sql)
    .digest('hex')
    .substring(0, 16);
}

/**
 * Record bytes scanned after a successful query
 * Call this after the query actually executes (not just validation)
 * @param {number} bytes - Bytes scanned by the query
 */
export function recordBytesScanned(bytes) {
  dailyBytesScanned += bytes;
  persistDailyBytes(dailyBytesScanned);
  console.log(`[BigQueryValidator] Recorded ${(bytes / 1e9).toFixed(2)}GB. Daily total: ${(dailyBytesScanned / 1e9).toFixed(2)}GB / ${DAILY_LIMIT_GB}GB`);
}

/**
 * Get current daily bytes status
 * @returns {object} Daily bytes tracking info
 */
export function getDailyBytesStatus() {
  // Ensure we have latest data
  const dateKey = getDateKey();
  if (dateKey !== currentDateKey) {
    dailyBytesScanned = loadDailyBytes();
    currentDateKey = dateKey;
  }

  return {
    bytesScanned: dailyBytesScanned,
    scannedGB: (dailyBytesScanned / 1e9).toFixed(2),
    limitGB: DAILY_LIMIT_GB,
    remainingGB: Math.max(0, DAILY_LIMIT_GB - dailyBytesScanned / 1e9).toFixed(2),
    percentUsed: ((dailyBytesScanned / DAILY_LIMIT_BYTES) * 100).toFixed(1),
    dateKey: currentDateKey || getDateKey(),
  };
}

/**
 * Get the BigQuery client (for use by table checker)
 * @returns {BigQuery|null}
 */
export function getClient() {
  return client;
}

/**
 * Get daily limit in GB
 * @returns {number}
 */
export function getDailyLimitGB() {
  return DAILY_LIMIT_GB;
}

/**
 * Get monthly BigQuery bytes status
 * @returns {object} Monthly bytes tracking info with EUR cost
 */
export function getMonthlyBytesStatus() {
  const monthlyBytes = loadMonthlyBytes();
  const spentEUR = (monthlyBytes / 1e9) * EUR_PER_GB;
  const remainingEUR = Math.max(0, MONTHLY_LIMIT_EUR - spentEUR);

  return {
    bytesScanned: monthlyBytes,
    scannedGB: (monthlyBytes / 1e9).toFixed(2),
    scannedTB: (monthlyBytes / 1e12).toFixed(3),
    spentEUR: spentEUR.toFixed(2),
    limitEUR: MONTHLY_LIMIT_EUR,
    remainingEUR: remainingEUR.toFixed(2),
    percentUsed: ((spentEUR / MONTHLY_LIMIT_EUR) * 100).toFixed(1),
    limitGB: MONTHLY_LIMIT_GB.toFixed(0),
    month: getMonthKey(),
  };
}

/**
 * Get monthly BigQuery limit in EUR
 * @returns {number}
 */
export function getMonthlyLimitEUR() {
  return MONTHLY_LIMIT_EUR;
}
