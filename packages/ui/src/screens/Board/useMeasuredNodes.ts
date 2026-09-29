import type { NodeChange } from '@xyflow/react';
import { useCallback, useState } from 'react';

import { mergeDimensions, type Size } from './boardFlow.js';

/**
 * The canvas is controlled and rebuilt on every hover and poll; React Flow hides a node it has no
 * dimensions for, so the sizes it measured are kept and handed back on each node.
 */
export function useMeasuredNodes() {
  const [measured, setMeasured] = useState<Record<string, Size>>({});
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const sized = changes.flatMap((c) =>
      c.type === 'dimensions' && c.dimensions ? [{ id: c.id, dimensions: c.dimensions }] : [],
    );
    if (sized.length > 0) setMeasured((prev) => mergeDimensions(prev, sized));
  }, []);
  return { measured, onNodesChange };
}
