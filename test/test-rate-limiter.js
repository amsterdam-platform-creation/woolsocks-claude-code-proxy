// test/test-rate-limiter.js — Unit tests for MCP rate limiting logic
import { recordToolUse, isOverLimit, getLimit, getStats, resetCounters } from '../src/rate-limiter.js';

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function reset() {
  resetCounters();
}

console.log('🧪 Rate limiter tests\n');

// ─── Core tools are never rate-limited ───────────────────────────────────────
console.log('Core tools (never rate-limited):');
reset();
for (const tool of ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep']) {
  recordToolUse(tool);
  recordToolUse(tool);
  assert(!isOverLimit(tool), `${tool} never over limit after 2 calls`);
}

// ─── MCP tool counting ────────────────────────────────────────────────────────
console.log('\nMCP tool counting:');
reset();
assert(recordToolUse('mcp__zendesk__search') === 1, 'first call returns count 1');
assert(recordToolUse('mcp__zendesk__search') === 2, 'second call returns count 2');
assert(recordToolUse('mcp__zendesk__tickets') === 3, 'same server, different tool = count 3');
assert(recordToolUse('mcp__jira__search') === 1,     'different server starts at 1');

const stats = getStats();
assert(stats.zendesk === 3, `zendesk counter = 3 (got ${stats.zendesk})`);
assert(stats.jira === 1,    `jira counter = 1 (got ${stats.jira})`);

// ─── Over-limit detection ─────────────────────────────────────────────────────
console.log('\nOver-limit detection:');
reset();

const jiraLimit = getLimit('mcp__jira__search');
assert(jiraLimit === 100, `jira limit is 100 (got ${jiraLimit})`);
assert(!isOverLimit('mcp__jira__search'), 'not over limit before any calls');

// Record up to the limit
for (let i = 0; i < jiraLimit; i++) recordToolUse('mcp__jira__search');
assert(isOverLimit('mcp__jira__search'), `over limit after ${jiraLimit} calls`);

// ─── Default limit for unknown MCP server ────────────────────────────────────
console.log('\nDefault limit:');
reset();
const unknownLimit = getLimit('mcp__unknown_server__some_tool');
assert(unknownLimit === 50, `default limit is 50 (got ${unknownLimit})`);
for (let i = 0; i < 50; i++) recordToolUse('mcp__unknown_server__some_tool');
assert(isOverLimit('mcp__unknown_server__some_tool'), 'over limit at default threshold');

// ─── Non-MCP tools return safe defaults ──────────────────────────────────────
console.log('\nNon-MCP tool names:');
reset();
assert(recordToolUse('SomeRandomTool') === 0, 'non-mcp tool returns 0');
assert(!isOverLimit('SomeRandomTool'),         'non-mcp tool never over limit');
assert(getLimit('SomeRandomTool') === Infinity, 'non-mcp tool has Infinity limit');

// ─── getStats reflects only MCP counters ─────────────────────────────────────
console.log('\ngetStats:');
reset();
recordToolUse('Bash');
recordToolUse('mcp__trustpilot__reviews');
const s = getStats();
assert(!('Bash' in s),         'core tools not in stats');
assert(s.trustpilot === 1,     'MCP server counter in stats');

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
