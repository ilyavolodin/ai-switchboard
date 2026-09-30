import {
  coerceAttribute,
  compileEventTypes,
  toIsoTime,
  type ArtifactRef,
  type Attributes,
  type EventTypeDefinition,
} from '@ai-switchboard/sdk';

import { draftFor, type Delivery, type Mapper } from '../mapper.js';
import { describeValue, readPath, scalarText } from '../paths.js';
import { SOURCE_ID, type MappedRule } from '../settings.js';

function ruleName(rule: MappedRule, index: number): string {
  return `Rule ${index + 1} (${rule.title || rule.type})`;
}

/**
 * The event type definitions the rules declare. Rules that produce the same type share one
 * definition: its title comes from the first, and its attributes are every rule's (the first
 * declaration of a name wins).
 */
export function ruleDefinitions(rules: MappedRule[]): EventTypeDefinition[] {
  const byType = new Map<string, EventTypeDefinition>();
  for (const rule of rules) {
    let def = byType.get(rule.type);
    if (!def) {
      def = {
        type: rule.type,
        title: rule.title,
        ...(rule.description !== undefined ? { description: rule.description } : {}),
        attributes: [],
      };
      byType.set(rule.type, def);
    }
    for (const a of rule.attributes ?? []) {
      if (def.attributes.some((x) => x.name === a.name)) continue;
      def.attributes.push({
        name: a.name,
        type: a.type,
        ...(a.description !== undefined ? { description: a.description } : {}),
      });
    }
  }
  return [...byType.values()];
}

function conditionHolds(rule: MappedRule, delivery: Delivery): { ok: boolean; seen: unknown } {
  const path = rule.when?.path;
  if (path === undefined || path === '') return { ok: true, seen: undefined };
  const seen = readPath(delivery, path);
  const expected = rule.when?.equals;
  if (expected === undefined || expected === '') {
    return { ok: seen !== undefined && seen !== '', seen };
  }
  const values = Array.isArray(seen) ? (seen as unknown[]) : [seen];
  return { ok: values.some((v) => scalarText(v) === expected), seen };
}

function optionalText(
  delivery: Delivery,
  path: string | undefined,
  what: string,
  notes: string[],
  where: string,
): string | undefined {
  if (path === undefined || path === '') return undefined;
  const value = readPath(delivery, path);
  const text = scalarText(value);
  if (text === undefined) notes.push(`${where}: ${what} path ${path} is ${describeValue(value)}.`);
  return text;
}

/** The first rule whose condition holds produces the event. */
export function compileMapped(rules: MappedRule[]): Mapper {
  const types = compileEventTypes(SOURCE_ID, ruleDefinitions(rules));
  return {
    eventTypes: [...types.values()].map((t) => t.spec),
    map(delivery: Delivery) {
      const notes: string[] = [];
      const index = rules.findIndex((rule) => conditionHolds(rule, delivery).ok);
      const rule = rules[index];
      if (!rule) {
        const why = rules.map((r, i) => {
          const seen = conditionHolds(r, delivery).seen;
          const expected = r.when?.equals;
          return `${ruleName(r, i)} wants ${r.when?.path ?? ''}${expected ? ` = "${expected}"` : ' to have a value'} and it is ${describeValue(seen)}`;
        });
        notes.push(`No rule matched, so this delivery produces no event. ${why.join('; ')}.`);
        return Promise.resolve({ events: [], notes });
      }
      const where = ruleName(rule, index);
      const compiled = types.get(rule.type);
      const idValue = readPath(delivery, rule.artifactIdPath);
      const id = scalarText(idValue);
      if (!compiled || id === undefined) {
        notes.push(
          `${where} matched, but its artifact id path ${rule.artifactIdPath} is ${describeValue(idValue)}, so no event was produced.`,
        );
        return Promise.resolve({ events: [], notes });
      }
      const artifact: ArtifactRef = { kind: rule.artifactKind, id };
      const url = optionalText(delivery, rule.artifactUrlPath, 'URL', notes, where);
      if (url !== undefined) artifact.url = url;
      const version = optionalText(delivery, rule.artifactVersionPath, 'version', notes, where);
      if (version !== undefined) artifact.version = version;

      const attributes: Attributes = {};
      for (const a of rule.attributes ?? []) {
        const kind = compiled.attributes.get(a.name) ?? a.type;
        const value = readPath(delivery, a.path);
        const coerced = value === undefined ? undefined : coerceAttribute(value, kind);
        if (coerced !== undefined) attributes[a.name] = coerced;
        else if (value === undefined)
          notes.push(`${where}: attribute ${a.name} — ${a.path} has no value.`);
        else
          notes.push(`${where}: attribute ${a.name} — ${describeValue(value)} is not a ${kind}.`);
      }

      let occurredAt: string | undefined;
      if (rule.occurredAtPath !== undefined && rule.occurredAtPath !== '') {
        const value = readPath(delivery, rule.occurredAtPath);
        occurredAt = toIsoTime(value);
        if (occurredAt === undefined) {
          notes.push(
            `${where}: occurred-at path ${rule.occurredAtPath} is ${describeValue(value)}, not a time; the receipt time is used.`,
          );
        }
      }
      return Promise.resolve({
        events: [
          draftFor(
            delivery,
            { type: rule.type, artifact, attributes, occurredAt, deliveryId: undefined },
            { hashFallback: true },
          ),
        ],
        notes,
      });
    },
  };
}
