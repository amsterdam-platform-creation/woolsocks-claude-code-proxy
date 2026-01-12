/**
 * BigQuery Table Size & Location Checker
 *
 * Pre-checks tables BEFORE query validation:
 * 1. Blocks queries on tables larger than threshold (prevents massive scans)
 * 2. Blocks queries on non-EU tables (prevents cross-region transfer costs)
 *
 * The cross-region check is critical: querying US data from EU caused a
 * CHF 1,479 cost spike (90% of a CHF 1,638 incident) due to egress fees.
 *
 * Table metadata is cached for 5 minutes to avoid repeated lookups.
 */

import { BigQuery } from '@google-cloud/bigquery';

const MAX_TABLE_SIZE_GB = parseInt(process.env.BIGQUERY_MAX_TABLE_SIZE_GB || '50');
const MAX_TABLE_SIZE_BYTES = MAX_TABLE_SIZE_GB * 1024 * 1024 * 1024;

// Allowed regions for tables - blocks cross-region transfer costs
// EU multi-region and specific EU locations are safe
const ALLOWED_REGIONS = (process.env.BIGQUERY_ALLOWED_REGIONS || 'EU,europe-west1,europe-west2,europe-west3,europe-west4,europe-north1').split(',').map(r => r.trim().toUpperCase());

// Whether to block or just warn on non-EU tables
const BLOCK_NON_EU_TABLES = process.env.BIGQUERY_BLOCK_NON_EU !== 'false'; // Default: block

let client = null;
let checkerInitialized = false;

// Cache: tableRef -> { sizeBytes, location, timestamp }
const tableCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Initialize table checker with BigQuery client
 * Can be called with existing client from validator, or will create its own
 * @param {BigQuery|null} existingClient - Optional existing BigQuery client
 */
export function initTableChecker(existingClient = null) {
  if (checkerInitialized) return;

  if (existingClient) {
    client = existingClient;
    checkerInitialized = true;
    console.log(`[TableChecker] Initialized with existing client (max table size: ${MAX_TABLE_SIZE_GB}GB)`);
  } else {
    try {
      client = new BigQuery({
        projectId: process.env.GCP_PROJECT_ID,
      });
      checkerInitialized = true;
      console.log(`[TableChecker] Initialized new client (max table size: ${MAX_TABLE_SIZE_GB}GB)`);
    } catch (err) {
      console.error('[TableChecker] Initialization failed:', err.message);
    }
  }
}

/**
 * Extract table references from SQL query
 * Handles various formats:
 * - `project.dataset.table`
 * - project.dataset.table
 * - dataset.table (uses default project)
 * - FROM/JOIN clauses
 *
 * @param {string} sql - SQL query to parse
 * @returns {string[]} Array of table references
 */
export function extractTableReferences(sql) {
  const tables = new Set();

  // Remove comments and string literals to avoid false matches
  const cleanSql = sql
    .replace(/--.*$/gm, '') // Remove single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
    .replace(/'[^']*'/g, "''") // Replace string literals
    .replace(/"[^"]*"/g, '""'); // Replace quoted identifiers content

  // Pattern for fully qualified tables: project.dataset.table
  // Handles backticks and unquoted names
  const fullPattern = /(?:FROM|JOIN)\s+`?([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)`?/gi;

  // Pattern for dataset.table (no project)
  const shortPattern = /(?:FROM|JOIN)\s+`?([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)`?(?!\s*\.)/gi;

  let match;

  // Extract fully qualified tables
  while ((match = fullPattern.exec(cleanSql)) !== null) {
    const [, project, dataset, table] = match;
    tables.add(`${project}.${dataset}.${table}`.replace(/`/g, ''));
  }

  // Extract dataset.table references
  while ((match = shortPattern.exec(cleanSql)) !== null) {
    const [, dataset, table] = match;
    // Skip if this looks like a function call or keyword
    if (!['GROUP', 'ORDER', 'WHERE', 'AND', 'OR', 'ON', 'AS'].includes(dataset.toUpperCase())) {
      tables.add(`${dataset}.${table}`.replace(/`/g, ''));
    }
  }

  return Array.from(tables);
}

/**
 * Get table metadata including size and location (with caching)
 * @param {string} tableRef - Table reference (project.dataset.table or dataset.table)
 * @returns {Promise<{sizeBytes: number, location: string}>} Table metadata
 */
async function getTableMetadata(tableRef) {
  // Check cache first
  const cached = tableCache.get(tableRef);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { sizeBytes: cached.sizeBytes, location: cached.location };
  }

  // Parse table reference
  const parts = tableRef.split('.');
  let projectId, datasetId, tableId;

  if (parts.length === 3) {
    [projectId, datasetId, tableId] = parts;
  } else if (parts.length === 2) {
    projectId = process.env.GCP_PROJECT_ID;
    [datasetId, tableId] = parts;
  } else {
    throw new Error(`Invalid table reference: ${tableRef}`);
  }

  // Fetch table metadata (includes dataset location)
  const table = client.dataset(datasetId, { projectId }).table(tableId);
  const [metadata] = await table.getMetadata();
  const sizeBytes = parseInt(metadata.numBytes || '0');
  const location = metadata.location || 'UNKNOWN';

  // Cache result
  tableCache.set(tableRef, { sizeBytes, location, timestamp: Date.now() });
  console.log(`[TableChecker] Cached ${tableRef}: ${(sizeBytes / 1e9).toFixed(2)}GB in ${location}`);

  return { sizeBytes, location };
}

