// src/cost-tracker.js - Cost tracking with Vertex AI europe-west1 pricing
// Prices per 1 million tokens (10% regional premium included)
// Includes persistent storage for monthly cost tracking

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COSTS_FILE = path.join(__dirname, '..', 'costs-history.json');

const VERTEX_EU_PRICING = {
  // Claude Opus 4.5 (europe-west1 regional pricing)
  'claude-opus-4-5': { input: 5.50, output: 27.50, cacheWrite: 6.875, cacheRead: 0.55 },
  'claude-opus-4-5@20251101': { input: 5.50, output: 27.50, cacheWrite: 6.875, cacheRead: 0.55 },

  // Claude Sonnet 4 (europe-west1 regional pricing)
  'claude-sonnet-4': { input: 3.30, output: 16.50, cacheWrite: 4.125, cacheRead: 0.33 },
  'claude-sonnet-4@20250514': { input: 3.30, output: 16.50, cacheWrite: 4.125, cacheRead: 0.33 },

  // Claude Haiku 4.5 (europe-west1 regional pricing) - NEW MODEL
  'claude-haiku-4-5': { input: 1.10, output: 5.50, cacheWrite: 1.375, cacheRead: 0.11 },
  'claude-haiku-4-5@20251001': { input: 1.10, output: 5.50, cacheWrite: 1.375, cacheRead: 0.11 },

  // Claude Haiku 3.5 (europe-west1 regional pricing) - LEGACY
  'claude-3-5-haiku': { input: 1.10, output: 5.50, cacheWrite: 1.375, cacheRead: 0.11 },
  'claude-3-5-haiku@20241022': { input: 1.10, output: 5.50, cacheWrite: 1.375, cacheRead: 0.11 },
};

// Default fallback (Opus pricing)
const DEFAULT_PRICING = { input: 5.50, output: 27.50, cacheWrite: 6.875, cacheRead: 0.55 };

// Cost threshold for confirmation (in USD)
// $2 is reasonable for longer conversations with context
export const COST_THRESHOLD = 2.00;

// Flag to allow one expensive request
let allowNextExpensive = false;

/**
 * Estimate cost before sending request (worst case: full max_tokens output)
 * @param {object} request - The API request body
 * @returns {object} Estimated cost breakdown
 */
export function estimateCost(request) {
  const model = request.model || 'claude-opus-4-5';
  const vertexModel = model.replace(/-(\d{8})$/, '@$1'); // Convert to Vertex format
  const pricing = VERTEX_EU_PRICING[vertexModel] || VERTEX_EU_PRICING[model] || DEFAULT_PRICING;
  const perMillion = 1_000_000;

  // Estimate input tokens from message content (rough: ~4 chars per token)
  let inputChars = 0;
  if (request.system) {
    inputChars += typeof request.system === 'string' ? request.system.length : JSON.stringify(request.system).length;
  }
  for (const msg of request.messages || []) {
    if (typeof msg.content === 'string') {
      inputChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') inputChars += (block.text || '').length;
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          inputChars += block.content.length;
        }
      }
    }
  }

  const estimatedInputTokens = Math.ceil(inputChars / 4);
  const maxOutputTokens = request.max_tokens || 8192;

  // Use 25% of max_tokens for realistic estimate (Claude rarely maxes out)
  const estimatedOutputTokens = Math.ceil(maxOutputTokens * 0.25);

  const inputCost = estimatedInputTokens / perMillion * pricing.input;
  const outputCost = estimatedOutputTokens / perMillion * pricing.output;
  const totalEstimate = inputCost + outputCost;

  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    maxOutputTokens,
    inputCost,
    outputCost,
    totalEstimate,
    model: vertexModel,
    exceedsThreshold: totalEstimate > COST_THRESHOLD,
    threshold: COST_THRESHOLD,
  };
}

/**
 * Check if expensive request is allowed
 */
export function isExpensiveAllowed() {
  return allowNextExpensive;
}

/**
 * Allow the next expensive request (one-time flag)
 */
export function allowExpensiveRequest() {
  allowNextExpensive = true;
  console.log('[Cost] Next expensive request allowed');
}

/**
 * Reset the expensive request flag (call after request completes)
 */
export function resetExpensiveFlag() {
  if (allowNextExpensive) {
    allowNextExpensive = false;
    console.log('[Cost] Expensive request flag reset');
  }
}

// Load or initialize persistent cost history
function loadCostHistory() {
  try {
    if (fs.existsSync(COSTS_FILE)) {
      return JSON.parse(fs.readFileSync(COSTS_FILE, 'utf-8'));
    }
  } catch (err) {
    console.error('[Cost] Failed to load cost history:', err.message);
  }
  return { daily: {}, monthly: {} };
}

