// src/index.js - Claude EU Proxy main entry
// Routes Claude Code traffic through Vertex AI (EU) with PII pseudonymization
import 'dotenv/config';
import express from 'express';
import { PIIPseudonymizer } from './pii.js';
import { sendMessage, streamMessage } from './vertex.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

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

// Main proxy endpoint - matches Anthropic API
app.post('/v1/messages', async (req, res) => {
  const startTime = Date.now();
  const pseudonymizer = new PIIPseudonymizer();

  try {
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
      return handleStreaming(req, res, processedMessages, pseudonymizer, vertexModel);
    }

    // 4. Non-streaming: forward to Vertex AI
    const response = await sendMessage({
      ...req.body,
      model: vertexModel,
      messages: processedMessages,
    });

    // 4. De-pseudonymize response
    const cleanResponse = depseudonymizeResponse(response, pseudonymizer);

    console.log(`[Proxy] Request completed in ${Date.now() - startTime}ms`);
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
async function handleStreaming(req, res, messages, pseudonymizer, vertexModel) {
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

  stream.on('message', (message) => {
    // Flush any remaining buffer
    if (textBuffer) {
      const clean = pseudonymizer.depseudonymize(textBuffer);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: clean }
      })}\n\n`);
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

// Start server
const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  console.log(`[Proxy] Claude EU Proxy running on http://localhost:${PORT}`);
  console.log(`[Proxy] Region: ${process.env.VERTEX_REGION || 'europe-west1'}`);
  console.log(`[Proxy] Project: ${process.env.GCP_PROJECT_ID || 'woolsocks-marketing-ai'}`);
  console.log(`[Proxy] Set: export ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
});
