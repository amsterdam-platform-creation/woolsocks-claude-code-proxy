// src/index.js - Claude EU Proxy main entry
// Routes Claude Code traffic through Vertex AI (EU) with PII pseudonymization
import 'dotenv/config';
import express from 'express';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { PIIPseudonymizer } from './pii.js';
import { sendMessage, streamMessage } from './vertex.js';
import { recordToolUse, isOverLimit, getLimit, getStats } from './rate-limiter.js';
import { translateModel, isModelDisabled, getDisabledModels } from './model-translator.js';
import {
  recordUsage, getSessionCosts, getPricingTable,
  estimateCost, isExpensiveAllowed, allowExpensiveRequest, resetExpensiveFlag, COST_THRESHOLD,
  checkMonthlyCostLimit, getMonthlyCostLimit
} from './cost-tracker.js';
import { initBigQuery, logRequest, isInitialized, formatMetadata } from './bigquery-logger.js';
import {
  initValidator, estimateQueryScan, isValidatorReady, getScanLimit,
  formatValidationResponse, getDailyBytesStatus, recordBytesScanned, getClient, getDailyLimitGB,
  getMonthlyBytesStatus, getMonthlyLimitEUR
} from './bigquery-validator.js';
import {
  initTableChecker, checkTableSizes, getMaxTableSizeGB, isTableCheckerReady,
  getAllowedRegions, isBlockingNonEuTables
} from './bigquery-table-checker.js';

/**
 * Show macOS dialog for expensive request approval
 * Returns true if user clicks "Continue", false if "Block"
 */
async function promptExpensiveRequest(estimate) {
  const message = [
    `Estimated cost: $${estimate.totalEstimate.toFixed(2)}`,
    `Threshold: $${estimate.threshold.toFixed(2)}`,
    ``,
    `Input: ~${estimate.estimatedInputTokens.toLocaleString()} tokens ($${estimate.inputCost.toFixed(3)})`,
    `Output: ~${estimate.estimatedOutputTokens.toLocaleString()} tokens ($${estimate.outputCost.toFixed(3)})`,
    `Model: ${estimate.model}`,
  ].join('\\n');

  const script = `
    display dialog "${message}" ` +
    `with title "⚠️ Expensive Request" ` +
    `buttons {"Block", "Continue"} ` +
    `default button "Continue" ` +
    `with icon caution`;

  try {
    const result = execSync(`osascript -e '${script}'`, { encoding: 'utf-8', timeout: 60000 });
    return result.includes('Continue');
  } catch (err) {
    // User clicked "Block" or closed dialog
    return false;
  }
}

const app = express();
app.use(express.json({ limit: '50mb' }));

// Initialize BigQuery logging on startup (non-blocking)
// If init fails, continue running but logs won't be sent
initBigQuery().catch(err => {
  console.error('[BigQuery] Initialization failed - logging disabled:', err.message);
});

// Initialize BigQuery query validator on startup (non-blocking)
// If init fails, continue running but query validation disabled
initValidator().then(() => {
  // Initialize table checker using validator's BigQuery client
  const client = getClient();
  if (client) {
    initTableChecker(client);
  }
}).catch(err => {
  console.error('[BigQueryValidator] Initialization failed - validation disabled:', err.message);
});

// translateModel imported from ./model-translator.js

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', region: process.env.VERTEX_REGION }));

// Rate limit stats
app.get('/stats', (req, res) => res.json({ toolUsage: getStats() }));

// Cost tracking endpoint - Vertex AI europe-west1 pricing
app.get('/costs', (req, res) => res.json(getSessionCosts()));

// Pricing table
app.get('/pricing', (req, res) => res.json(getPricingTable()));

// Allow next expensive request (one-time approval)
app.post('/allow-expensive', (req, res) => {
  allowExpensiveRequest();
  res.json({
    status: 'approved',
    message: `Next request exceeding $${COST_THRESHOLD.toFixed(2)} will be allowed (one-time).`,
    threshold: COST_THRESHOLD,
  });
});

// BigQuery query validator status
app.get('/v1/bigquery/status', (req, res) => res.json({
  validator_ready: isValidatorReady(),
  scan_limit_gb: getScanLimit(),
  message: isValidatorReady()
    ? `Query validator active - blocks queries scanning >${getScanLimit()}GB`
    : 'Query validator not initialized - unable to check query costs'
}));

