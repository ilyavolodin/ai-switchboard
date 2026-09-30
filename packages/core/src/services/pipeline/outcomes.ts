/**
 * How a delivery to `/hooks` or `/callbacks` ended. `rejected`: the plugin refused its
 * authentication; `malformed`: authenticated but unusable; `unavailable`: try again later.
 */
export const INGRESS_OUTCOMES = [
  'accepted',
  'rejected',
  'not_found',
  'malformed',
  'unavailable',
] as const;
export type IngressOutcome = (typeof INGRESS_OUTCOMES)[number];
