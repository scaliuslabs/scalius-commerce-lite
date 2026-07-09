import {
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";

interface PointerGestureOptions {
  onMove: (deltaX: number, deltaY: number) => void;
  onEnd?: (moved: boolean) => void;
}

export function usePointerGesture() {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cleanupRef.current?.(), []);

  return useCallback(
    (event: ReactPointerEvent<HTMLElement>, options: PointerGestureOptions) => {
      if (event.button !== 0) return;
      cleanupRef.current?.();

      const pointerId = event.pointerId;
      const startX = event.clientX;
      const startY = event.clientY;
      let moved = false;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        if (Math.abs(deltaX) + Math.abs(deltaY) > 4) moved = true;
        if (moveEvent.cancelable) moveEvent.preventDefault();
        options.onMove(deltaX, deltaY);
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerEnd);
        window.removeEventListener("pointercancel", handlePointerEnd);
        window.removeEventListener("blur", handleWindowBlur);
        if (cleanupRef.current === cleanup) cleanupRef.current = null;
      };

      const handlePointerEnd = (endEvent: PointerEvent) => {
        if (endEvent.pointerId !== pointerId) return;
        cleanup();
        options.onEnd?.(moved);
      };

      const handleWindowBlur = () => {
        cleanup();
        options.onEnd?.(moved);
      };

      cleanupRef.current = cleanup;
      window.addEventListener("pointermove", handlePointerMove, {
        passive: false,
      });
      window.addEventListener("pointerup", handlePointerEnd);
      window.addEventListener("pointercancel", handlePointerEnd);
      window.addEventListener("blur", handleWindowBlur);
    },
    [],
  );
}
