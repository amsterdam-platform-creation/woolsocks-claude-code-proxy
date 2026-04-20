// src/model-translator.js — Anthropic API model name → Vertex AI model name
// Claude Code sends names like "claude-sonnet-4-6"; Vertex uses "@" for dated versions.

// Models not yet available on Vertex AI europe-west1.
// To enable a model once it lands on Vertex EU, remove it from this set.
const DISABLED_MODELS = new Set([
  'claude-opus-4-7', // Not yet on Vertex europe-west1 (as of 2026-04-20)
]);

export function isModelDisabled(model) {
  return DISABLED_MODELS.has(model);
}

export function getDisabledModels() {
  return [...DISABLED_MODELS];
}

const MODEL_MAP = {
  // Opus 4.7 (disabled — see DISABLED_MODELS above)
  'claude-opus-4-7': 'claude-opus-4-7',
  // Opus 4.6
  'claude-opus-4-6': 'claude-opus-4-6',
  // Sonnet 4.6
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  // Opus 4.5
  'claude-opus-4-5-20251101': 'claude-opus-4-5@20251101',
  'claude-opus-4-5': 'claude-opus-4-5',
  // Sonnet 4
  'claude-sonnet-4-20250514': 'claude-sonnet-4@20250514',
  'claude-sonnet-4': 'claude-sonnet-4',
  // Haiku 4.5
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5@20251001',
  'claude-haiku-4-5': 'claude-haiku-4-5',
  // Haiku 3.5 (legacy)
  'claude-3-5-haiku-20241022': 'claude-3-5-haiku@20241022',
  'claude-3-5-haiku': 'claude-3-5-haiku',
};

export function translateModel(model) {
  if (MODEL_MAP[model]) return MODEL_MAP[model];
  // Dynamic: replace trailing -YYYYMMDD with @YYYYMMDD for any model
  const datePattern = /-(\d{8})$/;
  if (datePattern.test(model)) return model.replace(datePattern, '@$1');
  return model;
}
