import {
  asObject,
  asString,
  responseSnippet,
  tryJson,
  type HttpClient,
  type JsonObject,
} from '@ai-switchboard/sdk';

export const SLACK_API = 'https://slack.com/api';

export class SlackError extends Error {
  override readonly name = 'SlackError';
}

export interface SlackApi {
  /** A Web API method with the bot token; throws `SlackError` unless Slack answers `ok: true`. */
  call(method: string, body: unknown): Promise<JsonObject>;
  /** Posts to an incoming webhook; throws `SlackError` on a refusal. */
  postWebhook(url: string, body: unknown): Promise<void>;
}

export function createApi(http: HttpClient, botToken: string | undefined): SlackApi {
  return {
    async call(method, body) {
      const res = await http.post(`${SLACK_API}/${method}`, {
        headers: { authorization: `Bearer ${botToken ?? ''}` },
        json: body,
      });
      if (!res.ok) {
        const retry = res.headers['retry-after'];
        throw new SlackError(
          `Slack ${method} answered ${res.status}${retry !== undefined ? ` (retry after ${retry}s)` : ''}`,
        );
      }
      const parsed = tryJson(res);
      if (parsed === undefined) throw new SlackError(`Slack ${method} returned a non-JSON body`);
      const record = asObject(parsed) ?? {};
      if (record.ok !== true) {
        throw new SlackError(
          `Slack ${method} failed: ${asString(record.error) ?? 'unknown_error'}`,
        );
      }
      return record;
    },
    async postWebhook(url, body) {
      const res = await http.post(url, { json: body });
      if (!res.ok) {
        // Incoming webhooks answer with a plain-text reason such as `no_service` or `invalid_blocks`.
        throw new SlackError(`Slack webhook answered ${res.status}: ${responseSnippet(res)}`);
      }
    },
  };
}
