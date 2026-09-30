import {
  compileEventTypes,
  describeMappedDrop,
  narrowMapped,
  type EventTypeDefinition,
} from '@ai-switchboard/sdk';
import { asList, compileExpression } from '@ai-switchboard/sdk/jsonata';

import { draftFor, type Delivery, type Mapper } from '../mapper.js';
import { SOURCE_ID } from '../settings.js';

/** The only mode before 1.1. */
export function compileJsonata(eventTypes: EventTypeDefinition[], mapping: string): Mapper {
  const types = compileEventTypes(SOURCE_ID, eventTypes);
  const expression = compileExpression(mapping, 'mapping');
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
          notes.push(describeMappedDrop(item, types, i));
          continue;
        }
        events.push(draftFor(delivery, mapped, { hashFallback: false }));
      }
      return { events, notes };
    },
  };
}
