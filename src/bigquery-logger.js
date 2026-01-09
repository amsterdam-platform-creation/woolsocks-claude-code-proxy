/**
 * BigQuery Logger - Non-blocking audit logging for Claude API proxy
 *
 * Features:
 * - Async logging (doesn't block API responses)
 * - Exponential backoff with jitter for reliability
 * - Idempotent initialization (safe to call multiple times)
 * - Graceful degradation (proxy works even if BigQuery fails)
 * - EU region only (GDPR compliant)
 */

import { BigQuery } from '@google-cloud/bigquery';
import { promisify } from 'util';

const sleep = promisify(setTimeout);

// Initialization state: pending | initialized | failed
let initState = 'pending';
let bigQueryClient = null;
let logsTable = null;

// Table schema for BigQuery
const TABLE_SCHEMA = [
  { name: 'timestamp', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'request_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'model', type: 'STRING', mode: 'REQUIRED' },
  { name: 'region', type: 'STRING', mode: 'REQUIRED' },
  { name: 'messages_count', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'system_prompt_length', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'stream', type: 'BOOLEAN', mode: 'NULLABLE' },
  { name: 'max_tokens', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'estimated_input_tokens', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'estimated_output_tokens', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'estimated_cost_usd', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'actual_input_tokens', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'actual_output_tokens', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'actual_cost_usd', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'cost_difference', type: 'FLOAT', mode: 'NULLABLE' },
  { name: 'response_time_ms', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'user_context', type: 'STRING', mode: 'NULLABLE' },
  { name: 'insertion_timestamp', type: 'TIMESTAMP', mode: 'NULLABLE' },
];

/**
 * Initialize BigQuery client and create dataset/table if needed
 * Non-blocking: Proxy continues even if this fails
 */
export async function initBigQuery() {
  // Idempotent: only initialize once
  if (initState !== 'pending') {
    return;
  }

  try {
    const projectId = process.env.GCP_PROJECT_ID;
    const datasetId = process.env.BIGQUERY_DATASET;
    const tableId = process.env.BIGQUERY_LOG_TABLE;

    if (!projectId || !datasetId || !tableId) {
      throw new Error(
        `Missing BigQuery config: PROJECT=${projectId}, DATASET=${datasetId}, TABLE=${tableId}`
      );
    }

    // Initialize BigQuery client
    bigQueryClient = new BigQuery({ projectId });

    // Create dataset (idempotent)
    const dataset = bigQueryClient.dataset(datasetId);
    try {
      await dataset.create({
        location: 'EU',
        description: 'Claude API proxy audit logs',
      });
      console.log(`[BigQuery] Created dataset: ${datasetId}`);
    } catch (err) {
      if (err.code === 409 || err.message.includes('Already exists')) {
        console.log(`[BigQuery] Dataset already exists: ${datasetId}`);
      } else {
        throw err;
      }
    }

    // Create table (idempotent)
    logsTable = dataset.table(tableId);
    try {
      await logsTable.create({
        schema: TABLE_SCHEMA,
        partitioning: {
          type: 'DAY',
          field: 'timestamp',
        },
        clustering: {
          fields: ['model', 'region'],
        },
        timePartitioning: {
          expirationMs: 7776000000, // 90 days in ms
          field: 'timestamp',
          type: 'DAY',
        },
      });
      console.log(`[BigQuery] Created table: ${datasetId}.${tableId}`);
    } catch (err) {
      if (err.code === 409 || err.message.includes('Already exists')) {
        console.log(`[BigQuery] Table already exists: ${datasetId}.${tableId}`);
      } else {
        throw err;
      }
    }

    initState = 'initialized';
    console.log('[BigQuery] Initialized successfully');
  } catch (err) {
    initState = 'failed';
    console.error('[BigQuery] Initialization failed:', err.message);
    // Don't throw - allow proxy to continue without logging
  }
}

/**
 * Check if BigQuery is initialized and ready
 */
export async function isInitialized() {
  return initState === 'initialized';
}

/**
 * Determine if an error is transient (should retry)
 */
function isTransientError(err) {
  // Transient errors: network issues, server errors, rate limits
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
    return true;
  }

  // HTTP status codes
  if (err.status === 429 || err.status === 503 || err.status === 502 || err.status === 504) {
    return true;
  }

  // BigQuery specific
  if (err.code === 'DEADLINE_EXCEEDED' || err.code === 'UNAVAILABLE') {
    return true;
  }

  return false;
}

