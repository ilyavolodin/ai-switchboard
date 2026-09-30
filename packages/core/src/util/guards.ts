export { isRecord } from '@ai-switchboard/sdk/json';

/** A non-empty string, or undefined. */
export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
