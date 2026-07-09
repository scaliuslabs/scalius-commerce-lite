import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  calculateAssistantPanelRect,
  clampAssistantGeometry,
  clearAssistantGeometry,
  defaultAssistantGeometry,
  moveAssistantLauncher,
  readAssistantGeometry,
  resizeAssistantPanel,
  writeAssistantGeometry,
  type AssistantGeometry,
  type AssistantPanelMode,
  type AssistantViewport,
} from "./assistant-geometry";

const SSR_VIEWPORT: AssistantViewport = { width: 1_024, height: 768 };

function readViewport(): AssistantViewport {
  if (typeof window === "undefined") return SSR_VIEWPORT;
  return {
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
  };
}

export function useAssistantGeometry() {
  const [viewport, setViewport] = useState<AssistantViewport>(SSR_VIEWPORT);
  const [geometry, setGeometry] = useState<AssistantGeometry>(() =>
    defaultAssistantGeometry(SSR_VIEWPORT),
  );
  const [ready, setReady] = useState(false);
  const viewportRef = useRef(viewport);

  useEffect(() => {
    const nextViewport = readViewport();
    viewportRef.current = nextViewport;
    setViewport(nextViewport);
    setGeometry(
      readAssistantGeometry(window.localStorage, nextViewport) ??
        defaultAssistantGeometry(nextViewport),
    );
    setReady(true);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const nextViewport = readViewport();
      viewportRef.current = nextViewport;
      setViewport(nextViewport);
      setGeometry((current) => clampAssistantGeometry(current, nextViewport));
    };

    window.addEventListener("resize", handleResize);
    window.visualViewport?.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.visualViewport?.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    writeAssistantGeometry(window.localStorage, geometry);
  }, [geometry, ready]);

  const update = useCallback(
    (transform: (current: AssistantGeometry) => AssistantGeometry) => {
      setGeometry((current) =>
        clampAssistantGeometry(transform(current), viewportRef.current),
      );
    },
    [],
  );

  const setMode = useCallback(
    (mode: AssistantPanelMode) => update((current) => ({ ...current, mode })),
    [update],
  );

  const setLauncher = useCallback(
    (launcherX: number, launcherY: number) =>
      update((current) => ({ ...current, launcherX, launcherY })),
    [update],
  );

  const moveLauncher = useCallback(
    (deltaX: number, deltaY: number) =>
      setGeometry((current) =>
        moveAssistantLauncher(current, viewportRef.current, deltaX, deltaY),
      ),
    [],
  );

  const resizePanel = useCallback(
    (widthDelta: number, heightDelta: number) =>
      setGeometry((current) =>
        resizeAssistantPanel(
          current,
          viewportRef.current,
          widthDelta,
          heightDelta,
        ),
      ),
    [],
  );

  const setPanelSize = useCallback(
    (panelWidth: number, panelHeight: number) =>
      update((current) => ({ ...current, panelWidth, panelHeight })),
    [update],
  );

  const reset = useCallback(() => {
    clearAssistantGeometry(window.localStorage);
    setGeometry(defaultAssistantGeometry(viewportRef.current));
  }, []);

  const panelRect = useMemo(
    () => calculateAssistantPanelRect(geometry, viewport),
    [geometry, viewport],
  );

  return {
    geometry,
    panelRect,
    canDock: viewport.width >= 640,
    ready,
    setLauncher,
    moveLauncher,
    resizePanel,
    setPanelSize,
    setMode,
    reset,
  };
}
