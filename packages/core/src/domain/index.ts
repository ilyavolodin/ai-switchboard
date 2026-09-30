/** Browser-safe (`@ai-switchboard/core/domain`): no Node or server imports belong here. */
export * from './status.js';
export * from './labels.js';
export * from './defaults.js';
export * from './process.js';
export * from './instance-error.js';
export { coalesceArrivals, type CoalescedBatch } from '../pipeline/batch.js';