/**
 * Log request to BigQuery with exponential backoff retry
 * Non-blocking: returns immediately, logs in background
 */
export async function logRequest(metadata) {
  // Only log if initialized
  if (initState !== 'initialized' || !logsTable) {
    return;
  }

  // Fire-and-forget: don't await, don't block response
  logRequestWithRetry(metadata).catch((err) => {
    console.error('[BigQuery] Failed to log request after retries:', err.message);
  });
}

/**
 * Internal: Log with exponential backoff (not exported)
 */
async function logRequestWithRetry(metadata, maxRetries = 3) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Insert into BigQuery
      await logsTable.insert([metadata]);
      // Success - return silently
      return;
    } catch (err) {
      lastError = err;

      // If not transient, don't retry
      if (!isTransientError(err)) {
        console.error(
          `[BigQuery] Permanent error (not retrying): ${err.code || err.status} - ${err.message}`
        );
        return;
      }

      // If last attempt, don't sleep
      if (attempt >= maxRetries - 1) {
        break;
      }

      // Exponential backoff with jitter: 2^attempt * 100ms ± 50%
      const baseDelay = Math.pow(2, attempt) * 100;
      const jitter = Math.random() * baseDelay;
      const delayMs = baseDelay + jitter;

      console.warn(`[BigQuery] Retry ${attempt + 1}/${maxRetries} in ${Math.round(delayMs)}ms...`);
      await sleep(delayMs);
    }
  }

  // All retries exhausted
  console.error('[BigQuery] Failed to log request after', maxRetries, 'retries:', lastError?.message);
}

/**
 * Get recent request stats (for debugging)
 * Returns last N requests from BigQuery
 */
export async function getRequestStats(limit = 10) {
  if (initState !== 'initialized' || !logsTable) {
    return { error: 'BigQuery not initialized' };
  }

  try {
    const query = `
      SELECT
        timestamp,
        request_id,
        model,
        stream,
        estimated_cost_usd,
        actual_cost_usd,
        response_time_ms
      FROM \`${logsTable.dataset.projectId}.${logsTable.dataset.id}.${logsTable.id}\`
      WHERE DATE(timestamp) = CURRENT_DATE()
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `;

    const [rows] = await logsTable.dataset.parent.query({ query });
    return rows;
  } catch (err) {
    console.error('[BigQuery] Error fetching stats:', err.message);
    return { error: err.message };
  }
}

/**
 * Helper: Format metadata for BigQuery insertion
 * Ensures all fields are properly typed
 */
export function formatMetadata(data) {
  return {
    timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
    request_id: String(data.request_id || ''),
    model: String(data.model || 'unknown'),
    region: String(data.region || 'eu'),
    messages_count: data.messages_count ? parseInt(data.messages_count) : null,
    system_prompt_length: data.system_prompt_length ? parseInt(data.system_prompt_length) : null,
    stream: data.stream === true ? true : false,
    max_tokens: data.max_tokens ? parseInt(data.max_tokens) : null,
    estimated_input_tokens: data.estimated_input_tokens ? parseInt(data.estimated_input_tokens) : null,
    estimated_output_tokens: data.estimated_output_tokens ? parseInt(data.estimated_output_tokens) : null,
    estimated_cost_usd: data.estimated_cost_usd ? parseFloat(data.estimated_cost_usd) : null,
    actual_input_tokens: data.actual_input_tokens ? parseInt(data.actual_input_tokens) : null,
    actual_output_tokens: data.actual_output_tokens ? parseInt(data.actual_output_tokens) : null,
    actual_cost_usd: data.actual_cost_usd ? parseFloat(data.actual_cost_usd) : null,
    cost_difference: data.cost_difference ? parseFloat(data.cost_difference) : null,
    response_time_ms: data.response_time_ms ? parseInt(data.response_time_ms) : null,
    user_context: data.user_context ? String(data.user_context) : null,
    insertion_timestamp: new Date(),
  };
}
