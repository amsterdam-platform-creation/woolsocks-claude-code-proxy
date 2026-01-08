// src/cost-tracker.js - Cost tracking with Vertex AI europe-west1 pricing
// Prices per 1 million tokens (10% regional premium included)

const VERTEX_EU_PRICING = {
  // Claude Opus 4.5 (europe-west1 regional pricing)
  'claude-opus-4-5': { input: 5.50, output: 27.50, cacheWrite: 6.875, cacheRead: 0.55 },
  'claude-opus-4-5@20251101': { input: 5.50, output: 27.50, cacheWrite: 6.875, cacheRead: 0.55 },

  // Claude Sonnet 4 (europe-west1 regional pricing)
  'claude-sonnet-4': { input: 3.30, output: 16.50, cacheWrite: 4.125, cacheRead: 0.33 },
  'claude-sonnet-4@20250514': { input: 3.30, output: 16.50, cacheWrite: 4.125, cacheRead: 0.33 },

  // Claude Haiku 3.5 (europe-west1 regional pricing)
  'claude-3-5-haiku': { input: 1.10, output: 5.50, cacheWrite: 1.375, cacheRead: 0.11 },
  'claude-3-5-haiku@20241022': { input: 1.10, output: 5.50, cacheWrite: 1.375, cacheRead: 0.11 },
};

// Default fallback (Opus pricing)
const DEFAULT_PRICING = { input: 5.50, output: 27.50, cacheWrite: 6.875, cacheRead: 0.55 };

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

  console.log(`[Cost] Request: $${cost.totalCost.toFixed(4)} | Session: $${sessionCost.totalCostUSD.toFixed(4)} | Model: ${modelKey}`);

  return cost;
}

/**
 * Get session cost summary
 * @returns {object} Session cost summary
 */
export function getSessionCosts() {
  const durationMs = Date.now() - sessionCost.startTime;
  const durationMins = durationMs / 60000;

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
