import { useDestinations, useNotifiers, useSources } from '../../api/index.js';

/** Names for the ids a process document holds; an unknown id reads as ''. */
export function useEditorLookups() {
  const sources = useSources();
  const destinations = useDestinations();
  const notifiers = useNotifiers();
  const sourceList = sources.data ?? [];
  const destinationList = destinations.data ?? [];
  const notifierList = notifiers.data ?? [];
  const sourceName = (id: string) => sourceList.find((s) => s.id === id)?.name ?? '';
  const destinationSummary = (id: string) => destinationList.find((x) => x.id === id);
  return {
    sources: sourceList,
    destinations: destinationList,
    notifiers: notifierList,
    sourceName,
    destinationSummary,
    notifierName: (id: string) => notifierList.find((n) => n.id === id)?.name ?? '',
    /** A step runs on a source or the destination. */
    providerName: (id: string) => sourceName(id) || (destinationSummary(id)?.name ?? ''),
  };
}
