/**
 * Production Smoke Tests
 *
 * These tests run against the live API to verify deployment.
 * Requires TEST_PROMPT_API_KEY in .env
 *
 * Run with: bun test
 */
import { describe, expect, it } from 'bun:test';

const API_URL = process.env.API_URL || 'https://api.promptlycms.com';
const API_KEY = process.env.TEST_PROMPT_API_KEY;

type ErrorResponse = {
  error: string;
  code: string;
};

type PromptResponse = {
  id: string;
  name: string;
  description: string;
  version: string;
  systemMessage: string | null;
  userMessage: string | null;
  config: Record<string, unknown>;
};

// Skip all tests if no API key is configured
const describeSmoke = API_KEY ? describe : describe.skip;

describeSmoke('Production Smoke Tests', () => {
  describe('Authentication', () => {
    it('returns 401 for missing Authorization header', async () => {
      const response = await fetch(`${API_URL}/prompts/any-id`);

      expect(response.status).toBe(401);
      const body = (await response.json()) as ErrorResponse;
      expect(body).toEqual({
        error: 'Missing Authorization header',
        code: 'UNAUTHORIZED',
      });
    });

    it('returns 401 for invalid API key', async () => {
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

    it('accepts valid API key', async () => {
      const response = await fetch(`${API_URL}/prompts/nonexistent-id`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });

      // Should get 404 (not found), not 401 (unauthorized)
      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body.code).toBe('NOT_FOUND');
    });
  });

  describe('CORS', () => {
    it('returns CORS headers on preflight', async () => {
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

    it('includes CORS headers in responses', async () => {
      const response = await fetch(`${API_URL}/prompts/any-id`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });

      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('Routing', () => {
    it('returns 404 for unknown routes', async () => {
      const response = await fetch(`${API_URL}/unknown`);

      expect(response.status).toBe(404);
      const body = (await response.json()) as ErrorResponse;
      expect(body).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
    });

    it('returns 405 for non-GET methods', async () => {
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
  });

  describe('Prompt Fetching', () => {
    // You can set TEST_PROMPT_ID in .env for a known prompt
    const TEST_PROMPT_ID = process.env.TEST_PROMPT_ID;

    it('returns 404 for non-existent prompt', async () => {
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

    const describeWithPrompt = TEST_PROMPT_ID ? describe : describe.skip;

    describeWithPrompt('with TEST_PROMPT_ID configured', () => {
      it('fetches prompt with correct structure', async () => {
        const response = await fetch(`${API_URL}/prompts/${TEST_PROMPT_ID}`, {
          headers: { Authorization: `Bearer ${API_KEY}` },
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as PromptResponse;

        // Verify response structure
        expect(body).toHaveProperty('id');
        expect(body).toHaveProperty('name');
        expect(body).toHaveProperty('description');
        expect(body).toHaveProperty('version');
        expect(body).toHaveProperty('systemMessage');
        expect(body).toHaveProperty('userMessage');
        expect(body).toHaveProperty('config');

        // Verify types
        expect(typeof body.id).toBe('string');
        expect(typeof body.name).toBe('string');
        expect(typeof body.version).toBe('string');
        expect(body.version).toMatch(/^\d+\.\d+\.\d+$/); // semver format

        // Config should be an object
        expect(typeof body.config).toBe('object');
      });

      it('fetches specific version when provided', async () => {
        // First get the latest version
        const latestResponse = await fetch(
          `${API_URL}/prompts/${TEST_PROMPT_ID}`,
          {
            headers: { Authorization: `Bearer ${API_KEY}` },
          },
        );
        const latest = (await latestResponse.json()) as PromptResponse;
        const version = latest.version;

        // Now fetch that specific version
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

      it('returns 404 for non-existent version', async () => {
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

      it('returns 400 for invalid version format', async () => {
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
    });
  });

  describe('Response Headers', () => {
    it('returns JSON content type', async () => {
      const response = await fetch(`${API_URL}/prompts/any-id`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });

      expect(response.headers.get('Content-Type')).toBe('application/json');
    });
  });
});