// Budget status endpoint - comprehensive view of all cost controls
app.get('/budget', (req, res) => {
  const monthly = checkMonthlyCostLimit();
  const daily = getDailyBytesStatus();
  const monthlyBQ = getMonthlyBytesStatus();
  const session = getSessionCosts();

  res.json({
    status: monthly.exceeded ? 'BLOCKED' : 'OK',
    monthly: {
      claude: {
        currentCostUSD: monthly.currentCost,
        limitUSD: monthly.limit,
        percentUsed: monthly.percentUsed,
        exceeded: monthly.exceeded,
        message: monthly.message,
      },
      bigquery: {
        spentEUR: monthlyBQ.spentEUR,
        limitEUR: monthlyBQ.limitEUR,
        remainingEUR: monthlyBQ.remainingEUR,
        percentUsed: monthlyBQ.percentUsed,
        scannedGB: monthlyBQ.scannedGB,
        scannedTB: monthlyBQ.scannedTB,
        month: monthlyBQ.month,
      },
    },
    bigquery: {
      dailyScannedGB: daily.scannedGB,
      dailyLimitGB: daily.limitGB,
      dailyRemainingGB: daily.remainingGB,
      dailyPercentUsed: daily.percentUsed,
      perQueryLimitGB: getScanLimit(),
      maxTableSizeGB: getMaxTableSizeGB(),
      tableCheckerReady: isTableCheckerReady(),
    },
    session: {
      costUSD: session.totalCostUSD,
      requests: session.requests,
      durationMinutes: session.session.durationMinutes,
    },
    limits: {
      claude: {
        monthlyCostLimitUSD: getMonthlyCostLimit(),
        perRequestThresholdUSD: COST_THRESHOLD,
      },
      bigquery: {
        monthlyLimitEUR: getMonthlyLimitEUR(),
        dailyLimitGB: getDailyLimitGB(),
        perQueryLimitGB: getScanLimit(),
        maxTableSizeGB: getMaxTableSizeGB(),
        allowedRegions: getAllowedRegions(),
        blockNonEuTables: isBlockingNonEuTables(),
      },
    },
  });
});

// BigQuery query validation endpoint
// POST /v1/bigquery/validate with body: { sql: "SELECT ..." }
app.post('/v1/bigquery/validate', async (req, res) => {
  const requestId = randomUUID();
  const { sql } = req.body;

  if (!sql || typeof sql !== 'string') {
    return res.status(400).json({
      type: 'error',
      error: {
        type: 'invalid_request',
        message: 'Missing or invalid "sql" field in request body'
      }
    });
  }

  try {
    // 1. TABLE SIZE & REGION PRE-CHECK - Block before dry-run
    const tableCheck = await checkTableSizes(sql);
    if (!tableCheck.approved) {
      console.log(`[TableChecker] Query blocked - ${tableCheck.message}`);

      // Different error types for size vs region issues
      const errorType = tableCheck.reason === 'non_eu_region' ? 'non_eu_region' : 'table_too_large';

      return res.status(402).json({
        type: 'error',
        error: {
          type: errorType,
          message: tableCheck.message,
          request_id: requestId,
          blocked_tables: tableCheck.blockedTables,
          non_eu_tables: tableCheck.nonEuTables,
          tables_checked: tableCheck.tablesChecked,
          max_table_size_gb: getMaxTableSizeGB(),
          allowed_regions: getAllowedRegions(),
        }
      });
    }

    // 2. Estimate query scan size (includes daily limit check)
    const validation = await estimateQueryScan(sql);

    // Log validation attempt to console
    // (BigQuery logging requires separate schema - can be added in Phase 3)
    console.log(`[BigQueryValidator] Validation - ${validation.approved ? 'APPROVED' : 'BLOCKED'}: ${validation.estimatedGB}GB/${validation.scanLimitGB}GB`);

    // If query would exceed limit, return 402 (Payment Required)
    if (!validation.approved) {
      console.log(`[BigQueryValidator] Query blocked: ${validation.estimatedGB}GB > ${validation.scanLimitGB}GB`);
      return res.status(402).json({
        type: 'error',
        error: {
          type: 'query_too_expensive',
          message: validation.message,
          request_id: requestId,
          ...formatValidationResponse(validation)
        }
      });
    }

    // Query approved - return estimation details
    console.log(`[BigQueryValidator] Query approved: ${validation.estimatedGB}GB`);
    return res.json({
      type: 'success',
      request_id: requestId,
      ...formatValidationResponse(validation)
    });
  } catch (err) {
    console.error('[BigQueryValidator] Validation error:', err);
    return res.status(500).json({
      type: 'error',
      error: {
        type: 'validation_failed',
        message: err.message,
        request_id: requestId
      }
    });
  }
});