function saveCostHistory(history) {
  try {
    fs.writeFileSync(COSTS_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.error('[Cost] Failed to save cost history:', err.message);
  }
}

function getDateKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getMonthKey() {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

// Persist a cost to history
function persistCost(cost, model) {
  const history = loadCostHistory();
  const dateKey = getDateKey();
  const monthKey = getMonthKey();
  const modelKey = model.split('@')[0];

  // Initialize daily entry
  if (!history.daily[dateKey]) {
    history.daily[dateKey] = { totalCost: 0, requests: 0, byModel: {} };
  }
  history.daily[dateKey].totalCost += cost.totalCost;
  history.daily[dateKey].requests += 1;
  if (!history.daily[dateKey].byModel[modelKey]) {
    history.daily[dateKey].byModel[modelKey] = 0;
  }
  history.daily[dateKey].byModel[modelKey] += cost.totalCost;

  // Initialize monthly entry
  if (!history.monthly[monthKey]) {
    history.monthly[monthKey] = { totalCost: 0, requests: 0, byModel: {} };
  }
  history.monthly[monthKey].totalCost += cost.totalCost;
  history.monthly[monthKey].requests += 1;
  if (!history.monthly[monthKey].byModel[modelKey]) {
    history.monthly[monthKey].byModel[modelKey] = 0;
  }
  history.monthly[monthKey].byModel[modelKey] += cost.totalCost;

  saveCostHistory(history);
}

// Session cost tracking
let sessionCost = {
  totalCostUSD: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  requests: 0,
  byModel: {},
  startTime: Date.now(),
};

/**
 * Calculate cost from API response usage
 * @param {object} usage - Anthropic API usage object
 * @param {string} model - Model name (Vertex AI format)
 * @returns {object} Cost breakdown
 */
export function calculateCost(usage, model) {
  const pricing = VERTEX_EU_PRICING[model] || DEFAULT_PRICING;
  const perMillion = 1_000_000;

  const inputCost = (usage.input_tokens || 0) / perMillion * pricing.input;
  const outputCost = (usage.output_tokens || 0) / perMillion * pricing.output;
  const cacheWriteCost = (usage.cache_creation_input_tokens || 0) / perMillion * pricing.cacheWrite;
  const cacheReadCost = (usage.cache_read_input_tokens || 0) / perMillion * pricing.cacheRead;

  const totalCost = inputCost + outputCost + cacheWriteCost + cacheReadCost;

  return {
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    totalCost,
    model,
    pricing,
  };
}

/**
 * Record usage from an API response
 * @param {object} response - Anthropic API response with usage field
 * @param {string} model - Model name
 */
export function recordUsage(response, model) {
  if (!response?.usage) return null;

  const usage = response.usage;
  const cost = calculateCost(usage, model);

  // Update session totals
  sessionCost.totalCostUSD += cost.totalCost;
  sessionCost.inputTokens += usage.input_tokens || 0;
  sessionCost.outputTokens += usage.output_tokens || 0;
  sessionCost.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
  sessionCost.cacheReadTokens += usage.cache_read_input_tokens || 0;
  sessionCost.requests += 1;

  // Track by model
  const modelKey = model.split('@')[0]; // Normalize model name
  if (!sessionCost.byModel[modelKey]) {
    sessionCost.byModel[modelKey] = { cost: 0, tokens: 0, requests: 0 };
  }
  sessionCost.byModel[modelKey].cost += cost.totalCost;
  sessionCost.byModel[modelKey].tokens += (usage.input_tokens || 0) + (usage.output_tokens || 0);
  sessionCost.byModel[modelKey].requests += 1;

  // Persist to file for monthly tracking
  persistCost(cost, model);

  console.log(`[Cost] Request: $${cost.totalCost.toFixed(4)} | Session: $${sessionCost.totalCostUSD.toFixed(4)} | Model: ${modelKey}`);

  return cost;
}

/**
 * Get monthly cost from history
 * @returns {object} Monthly cost data
 */
export function getMonthlyCosts() {
  const history = loadCostHistory();
  const monthKey = getMonthKey();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = monthNames[new Date().getMonth()];

  const monthly = history.monthly[monthKey] || { totalCost: 0, requests: 0, byModel: {} };

  return {
    month: monthKey,
    monthName,
    totalCostUSD: monthly.totalCost,
    formattedCost: `$${monthly.totalCost.toFixed(2)}`,
    requests: monthly.requests,
    byModel: monthly.byModel,
  };
}

/**
 * Get session cost summary
 * @returns {object} Session cost summary
 */
export function getSessionCosts() {
  const durationMs = Date.now() - sessionCost.startTime;
  const durationMins = durationMs / 60000;
  const monthly = getMonthlyCosts();

  return {
    totalCostUSD: sessionCost.totalCostUSD,
    formattedCost: `$${sessionCost.totalCostUSD.toFixed(4)}`,
    tokens: {
      input: sessionCost.inputTokens,
      output: sessionCost.outputTokens,
      cacheWrite: sessionCost.cacheWriteTokens,
      cacheRead: sessionCost.cacheReadTokens,
      total: sessionCost.inputTokens + sessionCost.outputTokens +
             sessionCost.cacheWriteTokens + sessionCost.cacheReadTokens,
    },
    requests: sessionCost.requests,
    byModel: sessionCost.byModel,
    session: {
      startTime: new Date(sessionCost.startTime).toISOString(),
      durationMinutes: Math.round(durationMins * 10) / 10,
      costPerMinute: durationMins > 0 ? sessionCost.totalCostUSD / durationMins : 0,
    },
    monthly: {
      month: monthly.monthName,
      totalCostUSD: monthly.totalCostUSD,
      formattedCost: monthly.formattedCost,
      requests: monthly.requests,
    },
    pricing: 'Vertex AI europe-west1 (10% regional premium)',
  };
}

/**
 * Reset session costs (for testing or new sessions)
 */
export function resetSessionCosts() {
  sessionCost = {
    totalCostUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    requests: 0,
    byModel: {},
    startTime: Date.now(),
  };
}

/**
 * Get pricing table for display
 */
export function getPricingTable() {
  return {
    region: 'europe-west1 (Belgium)',
    note: 'Regional pricing includes 10% premium over global rates',
    models: Object.entries(VERTEX_EU_PRICING).reduce((acc, [model, pricing]) => {
      const key = model.split('@')[0];
      if (!acc[key]) {
        acc[key] = {
          inputPer1M: `$${pricing.input.toFixed(2)}`,
          outputPer1M: `$${pricing.output.toFixed(2)}`,
          cacheWritePer1M: `$${pricing.cacheWrite.toFixed(3)}`,
          cacheReadPer1M: `$${pricing.cacheRead.toFixed(2)}`,
        };
      }
      return acc;
    }, {}),
  };
}
