import { useReactFlow, useStore } from '@xyflow/react';
import { useEffect } from 'react';

const OPTIONS = { padding: 0.06, maxZoom: 1 } as const;

/**
 * Refits the canvas when its container changes size (the window, the banner, the canvas growing
 * to fill the page) or the laid-out graph changes (a filter, a new node); React Flow's `fitView`
 * prop only fits the first render. Render inside `<ReactFlow>`.
 */
export function FitView({ layoutKey }: { layoutKey: string }) {
  const { fitView } = useReactFlow();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  useEffect(() => {
    if (width === 0 || height === 0) return;
    const timer = setTimeout(() => void fitView(OPTIONS), 60);
    return () => {
      clearTimeout(timer);
    };
  }, [fitView, layoutKey, width, height]);
  return null;
}