/**
 * Helper: Calculate actual cost from response tokens
 * Reuses logic from cost-tracker.js
 */
function calculateActualCost(response, model) {
  // Get pricing from cost-tracker
  // Default to Opus pricing if model not found
  const VERTEX_EU_PRICING = {
    'claude-opus-4-7': { input: 5.50, output: 27.50 },
    'claude-opus-4-6': { input: 5.50, output: 27.50 },
    'claude-sonnet-4-6': { input: 3.30, output: 16.50 },
    'claude-opus-4-5': { input: 5.50, output: 27.50 },
    'claude-opus-4-5@20251101': { input: 5.50, output: 27.50 },
    'claude-sonnet-4': { input: 3.30, output: 16.50 },
    'claude-sonnet-4@20250514': { input: 3.30, output: 16.50 },
    'claude-haiku-4-5': { input: 1.10, output: 5.50 },
    'claude-haiku-4-5@20251001': { input: 1.10, output: 5.50 },
    'claude-3-5-haiku': { input: 1.10, output: 5.50 },
    'claude-3-5-haiku@20241022': { input: 1.10, output: 5.50 },
  };

  const pricing = VERTEX_EU_PRICING[model] || { input: 5.50, output: 27.50 };
  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;

  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;

  return parseFloat((inputCost + outputCost).toFixed(4));
}

/**
 * Helper: Hash user ID for privacy
 * Returns pseudonymized user identifier safe for analytics
 */
function hashUserId(userId) {
  if (!userId || userId === 'unknown') {
    return 'unknown';
  }
  // Base64 encode first 16 chars for simple pseudonymization
  // For stronger privacy, could use crypto.createHash('sha256')
  return `user_${Buffer.from(userId).toString('base64').substring(0, 16)}`;
}

// Check current threshold setting
app.get('/threshold', (req, res) => res.json({
  threshold: COST_THRESHOLD,
  expensiveAllowed: isExpensiveAllowed(),
}));

