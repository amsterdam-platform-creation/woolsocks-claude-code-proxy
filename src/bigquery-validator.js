/**
 * BigQuery Query Validator
 *
 * Estimates query scan size BEFORE execution and blocks expensive queries.
 * Prevents runaway queries that would scan >10GB of data.
 *
 * Uses BigQuery EXPLAIN (dry run) to estimate bytes scanned without execution cost.
 */

import { BigQuery } from '@google-cloud/bigquery';
import { createHash } from 'crypto';

const SCAN_LIMIT_GB = parseInt(process.env.BIGQUERY_SCAN_LIMIT_GB || '10');
const SCAN_LIMIT_BYTES = SCAN_LIMIT_GB * 1024 * 1024 * 1024;

let client = null;
let validatorInitialized = false;
let validationFailed = false;

/**
 * Initialize BigQuery client for query validation
 * Same as bigquery-logger but kept separate for modularity
 */
export async function initValidator() {
  if (validatorInitialized || validationFailed) return;

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
 * @param {string} sql - SQL query to estimate
 * @returns {Promise<{bytesScanned: number, estimatedGB: number, approved: boolean, reason: string}>}
 */
export async function estimateQueryScan(sql) {
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

    // Determine if query is approved
    const approved = bytesScanned <= SCAN_LIMIT_BYTES;
    const reason = approved ? 'within_limit' : 'exceeds_limit';

    return {
      bytesScanned,
      estimatedGB: parseFloat(estimatedGB.toFixed(2)),
      scanLimitGB: SCAN_LIMIT_GB,
      approved,
      reason,
      message: approved
        ? `Query approved: scans ${estimatedGB.toFixed(2)}GB (limit: ${SCAN_LIMIT_GB}GB)`
        : `Query blocked: would scan ${estimatedGB.toFixed(2)}GB (limit: ${SCAN_LIMIT_GB}GB)`,
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
