import {
  flattenAttributes,
  openAttributesSchema,
  type ArtifactRef,
  type EventTypeSpec,
} from '@ai-switchboard/sdk';

import { bodyHash, draftFor, type Delivery, type Mapper } from './mapper.js';
import { describeValue, readPath, scalarText } from './paths.js';

/** Quick mode's settings. */
export interface QuickSettings {
  quickEventType: string;
  artifactIdPath?: string;
  artifactVersionPath?: string;
}

/** `webhook.deploy.finished` → `webhook.deploy`, the artifact kind quick mode uses. */
export function quickArtifactKind(type: string): string {
  const object = type.split('.')[1] ?? 'request';
  return `webhook.${object}`;
}

/** The one event type a quick-mode instance declares: any flat attribute is accepted. */
export function quickEventType(s: QuickSettings): EventTypeSpec {
  return {
    type: s.quickEventType,
    title: 'Webhook delivery',
    description:
      'One event per delivery. Its attributes are the body’s top-level fields (strings, numbers, booleans and lists of them) plus one level of nested objects as `parent_child`, e.g. `deployment_id`.',
    attributes: openAttributesSchema(),
    examples: [{}],
  };
}

/**
 * Quick mode, zero configuration: every delivery becomes one event of `quickEventType`, its
 * attributes flattened from the body (`flattenAttributes`), its artifact id read from
 * `artifactIdPath` (or `body.id`, or a hash of the body).
 */
export function compileQuick(s: QuickSettings): Mapper {
  const spec = quickEventType(s);
  const kind = quickArtifactKind(s.quickEventType);
  return {
    eventTypes: [spec],
    map(delivery: Delivery) {
      const notes: string[] = [];
      let id: string | undefined;
      if (s.artifactIdPath !== undefined && s.artifactIdPath !== '') {
        const value = readPath(delivery, s.artifactIdPath);
        id = scalarText(value);
        if (id === undefined) {
          notes.push(
            `${s.artifactIdPath} is ${describeValue(value)}, not an id, so the artifact id is a hash of the body.`,
          );
        }
      } else {
        id = scalarText(readPath(delivery, 'body.id'));
      }
      id ??= `body-${bodyHash(delivery.raw)}`;
      const artifact: ArtifactRef = { kind, id };
      if (s.artifactVersionPath !== undefined && s.artifactVersionPath !== '') {
        const value = readPath(delivery, s.artifactVersionPath);
        const version = scalarText(value);
        if (version !== undefined) artifact.version = version;
        else
          notes.push(
            `${s.artifactVersionPath} is ${describeValue(value)}, so there is no version.`,
          );
      }
      const attributes = flattenAttributes(delivery.body);
      if (Object.keys(attributes).length === 0) {
        notes.push(
          'The body has no top-level text, number or boolean fields, so the event has no attributes.',
        );
      }
      return Promise.resolve({
        events: [
          draftFor(
            delivery,
            { type: spec.type, artifact, attributes, occurredAt: undefined, deliveryId: undefined },
            { hashFallback: true },
          ),
        ],
        notes,
      });
    },
  };
}
