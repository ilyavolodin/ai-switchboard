import {
  asArray,
  asObject,
  asString,
  getPath,
  tryJson,
  type HttpClient,
  type JsonObject,
} from '@ai-switchboard/sdk';

export const GRAPHQL_URL = 'https://api.linear.app/graphql';

export const ISSUE_QUERY = `query Issue($id: String!) {
  issue(id: $id) {
    id identifier title url updatedAt priority priorityLabel
    state { id name type }
    team { id key }
    assignee { name }
    labels { nodes { id name } }
  }
}`;

export const TEAMS_QUERY = `query Teams($keys: [String!]) {
  teams(filter: { key: { in: $keys } }) { nodes { id key } }
}`;

export const VIEWER_QUERY = 'query Viewer { viewer { id name } }';

export const LABELS_QUERY = `query Labels($name: String!) {
  issueLabels(filter: { name: { eqIgnoreCase: $name } }) { nodes { id name team { id } } }
}`;

export const STATES_QUERY = `query States($teamId: ID!, $name: String!) {
  workflowStates(filter: { team: { id: { eq: $teamId } }, name: { eqIgnoreCase: $name } }) { nodes { id name } }
}`;

export const ISSUE_UPDATE = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

export const COMMENT_CREATE = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id url } }
}`;

export const WEBHOOK_CREATE = `mutation WebhookCreate($input: WebhookCreateInput!) {
  webhookCreate(input: $input) { success webhook { id enabled } }
}`;

export class LinearApiError extends Error {
  override readonly name = 'LinearApiError';
  readonly notFound: boolean;

  constructor(message: string, notFound = false) {
    super(message);
    this.notFound = notFound;
  }
}

const NOT_FOUND = /not found|could not find/i;

/** The objects of a GraphQL connection's `nodes`. */
export function nodes(value: unknown): JsonObject[] {
  return asArray(getPath(value, 'nodes')).flatMap((n) => {
    const o = asObject(n);
    return o ? [o] : [];
  });
}

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
      const body = asObject(tryJson(res));
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
