import type { JSONSchema } from '@ai-switchboard/sdk';

export interface LogSettings {
  level: 'debug' | 'info' | 'warn';
  logInput: boolean;
  maxLoggedBytes: number;
  /** When set, the `hourly_runs` meter reports invocations in the last hour against this limit. */
  hourlyLimit?: number;
}

export const settingsSchema: JSONSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    level: {
      enum: ['debug', 'info', 'warn'],
      default: 'info',
      title: 'Log level',
      description: 'The level of the log line written for every invocation.',
      'x-group': 'Logging',
    },
    logInput: {
      type: 'boolean',
      default: true,
      title: 'Log the input',
      description: 'Include the mapped input in the log line (truncated to the size below).',
      'x-group': 'Logging',
    },
    maxLoggedBytes: {
      type: 'integer',
      minimum: 64,
      maximum: 65_536,
      default: 4096,
      title: 'Largest logged input (bytes)',
      description:
        'Inputs longer than this are truncated in the log line; the run keeps them whole.',
      'x-group': 'Logging',
    },
    hourlyLimit: {
      type: 'integer',
      minimum: 1,
      title: 'Simulated hourly limit',
      description:
        'Optional. Adds an "Hourly runs" meter that reports invocations in the last hour against this limit, so ceilings and throttling can be tried out.',
      'x-group': 'Simulated meter',
    },
  },
};
