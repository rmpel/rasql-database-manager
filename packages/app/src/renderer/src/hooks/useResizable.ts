import { useCallback, useEffect, useRef, useState } from 'react';

const read = (key: string, fallback: number): number => {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
};

/**
 * A draggable size for a docked panel. The value is a per-viewer convenience, so it lives in
 * localStorage. `onPointerDown` goes on the handle; dragging up grows a bottom-docked panel.
 */
export function useResizable(opts: {
  storageKey: string;
  initial: number;
  min: number;
  /** Upper bound as a fraction of the container's size, measured on drag start. */
  maxFraction?: number;
  containerRef: React.RefObject<HTMLElement | null>;
}): { size: number; onPointerDown: (e: React.PointerEvent) => void; resizing: boolean } {
  const [size, setSize] = useState(() => read(opts.storageKey, opts.initial));
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ startY: number; startSize: number; max: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const container = opts.containerRef.current;
      const max = container
        ? container.clientHeight * (opts.maxFraction ?? 0.85)
        : Number.POSITIVE_INFINITY;
      drag.current = { startY: e.clientY, startSize: size, max };
      setResizing(true);
      e.preventDefault();
    },
    [opts.containerRef, opts.maxFraction, size],
  );

  useEffect(() => {
    if (!resizing) return;
    const move = (e: PointerEvent): void => {
      const d = drag.current;
      if (!d) return;
      const next = Math.min(d.max, Math.max(opts.min, d.startSize + (d.startY - e.clientY)));
      setSize(next);
    };
    const up = (): void => {
      drag.current = null;
      setResizing(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [resizing, opts.min]);

  useEffect(() => {
    try {
      localStorage.setItem(opts.storageKey, String(Math.round(size)));
    } catch {
      /* storage may be unavailable */
    }
  }, [size, opts.storageKey]);

  return { size, onPointerDown, resizing };
}
