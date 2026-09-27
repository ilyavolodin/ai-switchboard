import { useReactFlow } from '@xyflow/react';
import { useEffect } from 'react';

const OPTIONS = { padding: 0.06, maxZoom: 1 } as const;

/**
 * Refits the canvas when the window resizes or the laid-out graph changes (a filter, a new
 * node); React Flow's `fitView` prop only fits the first render. Render inside `<ReactFlow>`.
 */
export function FitView({ layoutKey }: { layoutKey: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      void fitView(OPTIONS);
    });
    return () => {
      cancelAnimationFrame(id);
    };
  }, [fitView, layoutKey]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void fitView(OPTIONS), 120);
    };
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, [fitView]);
  return null;
}