// Main proxy endpoint - matches Anthropic API
app.post('/v1/messages', async (req, res) => {
  const startTime = Date.now();
  const requestId = randomUUID();  // Generate unique request ID for tracing
  const pseudonymizer = new PIIPseudonymizer();

  // Set request ID in response headers
  res.set('X-Request-ID', requestId);

  try {
    // 0. MONTHLY COST HARD CAP - Emergency brake when budget exhausted
    // This check runs FIRST, before any other processing
    const monthlyCost = checkMonthlyCostLimit();
    if (monthlyCost.exceeded) {
      console.log(`[Cost] MONTHLY LIMIT EXCEEDED: $${monthlyCost.currentCost.toFixed(2)} / $${monthlyCost.limit}`);
      return res.status(402).json({
        type: 'error',
        error: {
          type: 'monthly_limit_exceeded',
          message: monthlyCost.message,
          current_cost_usd: monthlyCost.currentCost,
          limit_usd: monthlyCost.limit,
          percent_used: monthlyCost.percentUsed,
        }
      });
    }

    // 0a. Check rate limits for tools used in conversation
    const toolsOverLimit = findToolsOverLimit(req.body.messages);
    if (toolsOverLimit.length > 0) {
      const tool = toolsOverLimit[0];
      const limit = getLimit(tool);
      console.log(`[RateLimit] Blocking request - ${tool} over limit (${limit} calls)`);
      return res.status(429).json({
        type: 'error',
        error: {
          type: 'rate_limit_exceeded',
          message: `Tool "${tool}" has reached its session limit of ${limit} calls. ` +
                   `This limit exists for cost control. Restart the proxy to reset limits.`
        }
      });
    }

    // 0b. Check estimated cost - prompt user for expensive requests
    const estimate = estimateCost(req.body);
    if (estimate.exceedsThreshold && !isExpensiveAllowed()) {
      console.log(`[Cost] Expensive request detected - estimated $${estimate.totalEstimate.toFixed(2)} > $${COST_THRESHOLD.toFixed(2)}`);

      // Show interactive dialog and wait for user response
      const approved = await promptExpensiveRequest(estimate);

      if (!approved) {
        console.log(`[Cost] User rejected expensive request`);
        return res.status(402).json({
          type: 'error',
          error: {
            type: 'cost_threshold_exceeded',
            message: `Request blocked by user (estimated cost: $${estimate.totalEstimate.toFixed(2)})`
          }
        });
      }
      console.log(`[Cost] User approved expensive request`);
    }

    // Reset expensive flag if it was used
    resetExpensiveFlag();

    // 1. Process messages (pseudonymize text)
    const processedMessages = req.body.messages.map((msg) => ({
      ...msg,
      content: processMessageContent(msg.content, pseudonymizer)
    }));

    // Log what was redacted
    const stats = pseudonymizer.getStats();
    if (stats.totalRedacted > 0) {
      console.log(`[PII] Redacted ${stats.totalRedacted} items:`, stats.byType);
    }

    // 1b. Reject models not yet available on Vertex AI europe-west1
    if (isModelDisabled(req.body.model)) {
      console.log(`[Model] Rejected disabled model: ${req.body.model}`);
      return res.status(503).json({
        type: 'error',
        error: {
          type: 'model_not_available',
          message: `Model "${req.body.model}" is not yet available on Vertex AI europe-west1. ` +
                   `To enable once it lands on Vertex EU, remove it from DISABLED_MODELS in src/model-translator.js.`,
          disabled_models: getDisabledModels(),
        },
      });
    }

    // 2. Translate model name for Vertex AI
    const vertexModel = translateModel(req.body.model);

    // 2b. Strip fields not supported by Vertex AI
    const { context_management, ...sanitizedBody } = req.body;

    // 3. Handle streaming vs non-streaming
    if (sanitizedBody.stream) {
      req.sanitizedBody = sanitizedBody;
      return handleStreaming(req, res, processedMessages, pseudonymizer, vertexModel, startTime, requestId, estimate);
    }

    // 4. Non-streaming: forward to Vertex AI
    const response = await sendMessage({
      ...sanitizedBody,
      model: vertexModel,
      messages: processedMessages,
    });

    // 5. Record any tool uses in response (for rate limiting)
    recordToolUsesFromResponse(response);

    // 6. Record usage and calculate cost
    recordUsage(response, vertexModel);

    // 7. Log to BigQuery asynchronously (non-blocking)
    if (await isInitialized()) {
      const actualCost = calculateActualCost(response, vertexModel);
      const metadata = formatMetadata({
        timestamp: new Date(),
        request_id: requestId,
        model: vertexModel,
        region: 'eu',
        messages_count: req.body.messages.length,
        system_prompt_length: req.body.system ? JSON.stringify(req.body.system).length : 0,
        stream: false,
        max_tokens: req.body.max_tokens || 8192,
        estimated_input_tokens: estimate.estimatedInputTokens,
        estimated_output_tokens: estimate.estimatedOutputTokens,
        estimated_cost_usd: estimate.totalEstimate,
        actual_input_tokens: response.usage?.input_tokens || 0,
        actual_output_tokens: response.usage?.output_tokens || 0,
        actual_cost_usd: actualCost,
        cost_difference: actualCost - estimate.totalEstimate,
        response_time_ms: Date.now() - startTime,
        user_context: hashUserId(req.get('x-user-id') || 'unknown')
      });

      // Fire-and-forget: don't await, don't block response
      logRequest(metadata).catch(err => {
        console.error('[BigQuery] Async log error:', err.message);
      });
    }

    // 8. De-pseudonymize response
    const cleanResponse = depseudonymizeResponse(response, pseudonymizer);

    console.log(`[Proxy] ${requestId} completed in ${Date.now() - startTime}ms`);
    res.json(cleanResponse);

  } catch (error) {
    console.error('[Proxy] Error:', error.message);
    res.status(error.status || 500).json({
      type: 'error',
      error: { type: 'proxy_error', message: error.message }
    });
  }
});

