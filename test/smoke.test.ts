/**
 * Production Smoke Tests
 *
 * These tests run against the live API to verify deployment.
 * Requires TEST_PROMPT_API_KEY in .env
 *
 * Run with: bun test
 */
import { expect, test } from 'bun:test';

const API_URL = process.env.API_URL || 'https://api.promptlycms.com';
const API_KEY = process.env.TEST_PROMPT_API_KEY;
const TEST_PROMPT_ID = process.env.TEST_PROMPT_ID;

type ErrorResponse = {
  error: string;
  code: string;
};

type PromptResponse = {
  promptId: string;
  promptName: string;
  version: string;
  systemMessage: string | null;
  userMessage: string | null;
  config: Record<string, unknown>;
};

const skipWithoutKey = API_KEY ? test : test.skip;
const skipWithoutPrompt = API_KEY && TEST_PROMPT_ID ? test : test.skip;

// Auth

skipWithoutKey('returns 401 for missing Authorization header', async () => {
  const response = await fetch(`${API_URL}/prompts/any-id`);

  expect(response.status).toBe(401);
  const body = (await response.json()) as ErrorResponse;
  expect(body).toEqual({
    error: 'Missing Authorization header',
    code: 'UNAUTHORIZED',
  });
});

skipWithoutKey('returns 401 for invalid API key', async () => {
  const response = await fetch(`${API_URL}/prompts/any-id`, {
    headers: { Authorization: 'Bearer invalid_key_12345' },
  });

  expect(response.status).toBe(401);
  const body = (await response.json()) as ErrorResponse;
  expect(body).toEqual({
    error: 'Invalid API key',
    code: 'INVALID_KEY',
  });
});

skipWithoutKey('accepts valid API key', async () => {
  const response = await fetch(`${API_URL}/prompts/nonexistent-id`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  // Should get 404 (not found), not 401 (unauthorized)
  expect(response.status).toBe(404);
  const body = (await response.json()) as ErrorResponse;
  expect(body.code).toBe('NOT_FOUND');
});

// CORS

skipWithoutKey('returns CORS headers on preflight', async () => {
  const response = await fetch(`${API_URL}/prompts/any-id`, {
    method: 'OPTIONS',
  });

  expect(response.status).toBe(204);
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(response.headers.get('Access-Control-Allow-Methods')).toBe(
    'GET, OPTIONS',
  );
  expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
    'Authorization, Content-Type',
  );
});

skipWithoutKey('includes CORS headers in responses', async () => {
  const response = await fetch(`${API_URL}/prompts/any-id`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
});

// Routing

skipWithoutKey('returns 404 for unknown routes', async () => {
  const response = await fetch(`${API_URL}/unknown`);

  expect(response.status).toBe(404);
  const body = (await response.json()) as ErrorResponse;
  expect(body).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
});

skipWithoutKey('returns 405 for non-GET methods', async () => {
  const response = await fetch(`${API_URL}/prompts/any-id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  expect(response.status).toBe(405);
  const body = (await response.json()) as ErrorResponse;
  expect(body).toEqual({
    error: 'Method not allowed',
    code: 'METHOD_NOT_ALLOWED',
  });
});

// Prompt fetching

skipWithoutKey('returns 404 for non-existent prompt', async () => {
  const response = await fetch(
    `${API_URL}/prompts/definitely-not-a-real-id-12345`,
    {
      headers: { Authorization: `Bearer ${API_KEY}` },
    },
  );

  expect(response.status).toBe(404);
  const body = (await response.json()) as ErrorResponse;
  expect(body.code).toBe('NOT_FOUND');
});

skipWithoutPrompt('fetches prompt with correct structure', async () => {
  const response = await fetch(`${API_URL}/prompts/${TEST_PROMPT_ID}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  expect(response.status).toBe(200);
  const body = (await response.json()) as PromptResponse;

  expect(body).toHaveProperty('promptId');
  expect(body).toHaveProperty('promptName');
  expect(body).toHaveProperty('version');
  expect(body).toHaveProperty('systemMessage');
  expect(body).toHaveProperty('userMessage');
  expect(body).toHaveProperty('config');

  expect(typeof body.promptId).toBe('string');
  expect(typeof body.promptName).toBe('string');
  expect(typeof body.version).toBe('string');
  expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(typeof body.config).toBe('object');
});

skipWithoutPrompt('fetches specific version when provided', async () => {
  const latestResponse = await fetch(`${API_URL}/prompts/${TEST_PROMPT_ID}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  const latest = (await latestResponse.json()) as PromptResponse;
  const version = latest.version;

  const response = await fetch(
    `${API_URL}/prompts/${TEST_PROMPT_ID}?version=${version}`,
    {
      headers: { Authorization: `Bearer ${API_KEY}` },
    },
  );

  expect(response.status).toBe(200);
  const body = (await response.json()) as PromptResponse;
  expect(body.version).toBe(version);
});

skipWithoutPrompt('returns 404 for non-existent version', async () => {
  const response = await fetch(
    `${API_URL}/prompts/${TEST_PROMPT_ID}?version=999.999.999`,
    {
      headers: { Authorization: `Bearer ${API_KEY}` },
    },
  );

  expect(response.status).toBe(404);
  const body = (await response.json()) as ErrorResponse;
  expect(body.code).toBe('VERSION_NOT_FOUND');
});

skipWithoutPrompt('returns 400 for invalid version format', async () => {
  const response = await fetch(
    `${API_URL}/prompts/${TEST_PROMPT_ID}?version=invalid`,
    {
      headers: { Authorization: `Bearer ${API_KEY}` },
    },
  );

  expect(response.status).toBe(400);
  const body = (await response.json()) as ErrorResponse;
  expect(body.code).toBe('BAD_REQUEST');
});

// Response headers

skipWithoutKey('returns JSON content type', async () => {
  const response = await fetch(`${API_URL}/prompts/any-id`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  expect(response.headers.get('Content-Type')).toBe('application/json');
});

// Rate limit headers

skipWithoutPrompt('includes X-RateLimit headers on success', async () => {
  const response = await fetch(`${API_URL}/prompts/${TEST_PROMPT_ID}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });

  expect(response.status).toBe(200);

  const limit = response.headers.get('X-RateLimit-Limit');
  const remaining = response.headers.get('X-RateLimit-Remaining');
  const reset = response.headers.get('X-RateLimit-Reset');

  expect(limit).not.toBeNull();
  expect(remaining).not.toBeNull();
  expect(reset).not.toBeNull();

  expect(Number(limit)).toBeGreaterThan(0);
  expect(Number(remaining)).toBeGreaterThanOrEqual(0);
  expect(Number(reset)).toBeGreaterThan(0);
  expect(Number(reset)).toBeGreaterThan(Math.floor(Date.now() / 1000));
});
