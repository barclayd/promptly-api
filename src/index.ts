import { handleRequest } from './handler.ts';
import type { Env } from './types.ts';

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error('Unhandled error:', error);

      return new Response(
        JSON.stringify({
          error: 'Internal server error',
          code: 'INTERNAL_ERROR',
        }),
        {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        },
      );
    }
  },
} satisfies ExportedHandler<Env>;
