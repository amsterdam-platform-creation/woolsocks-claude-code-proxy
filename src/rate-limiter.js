// src/rate-limiter.js - Rate limiting per MCP server (skill) for cost control
// Only limits MCP tools (external API calls), not core Claude tools
// Counts tool invocations per proxy session (resets on restart)

// MCP server limits (extracted from mcp__<server>__<tool>)
const MCP_LIMITS = {
  zendesk: 150,          // ~1500 tickets at 10/call (3x)
  jira: 100,             // Higher volume, less sensitive
  'slack-messaging': 50, // Conversation batches
  sentry: 30,            // Error batches
  confluence: 50,        // Documentation pages
  github: 50,            // Code/PRs
  lokalise: 50,          // Translations
  trustpilot: 90,        // Review analysis batches (3x)
  outlook: 50,           // Calendar/email
};
const DEFAULT_MCP_LIMIT = 50;

// Core Claude tools - NOT rate limited
const CORE_TOOLS = new Set([
  'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task', 'TaskOutput',
  'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookEdit', 'AskUserQuestion',
  'Skill', 'KillShell', 'EnterPlanMode', 'ExitPlanMode'
]);

// In-memory counters per MCP server (reset on proxy restart)
const counters = new Map();

// Extract MCP server name from tool name (e.g., "mcp__zendesk__search" → "zendesk")
function getMcpServer(toolName) {
  if (!toolName.startsWith('mcp__')) return null;
  const parts = toolName.split('__');
  return parts.length >= 2 ? parts[1] : null;
}

// Record a tool invocation and return current count
// Only counts MCP tools, ignores core Claude tools
export function recordToolUse(toolName) {
  // Skip core Claude tools - they're not rate limited
  if (CORE_TOOLS.has(toolName)) {
    return 0;
  }

  // Extract MCP server name
  const server = getMcpServer(toolName);
  if (!server) {
    // Unknown tool format - skip
    return 0;
  }

  // Count against the MCP server
  const count = (counters.get(server) || 0) + 1;
  counters.set(server, count);
  const limit = MCP_LIMITS[server] || DEFAULT_MCP_LIMIT;

  // Warn when approaching limit
  if (count === Math.floor(limit * 0.8)) {
    console.log(`[RateLimit] ${server}: ${count}/${limit} (80% - approaching limit)`);
  }
  if (count === limit) {
    console.log(`[RateLimit] ${server}: ${count}/${limit} - LIMIT REACHED`);
  }

  return count;
}

// Check if tool is over its limit
// Only checks MCP tools, core tools always return false
export function isOverLimit(toolName) {
  // Core tools are never rate limited
  if (CORE_TOOLS.has(toolName)) {
    return false;
  }

  const server = getMcpServer(toolName);
  if (!server) {
    return false;
  }

  const count = counters.get(server) || 0;
  const limit = MCP_LIMITS[server] || DEFAULT_MCP_LIMIT;
  return count >= limit;
}

// Get limit for a tool
export function getLimit(toolName) {
  const server = getMcpServer(toolName);
  if (!server) return Infinity;
  return MCP_LIMITS[server] || DEFAULT_MCP_LIMIT;
}

// Get all stats (MCP server counts only)
export function getStats() {
  return Object.fromEntries(counters);
}
