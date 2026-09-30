/** Where a push source's sender delivers its webhooks. */
export function hookUrl(publicUrl: string, sourceId: string): string {
  return `${publicUrl}${hookPath(sourceId)}`;
}

export function hookPath(sourceId: string): string {
  return `/hooks/${sourceId}`;
}

/** Where a destination's backend reports on a run it started. */
export function callbackUrl(publicUrl: string, destinationId: string): string {
  return `${publicUrl}/callbacks/${destinationId}`;
}
