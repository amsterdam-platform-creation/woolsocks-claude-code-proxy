// src/index.js - Claude EU Proxy main entry
import 'dotenv/config';
import express from 'express';
import { PIIPseudonymizer } from './pii.js';
import { sendMessage, streamMessage } from './vertex.js';
import { redactImagePII } from './images.js';

const app = express();
app.use(express.json({ limit: '50mb' }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', region: process.env.VERTEX_REGION }));

// Main proxy endpoint - matches Anthropic API
app.post('/v1/messages', async (req, res) => {
  const startTime = Date.now();
  const pseudonymizer = new PIIPseudonymizer();

  try {
    // 1. Process messages (pseudonymize text, redact images)
    const processedMessages = await Promise.all(
      req.body.messages.map(async (msg) => ({
        ...msg,
        content: await processMessageContent(msg.content, pseudonymizer)
      }))
    );

    // Log what was redacted
    const stats = pseudonymizer.getStats();
    if (stats.totalRedacted > 0) {
      console.log(`[PII] Redacted ${stats.totalRedacted} items:`, stats.byType);
    }

    // 2. Handle streaming vs non-streaming
    if (req.body.stream) {
      return handleStreaming(req, res, processedMessages, pseudonymizer);
    }

    // 3. Non-streaming: forward to Vertex AI
    const response = await sendMessage({
      ...req.body,
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

// Process message content (text and images)
async function processMessageContent(content, pseudonymizer) {
  if (typeof content === 'string') {
    return pseudonymizer.pseudonymize(content);
  }

  if (Array.isArray(content)) {
    return Promise.all(content.map(async (block) => {
      if (block.type === 'text') {
        return { ...block, text: pseudonymizer.pseudonymize(block.text) };
      }
      if (block.type === 'image' && block.source?.type === 'base64') {
        try {
          const redactedData = await redactImagePII(block.source.data, block.source.media_type);
          return { ...block, source: { ...block.source, data: redactedData } };
        } catch (err) {
          console.warn('[Images] OCR failed, passing through:', err.message);
          return block; // Graceful degradation - pass through if OCR fails
        }
      }
      return block;
    }));
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
async function handleStreaming(req, res, messages, pseudonymizer) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const stream = streamMessage({ ...req.body, messages });
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
