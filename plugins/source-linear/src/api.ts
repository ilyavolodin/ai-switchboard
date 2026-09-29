import type { HttpClient } from '@ai-switchboard/sdk';

import { arr, obj, str, type Json } from './json.js';

export const GRAPHQL_URL = 'https://api.linear.app/graphql';

export class LinearApiError extends Error {
  override readonly name = 'LinearApiError';
  readonly notFound: boolean;

  constructor(message: string, notFound = false) {
    super(message);
    this.notFound = notFound;
  }
}

const NOT_FOUND = /not found|could not find/i;

export interface LinearApi {
  /** Throws `LinearApiError` on any error, including GraphQL errors. */
  graphql(query: string, variables?: Record<string, unknown>): Promise<Json>;
}

/** Personal API keys go in `Authorization` as-is; OAuth tokens already carry `Bearer`. */
export function createApi(http: HttpClient, apiKey: string): LinearApi {
  return {
    async graphql(query, variables = {}) {
      const res = await http.post(GRAPHQL_URL, {
        headers: { authorization: apiKey, 'user-agent': 'ai-switchboard' },
        json: { query, variables },
      });
      let body: Json | undefined;
      try {
        body = obj(res.json());
      } catch {
        body = undefined;
      }
      const errors = arr(body?.errors).map((e) => {
        const o = obj(e);
        return {
          message: str(o?.message) ?? 'unknown error',
          presentable: str(obj(o?.extensions)?.userPresentableMessage),
        };
      });
      if (errors.length > 0) {
        const notFound = errors.some(
          (e) => NOT_FOUND.test(e.message) || NOT_FOUND.test(e.presentable ?? ''),
        );
        throw new LinearApiError(
          `Linear answered ${res.status}: ${errors.map((e) => e.presentable ?? e.message).join('; ')}`,
          notFound,
        );
      }
      if (!res.ok || !body)
        throw new LinearApiError(`Linear answered ${res.status}`, res.status === 404);
      return obj(body.data) ?? {};
    },
  };
}