// Process message content (pseudonymize text)
function processMessageContent(content, pseudonymizer) {
  if (typeof content === 'string') {
    const result = pseudonymizer.pseudonymize(content);
    if (result !== content) {
      console.log(`[PII] Text redacted: "${content.substring(0, 80)}..." → "${result.substring(0, 80)}..."`);
    }
    return result;
  }

  if (Array.isArray(content)) {
    return content.map((block) => {
      if (block.type === 'text') {
        const original = block.text;
        const redacted = pseudonymizer.pseudonymize(block.text);
        if (original !== redacted) {
          console.log(`[PII] Block text redacted: "${original.substring(0, 80)}..." → "${redacted.substring(0, 80)}..."`);
        }
        return { ...block, text: redacted };
      }
      // Handle tool_result blocks (may contain text)
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string') {
          const original = block.content;
          const redacted = pseudonymizer.pseudonymize(block.content);
          if (original !== redacted) {
            console.log(`[PII] Tool result redacted: "${original.substring(0, 80)}..." → "${redacted.substring(0, 80)}..."`);
          }
          return { ...block, content: redacted };
        }
        // Handle array content in tool_result
        if (Array.isArray(block.content)) {
          const redactedContent = block.content.map(item => {
            if (item.type === 'text' && item.text) {
              const original = item.text;
              const redacted = pseudonymizer.pseudonymize(item.text);
              if (original !== redacted) {
                console.log(`[PII] Tool result array redacted: "${original.substring(0, 80)}..." → "${redacted.substring(0, 80)}..."`);
              }
              return { ...item, text: redacted };
            }
            return item;
          });
          return { ...block, content: redactedContent };
        }
      }
      return block;
    });
  }

  return content;
}

// De-pseudonymize Claude's response
function depseudonymizeResponse(response, pseudonymizer) {
  if (!response.content) return response;

  const cleanContent = response.content.map(block => {
    if (block.type === 'text') {
      return { ...block, text: pseudonymizer.depseudonymize(block.text) };
    }
    return block;
  });

  return { ...response, content: cleanContent };
}

