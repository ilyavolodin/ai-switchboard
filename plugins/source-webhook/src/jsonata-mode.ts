import { compileEventTypes, narrowMapped, type EventTypeDefinition } from '@ai-switchboard/sdk';

import { draftFor, type Delivery, type Mapper } from './mapper.js';
import { asList, compileExpression } from './mapping.js';
import { SOURCE_ID } from './settings.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Why one mapping result was dropped (`narrowMapped` returned null). */
function dropReason(item: unknown, declared: string[], index: number): string {
  const which = `Mapping result ${index + 1}`;
  if (!isRecord(item)) return `${which} is not an object, so it was dropped.`;
  if (typeof item.type !== 'string') return `${which} has no "type", so it was dropped.`;
  if (!declared.includes(item.type)) {
    return `${which} has type ${item.type}, which is not one of the event types (${declared.join(', ') || 'none'}), so it was dropped.`;
  }
  return `${which} (${item.type}) needs an artifact with a "kind" and an "id", so it was dropped.`;
}

/**
 * JSONata mode (the only mode before 1.1): the person declares `eventTypes` and writes a
 * `mapping` from `{ body, headers, query }` to one or more mapping results.
 */
export function compileJsonata(eventTypes: EventTypeDefinition[], mapping: string): Mapper {
  const types = compileEventTypes(SOURCE_ID, eventTypes);
  const expression = compileExpression(mapping, 'mapping');
  const declared = [...types.keys()];
  return {
    eventTypes: [...types.values()].map((t) => t.spec),
    async map(delivery: Delivery) {
      const { body, headers, query } = delivery;
      const result = await expression.evaluate({ body, headers, query }, delivery.receivedAt);
      const events = [];
      const notes: string[] = [];
      const items = asList(result);
      if (items.length === 0) notes.push('The mapping returned nothing for this delivery.');
      for (const [i, item] of items.entries()) {
        const mapped = narrowMapped(item, types);
        if (!mapped) {
          notes.push(dropReason(item, declared, i));
          continue;
        }
        events.push(draftFor(delivery, mapped, { hashFallback: false }));
      }
      return { events, notes };
    },
  };
}