/**
 * Check if any referenced tables exceed size limit or are in non-EU regions
 * @param {string} sql - SQL query to check
 * @returns {Promise<{approved: boolean, blockedTables?: array, nonEuTables?: array, tablesChecked?: array, message?: string}>}
 */
export async function checkTableSizes(sql) {
  if (!checkerInitialized || !client) {
    return { approved: true, warning: 'Table checker not initialized - skipping size/location check' };
  }

  const tables = extractTableReferences(sql);
  if (tables.length === 0) {
    return { approved: true, tablesChecked: [] };
  }

  const blockedTables = [];  // Tables exceeding size limit
  const nonEuTables = [];    // Tables in non-EU regions (cross-region transfer risk)
  const checkedTables = [];

  for (const tableRef of tables) {
    try {
      const { sizeBytes, location } = await getTableMetadata(tableRef);
      const sizeGB = sizeBytes / (1024 ** 3);
      const isEuRegion = ALLOWED_REGIONS.includes(location.toUpperCase());

      checkedTables.push({
        table: tableRef,
        sizeGB: parseFloat(sizeGB.toFixed(2)),
        location,
        isEuRegion,
      });

      // Check size limit
      if (sizeBytes > MAX_TABLE_SIZE_BYTES) {
        blockedTables.push({
          table: tableRef,
          sizeGB: parseFloat(sizeGB.toFixed(2)),
          limitGB: MAX_TABLE_SIZE_GB,
          reason: 'size',
        });
      }

      // Check region (cross-region transfer is expensive!)
      if (!isEuRegion) {
        nonEuTables.push({
          table: tableRef,
          location,
          allowedRegions: ALLOWED_REGIONS,
          reason: 'non_eu_region',
          warning: `Table is in ${location} - querying from EU will incur cross-region transfer costs (~€0.08-0.12/GB)`,
        });
      }
    } catch (err) {
      // If we can't check a table, log warning but don't block
      // This handles cases like wildcards, external tables, etc.
      console.warn(`[TableChecker] Could not check ${tableRef}: ${err.message}`);
      checkedTables.push({
        table: tableRef,
        error: err.message,
        skipped: true,
      });
    }
  }

  // Block if tables exceed size limit
  if (blockedTables.length > 0) {
    const blockedList = blockedTables.map(t => `${t.table} (${t.sizeGB}GB)`).join(', ');
    console.log(`[TableChecker] BLOCKED - tables exceed ${MAX_TABLE_SIZE_GB}GB limit: ${blockedList}`);

    return {
      approved: false,
      reason: 'table_too_large',
      blockedTables,
      nonEuTables,
      tablesChecked: checkedTables,
      message: `Query references tables exceeding ${MAX_TABLE_SIZE_GB}GB limit: ${blockedList}`,
    };
  }

  // Block if tables are in non-EU region (unless disabled)
  if (nonEuTables.length > 0 && BLOCK_NON_EU_TABLES) {
    const nonEuList = nonEuTables.map(t => `${t.table} (${t.location})`).join(', ');
    console.log(`[TableChecker] BLOCKED - non-EU tables detected: ${nonEuList}`);
    console.log(`[TableChecker] Cross-region transfer would cost ~€0.08-0.12/GB. This caused a CHF 1,479 cost spike.`);

    return {
      approved: false,
      reason: 'non_eu_region',
      blockedTables,
      nonEuTables,
      tablesChecked: checkedTables,
      message: `Query references tables outside EU region: ${nonEuList}. ` +
        `Cross-region transfer costs ~€0.08-0.12/GB. Move tables to EU or set BIGQUERY_BLOCK_NON_EU=false to allow.`,
    };
  }

  // Warn about non-EU tables if not blocking
  if (nonEuTables.length > 0) {
    const nonEuList = nonEuTables.map(t => `${t.table} (${t.location})`).join(', ');
    console.warn(`[TableChecker] WARNING - non-EU tables: ${nonEuList} - cross-region costs may apply`);
  }

  return {
    approved: true,
    tablesChecked: checkedTables,
    nonEuTables: nonEuTables.length > 0 ? nonEuTables : undefined,
    warning: nonEuTables.length > 0
      ? `Tables in non-EU regions detected: ${nonEuTables.map(t => t.table).join(', ')}. Cross-region costs may apply.`
      : undefined,
  };
}

/**
 * Get the configured max table size in GB
 * @returns {number}
 */
export function getMaxTableSizeGB() {
  return MAX_TABLE_SIZE_GB;
}

/**
 * Check if table checker is ready
 * @returns {boolean}
 */
export function isTableCheckerReady() {
  return checkerInitialized && client !== null;
}

/**
 * Clear the table size cache (for testing)
 */
export function clearCache() {
  tableCache.clear();
}

/**
 * Get allowed regions for tables
 * @returns {string[]}
 */
export function getAllowedRegions() {
  return ALLOWED_REGIONS;
}

/**
 * Check if non-EU tables are blocked
 * @returns {boolean}
 */
export function isBlockingNonEuTables() {
  return BLOCK_NON_EU_TABLES;
}
