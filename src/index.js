// src/index.js - Claude EU Proxy main entry
// Routes Claude Code traffic through Vertex AI (EU) with PII pseudonymization
import 'dotenv/config';
import express from 'express';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import { PIIPseudonymizer } from './pii.js';
import { sendMessage, streamMessage } from './vertex.js';
import { recordToolUse, isOverLimit, getLimit, getStats } from './rate-limiter.js';
import {
  recordUsage, getSessionCosts, getPricingTable,
  estimateCost, isExpensiveAllowed, allowExpensiveRequest, resetExpensiveFlag, COST_THRESHOLD
} from './cost-tracker.js';
import { initBigQuery, logRequest, isInitialized, formatMetadata } from './bigquery-logger.js';

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

// Model name translation: Anthropic API → Vertex AI
// Claude Code sends model names with dashes, Vertex AI uses @ for version
const MODEL_MAP = {
  // Opus 4.5 (enabled in Model Garden)
  'claude-opus-4-5-20251101': 'claude-opus-4-5@20251101',
  'claude-opus-4-5': 'claude-opus-4-5',
  // Sonnet 4
  'claude-sonnet-4-20250514': 'claude-sonnet-4@20250514',
  'claude-sonnet-4': 'claude-sonnet-4',
  // Haiku 3.5
  'claude-3-5-haiku-20241022': 'claude-3-5-haiku@20241022',
  'claude-3-5-haiku': 'claude-3-5-haiku',
};

// Dynamic translation: convert -YYYYMMDD to @YYYYMMDD for any model
function translateModel(model) {
  // First check static map
  if (MODEL_MAP[model]) {
    const translated = MODEL_MAP[model];
    console.log(`[Model] Translated: ${model} → ${translated}`);
    return translated;
  }

  // Dynamic: replace trailing -YYYYMMDD with @YYYYMMDD
  const datePattern = /-(\d{8})$/;
  if (datePattern.test(model)) {
    const translated = model.replace(datePattern, '@$1');
    console.log(`[Model] Translated: ${model} → ${translated}`);
    return translated;
  }

  return model;
}

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

/**
 * Helper: Calculate actual cost from response tokens
 * Reuses logic from cost-tracker.js
 */
function calculateActualCost(response, model) {
  // Get pricing from cost-tracker
  // Default to Opus pricing if model not found
  const VERTEX_EU_PRICING = {
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

    // 2. Translate model name for Vertex AI
    const vertexModel = translateModel(req.body.model);

    // 3. Handle streaming vs non-streaming
    if (req.body.stream) {
      return handleStreaming(req, res, processedMessages, pseudonymizer, vertexModel, startTime, requestId, estimate);
    }

    // 4. Non-streaming: forward to Vertex AI
    const response = await sendMessage({
      ...req.body,
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

// Handle streaming responses
async function handleStreaming(req, res, messages, pseudonymizer, vertexModel, startTime, requestId, estimate) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const stream = streamMessage({ ...req.body, model: vertexModel, messages });
  let textBuffer = '';

  stream.on('text', (text) => {
    // Buffer to handle token boundaries (e.g., EMAIL_1 split as EMA + IL_1)
    textBuffer += text;

    // Check for complete tokens and flush
    const { clean, remainder } = flushBuffer(textBuffer, pseudonymizer);
    textBuffer = remainder;

    if (clean) {
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: clean }
      })}\n\n`);
    }
  });

  stream.on('message', async (message) => {
    // Flush any remaining buffer
    if (textBuffer) {
      const clean = pseudonymizer.depseudonymize(textBuffer);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: clean }
      })}\n\n`);
    }

    // Record tool uses from streamed response
    recordToolUsesFromResponse(message);

    // Record usage and calculate cost for streaming
    recordUsage(message, vertexModel);

    // Log to BigQuery asynchronously (non-blocking)
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

      // Fire-and-forget: don't await, don't block response
      logRequest(metadata).catch(err => {
        console.error('[BigQuery] Async log error (streaming):', err.message);
      });
    }

    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    res.end();
  });

  stream.on('error', (error) => {
    console.error('[Streaming] Error:', error.message);
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
    res.end();
  });
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

// Start server
const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  console.log(`[Proxy] Claude EU Proxy running on http://localhost:${PORT}`);
  console.log(`[Proxy] Region: ${process.env.VERTEX_REGION || 'europe-west1'}`);
  console.log(`[Proxy] Project: ${process.env.GCP_PROJECT_ID || 'woolsocks-marketing-ai'}`);
  console.log(`[Proxy] Set: export ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
  console.log(`[Proxy] Rate limits active:`, getStats() || 'none yet');
});
