// src/rate-limiter.js - Rate limiting per MCP tool for cost control
// Counts tool invocations per proxy session (resets on restart)

const LIMITS = {
  zendesk: 50,           // ~500 tickets at 10/call
  jira: 100,             // Higher volume, less sensitive
  'slack-messaging': 50, // Conversation batches
  sentry: 30,            // Error batches
  confluence: 50,        // Documentation pages
  github: 50,            // Code/PRs
  lokalise: 50,          // Translations
};
const DEFAULT_LIMIT = 50;

// In-memory counters (reset on proxy restart)
const counters = new Map();

// Record a tool invocation and return current count
export function recordToolUse(toolName) {
  const count = (counters.get(toolName) || 0) + 1;
  counters.set(toolName, count);
  const limit = LIMITS[toolName] || DEFAULT_LIMIT;

  // Warn when approaching limit
  if (count === Math.floor(limit * 0.8)) {
    console.log(`[RateLimit] ${toolName}: ${count}/${limit} (80% - approaching limit)`);
  }
  if (count === limit) {
    console.log(`[RateLimit] ${toolName}: ${count}/${limit} - LIMIT REACHED`);
  }

  return count;
}

// Check if tool is over its limit
export function isOverLimit(toolName) {
  const count = counters.get(toolName) || 0;
  const limit = LIMITS[toolName] || DEFAULT_LIMIT;
  return count >= limit;
}

// Get limit for a tool
export function getLimit(toolName) {
  return LIMITS[toolName] || DEFAULT_LIMIT;
}

// Get all stats
export function getStats() {
  return Object.fromEntries(counters);
}
