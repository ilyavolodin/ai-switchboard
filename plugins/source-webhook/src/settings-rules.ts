/** Mapped mode's rule schema, for `settings.ts`. Browser-safe like it. */
import type { JSONSchema } from '@ai-switchboard/sdk';
import {
  ATTRIBUTE_KINDS,
  ATTRIBUTE_NAME_PATTERN,
  customEventTypePattern,
  type AttributeKind,
} from '@ai-switchboard/sdk/schema';

import { PATH_PATTERN } from './paths.js';

export interface MappedAttribute {
  name: string;
  path: string;
  type: AttributeKind;
  description?: string;
}

export interface MappedRule {
  type: string;
  title: string;
  description?: string;
  when?: { path?: string; equals?: string };
  artifactKind: string;
  artifactIdPath: string;
  artifactUrlPath?: string;
  artifactVersionPath?: string;
  occurredAtPath?: string;
  attributes?: MappedAttribute[];
}

const attributeSchema: JSONSchema = {
  type: 'object',
  title: 'Attribute',
  required: ['name', 'path', 'type'],
  properties: {
    name: {
      type: 'string',
      pattern: ATTRIBUTE_NAME_PATTERN,
      title: 'Name',
      description: 'How filters refer to it: `attributes.<name>`. Letters, digits, _.',
    },
    path: {
      type: 'string',
      pattern: PATH_PATTERN,
      title: 'Path',
      description: 'Where the value is, e.g. `body.issue.priority`.',
      'x-widget': 'path',
    },
    type: {
      type: 'string',
      enum: [...ATTRIBUTE_KINDS],
      default: 'string',
      title: 'Type',
      description:
        'Values are converted: numbers to text for string, "42" to 42 for number, a single text to a one-item list for string[].',
    },
    description: {
      type: 'string',
      title: 'Description',
      description: 'What the attribute holds, shown in the filter editor.',
    },
  },
};

/** One rule of mapped mode; `sourceId` namespaces its event type. */
export function ruleSchema(sourceId: string): JSONSchema {
  return {
    type: 'object',
    title: 'Rule',
    required: ['type', 'title', 'artifactKind', 'artifactIdPath'],
    properties: {
      type: {
        type: 'string',
        pattern: customEventTypePattern(sourceId),
        title: 'Event type',
        description: 'Must look like `webhook.<object>.<verb>`, e.g. `webhook.issue.created`.',
      },
      title: { type: 'string', minLength: 1, title: 'Title', description: 'Shown in the UI.' },
      description: {
        type: 'string',
        title: 'Description',
        description: 'What this event means, for the people writing filters.',
      },
      when: {
        type: 'object',
        title: 'Only when',
        description:
          'Optional. The rule applies only when the value at this path equals the text (or, with no text, when the path has any value). Leave empty to take every delivery.',
        properties: {
          path: {
            type: 'string',
            pattern: PATH_PATTERN,
            title: 'Path',
            description: 'e.g. `headers.x-event-type` or `body.action`.',
            'x-widget': 'path',
          },
          equals: {
            type: 'string',
            title: 'Equals',
            description: 'e.g. `issue.created`. Compared as text.',
          },
        },
      },
      artifactKind: {
        type: 'string',
        minLength: 1,
        title: 'Artifact kind',
        description:
          'What the event is about, e.g. `issue` or `deploy`. Events about the same kind and id are the same artifact in traces.',
      },
      artifactIdPath: {
        type: 'string',
        pattern: PATH_PATTERN,
        title: 'Artifact id path',
        description: 'e.g. `body.issue.id`. A delivery without a value here produces no event.',
        'x-widget': 'path',
      },
      artifactUrlPath: {
        type: 'string',
        pattern: PATH_PATTERN,
        title: 'Artifact URL path',
        description: 'Optional. A link to the thing, e.g. `body.issue.url`.',
        'x-widget': 'path',
      },
      artifactVersionPath: {
        type: 'string',
        pattern: PATH_PATTERN,
        title: 'Version path',
        description:
          'Optional. An updated-at time or revision, e.g. `body.issue.updated_at`, so a redelivery is dropped as a duplicate.',
        'x-widget': 'path',
      },
      occurredAtPath: {
        type: 'string',
        pattern: PATH_PATTERN,
        title: 'Occurred-at path',
        description:
          'Optional. When it happened (ISO time or epoch seconds/ms). Empty: when the delivery arrived.',
        'x-widget': 'path',
      },
      attributes: {
        type: 'array',
        title: 'Attributes',
        description:
          'The named facts filters can use. Each is read from a path in the delivery, e.g. name `priority`, path `body.issue.priority`, type string.',
        items: attributeSchema,
      },
    },
  };
}
