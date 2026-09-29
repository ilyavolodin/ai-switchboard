import { useReactFlow, useStore } from '@xyflow/react';
import { useEffect } from 'react';

const OPTIONS = { padding: 0.06, maxZoom: 1 } as const;

/**
 * React Flow's `fitView` prop only fits the first render, so refit when the container resizes or
 * the laid-out graph changes. Render inside `<ReactFlow>`.
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