// Handle streaming responses — full SSE passthrough with PII redaction on text_delta only.
// Forwards all event types (thinking_delta, content_block_start, etc.) so extended
// thinking (effortLevel: "high") works correctly through the proxy.
async function handleStreaming(req, res, messages, pseudonymizer, vertexModel, startTime, requestId, estimate) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const stream = streamMessage({ ...(req.sanitizedBody || req.body), model: vertexModel, messages });

  // Per-block PII buffers keyed by block index (handles interleaved thinking+text blocks)
  const textBuffers = {};

  function writeEvent(type, data) {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'message_start':
          writeEvent('message_start', event);
          break;

        case 'content_block_start':
          if (event.content_block?.type === 'text') {
            textBuffers[event.index] = '';
          }
          writeEvent('content_block_start', event);
          break;

        case 'content_block_delta':
          if (event.delta?.type === 'text_delta' && event.index in textBuffers) {
            // Buffer text for PII token boundary handling
            textBuffers[event.index] += event.delta.text;
            const { clean, remainder } = flushBuffer(textBuffers[event.index], pseudonymizer);
            textBuffers[event.index] = remainder;
            if (clean) {
              writeEvent('content_block_delta', { ...event, delta: { ...event.delta, text: clean } });
            }
          } else {
            // thinking_delta, input_json_delta — pass through unchanged
            writeEvent('content_block_delta', event);
          }
          break;

        case 'content_block_stop':
          // Flush any remaining PII buffer for this text block before closing it
          if (event.index in textBuffers && textBuffers[event.index]) {
            const clean = pseudonymizer.depseudonymize(textBuffers[event.index]);
            delete textBuffers[event.index];
            if (clean) {
              writeEvent('content_block_delta', {
                type: 'content_block_delta',
                index: event.index,
                delta: { type: 'text_delta', text: clean },
              });
            }
          }
          writeEvent('content_block_stop', event);
          break;

        case 'message_delta':
          writeEvent('message_delta', event);
          break;

        case 'message_stop':
          writeEvent('message_stop', event);
          res.end();
          break;

        default:
          writeEvent(event.type, event);
      }
    }
  } catch (error) {
    console.error('[Streaming] Error:', error.message);
    if (!res.writableEnded) {
      writeEvent('error', { type: 'error', message: error.message });
      res.end();
    }
    return;
  }

  // Post-stream: record usage + log to BigQuery (fire-and-forget, res already ended)
  try {
    const message = await stream.finalMessage();
    recordToolUsesFromResponse(message);
    recordUsage(message, vertexModel);

    if (await isInitialized()) {
      const actualCost = calculateActualCost(message, vertexModel);
      const metadata = formatMetadata({
        timestamp: new Date(),
        request_id: requestId,
        model: vertexModel,
        region: 'eu',
        messages_count: req.body.messages.length,
        system_prompt_length: req.body.system ? JSON.stringify(req.body.system).length : 0,
        stream: true,
        max_tokens: req.body.max_tokens || 8192,
        estimated_input_tokens: estimate.estimatedInputTokens,
        estimated_output_tokens: estimate.estimatedOutputTokens,
        estimated_cost_usd: estimate.totalEstimate,
        actual_input_tokens: message.usage?.input_tokens || 0,
        actual_output_tokens: message.usage?.output_tokens || 0,
        actual_cost_usd: actualCost,
        cost_difference: actualCost - estimate.totalEstimate,
        response_time_ms: Date.now() - startTime,
        user_context: hashUserId(req.get('x-user-id') || 'unknown')
      });
      logRequest(metadata).catch(err => {
        console.error('[BigQuery] Async log error (streaming):', err.message);
      });
    }
  } catch (e) {
    console.error('[Streaming] Post-stream tracking error:', e.message);
  }
}

// Flush buffer while keeping potential partial tokens
function flushBuffer(buffer, pseudonymizer) {
  // Look for potential token start (e.g., "EMAIL", "PHONE", "BSN", etc.)
  const tokenPrefixes = ['EMAIL', 'PHONE', 'BSN', 'IBAN', 'POSTCODE', 'UUID'];

  // Find last potential token boundary
  let cutoff = buffer.length;
  for (const prefix of tokenPrefixes) {
    const lastIndex = buffer.lastIndexOf(prefix);
    if (lastIndex !== -1 && lastIndex > buffer.length - 20) {
      // Potential partial token - keep it in buffer
      cutoff = Math.min(cutoff, lastIndex);
    }
  }

  const toFlush = buffer.substring(0, cutoff);
  const remainder = buffer.substring(cutoff);

  return {
    clean: pseudonymizer.depseudonymize(toFlush),
    remainder
  };
}

// Find tools in conversation that are over their rate limit
function findToolsOverLimit(messages) {
  const toolsSeen = new Set();

  for (const msg of messages || []) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.name) {
          toolsSeen.add(block.name);
        }
      }
    }
  }

  return Array.from(toolsSeen).filter(tool => isOverLimit(tool));
}

// Record tool uses from Claude's response
function recordToolUsesFromResponse(response) {
  if (!response?.content) return;

  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name) {
      recordToolUse(block.name);
    }
  }
}

// Start server — only when this file is executed directly (not when imported by tests)
import { pathToFileURL } from 'url';
const isMainModule = import.meta.url === pathToFileURL(process.argv[1] || '').href;
const PORT = process.env.PORT || 3030;
if (isMainModule) {
  app.listen(PORT, () => {
    console.log(`[Proxy] Claude EU Proxy running on http://localhost:${PORT}`);
    console.log(`[Proxy] Region: ${process.env.VERTEX_REGION || 'europe-west1'}`);
    console.log(`[Proxy] Project: ${process.env.GCP_PROJECT_ID || 'woolsocks-marketing-ai'}`);
    console.log(`[Proxy] Set: export ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
    console.log(`[Proxy] Rate limits active:`, getStats() || 'none yet');
  });
}

export { app };
