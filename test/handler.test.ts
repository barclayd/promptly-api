import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handleRequest } from '../src/handler.ts';
import type { Env } from '../src/types.ts';

describe('handleRequest', () => {
	it('returns 404 for unknown routes', async () => {
		const request = new Request('http://localhost/unknown');
		const response = await handleRequest(request, env as unknown as Env);

		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
	});

	it('returns 401 for missing Authorization header', async () => {
		const request = new Request('http://localhost/prompts/test-id');
		const response = await handleRequest(request, env as unknown as Env);

		expect(response.status).toBe(401);
		const body = await response.json();
		expect(body).toEqual({ error: 'Missing Authorization header', code: 'UNAUTHORIZED' });
	});

	it('returns 404 for root path', async () => {
		const request = new Request('http://localhost/');
		const response = await handleRequest(request, env as unknown as Env);

		expect(response.status).toBe(404);
	});

	it('returns 405 for non-GET methods', async () => {
		const request = new Request('http://localhost/prompts/test-id', {
			method: 'POST',
			headers: { Authorization: 'Bearer test_key' },
		});
		const response = await handleRequest(request, env as unknown as Env);

		expect(response.status).toBe(405);
		const body = await response.json();
		expect(body).toEqual({ error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
	});

	it('returns 204 for CORS preflight', async () => {
		const request = new Request('http://localhost/prompts/test-id', {
			method: 'OPTIONS',
		});
		const response = await handleRequest(request, env as unknown as Env);

		expect(response.status).toBe(204);
		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
		expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, OPTIONS');
		expect(response.headers.get('Access-Control-Allow-Headers')).toBe(
			'Authorization, Content-Type',
		);
	});

	it('includes CORS headers in error responses', async () => {
		const request = new Request('http://localhost/unknown');
		const response = await handleRequest(request, env as unknown as Env);

		expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
	});
});
