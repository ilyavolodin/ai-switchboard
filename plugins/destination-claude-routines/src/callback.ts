import {
  CALLBACK_BODY_PROPERTIES,
  verifySwitchboardCallback,
  type CallbackResult,
  type JSONSchema,
  type RawRequest,
  type SwitchboardCallbackBody,
} from '@ai-switchboard/sdk';

import { USAGE_DIMENSIONS } from './settings.js';

export interface RoutineCallbackBody extends SwitchboardCallbackBody {
  sessionUrl?: string;
  usage?: Partial<
    Record<
      | 'input_tokens'
      | 'output_tokens'
      | 'cache_read_tokens'
      | 'cache_write_tokens'
      | 'duration_seconds',
      number
    >
  >;
}

const count = { type: 'number', minimum: 0 };

export const callbackBodySchema: JSONSchema = {
  type: 'object',
  required: ['runId', 'status'],
  properties: {
    ...CALLBACK_BODY_PROPERTIES,
    // A routine links its session through `sessionUrl`.
    externalUrl: {},
    sessionUrl: { type: 'string', format: 'uri', pattern: '^https://' },
    usage: {
      type: 'object',
      properties: {
        input_tokens: count,
        output_tokens: count,
        cache_read_tokens: count,
        cache_write_tokens: count,
        duration_seconds: count,
      },
    },
  },
};

const DECLARED = new Set(USAGE_DIMENSIONS.map((d) => d.id));

/** `null` for anything unsigned, wrongly signed or malformed; never throws. */
export function verifyRoutineCallback(req: RawRequest, secret: string): CallbackResult | null {
  return verifySwitchboardCallback<RoutineCallbackBody>(req, secret, DECLARED, {
    schema: callbackBodySchema,
    externalUrl: (body) => body.sessionUrl,
  });
}
