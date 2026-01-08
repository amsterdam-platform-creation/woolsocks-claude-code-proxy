// src/vertex.js - Vertex AI client wrapper
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

let client = null;

export function getClient() {
  if (!client) {
    client = new AnthropicVertex({
      region: process.env.VERTEX_REGION || 'europe-west1',
      projectId: process.env.GCP_PROJECT_ID || 'woolsocks-marketing-ai',
    });
  }
  return client;
}

export async function sendMessage(params) {
  return getClient().messages.create(params);
}

export function streamMessage(params) {
  return getClient().messages.stream(params);
}
