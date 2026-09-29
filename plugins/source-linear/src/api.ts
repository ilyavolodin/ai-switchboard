import { type HttpClient, asArray, asObject, asString, type JsonObject } from '@ai-switchboard/sdk';

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
  graphql(query: string, variables?: Record<string, unknown>): Promise<JsonObject>;
}

/** Personal API keys go in `Authorization` as-is; OAuth tokens already carry `Bearer`. */
export function createApi(http: HttpClient, apiKey: string): LinearApi {
  return {
    async graphql(query, variables = {}) {
      const res = await http.post(GRAPHQL_URL, {
        headers: { authorization: apiKey, 'user-agent': 'ai-switchboard' },
        json: { query, variables },
      });
      let body: JsonObject | undefined;
      try {
        body = asObject(res.json());
      } catch {
        body = undefined;
      }
      const errors = asArray(body?.errors).map((e) => {
        const o = asObject(e);
        return {
          message: asString(o?.message) ?? 'unknown error',
          presentable: asString(asObject(o?.extensions)?.userPresentableMessage),
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
      return asObject(body.data) ?? {};
    },
  };
}
