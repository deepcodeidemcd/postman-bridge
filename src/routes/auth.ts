import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config/env.js';

const USER_ID = Symbol('bridge.userId');

export function userIdOf(request: FastifyRequest): string {
  const tagged = (request as unknown as { [USER_ID]?: string })[USER_ID];
  if (tagged) return tagged;
  throw new Error('Request was not resolved to a user. requireApiKey must run first.');
}

export function isValidApiKey(token: string): boolean {
  return Object.values(config.server.apiKeys).includes(token);
}

export function resolveUserIdByKey(token: string): string | undefined {
  for (const [userId, key] of Object.entries(config.server.apiKeys)) {
    if (key === token) return userId;
  }
  return undefined;
}

export async function requireApiKey(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = request.headers.authorization;
  const token = auth ? auth.replace(/^Bearer\s+/i, '').trim() : '';

  const userId = resolveUserIdByKey(token);
  if (!userId) {
    reply.code(401).send({
      error: {
        message: 'Invalid or missing API key',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    });
    return;
  }
  (request as unknown as { [USER_ID]?: string })[USER_ID] = userId;
}