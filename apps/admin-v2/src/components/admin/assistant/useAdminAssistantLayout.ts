import { useCallback, useEffect, useState } from "react";

import {
  clampAdminAssistantLayout,
  clampAdminAssistantPosition,
  clampAdminAssistantSize,
  createDefaultAdminAssistantLayout,
  getAdminAssistantViewport,
  panelPositionFromBubble,
  readAdminAssistantLayoutPreferences,
  writeAdminAssistantLayoutPreferences,
  ADMIN_ASSISTANT_BUBBLE_SIZE,
  type AdminAssistantLayoutPreferences,
  type AdminAssistantMode,
  type AdminAssistantPosition,
  type AdminAssistantSize,
} from "./assistant-layout";

export interface AdminAssistantLayoutController
  extends AdminAssistantLayoutPreferences {
  mounted: boolean;
  setMode: (mode: AdminAssistantMode) => void;
  setBubblePosition: (position: AdminAssistantPosition) => void;
  setPanelPosition: (position: AdminAssistantPosition) => void;
  setPanelSize: (size: AdminAssistantSize) => void;
  positionPanelFromBubble: () => void;
}

export function useAdminAssistantLayout(): AdminAssistantLayoutController {
  const [mounted, setMounted] = useState(false);
  const [layout, setLayout] = useState<AdminAssistantLayoutPreferences>(() =>
    createDefaultAdminAssistantLayout(),
  );

  useEffect(() => {
    setLayout(
      readAdminAssistantLayoutPreferences(
        readBrowserStorage(),
        getAdminAssistantViewport(),
      ),
    );
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return undefined;
    const persistenceTimer = window.setTimeout(() => {
      writeAdminAssistantLayoutPreferences(readBrowserStorage(), layout);
    }, 160);
    return () => window.clearTimeout(persistenceTimer);
  }, [layout, mounted]);

  useEffect(() => {
    if (!mounted) return undefined;

    const handleResize = () => {
      setLayout((current) =>
        clampAdminAssistantLayout(current, getAdminAssistantViewport()),
      );
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [mounted]);

  const setMode = useCallback((mode: AdminAssistantMode) => {
    setLayout((current) => {
      const viewport = getAdminAssistantViewport();
      const panelSize = clampAdminAssistantSize(
        current.panelSize,
        viewport,
        mode,
      );
      return {
        ...current,
        mode,
        panelSize,
        panelPosition: clampAdminAssistantPosition(
          current.panelPosition,
          panelSize,
          viewport,
        ),
      };
    });
  }, []);

  const setBubblePosition = useCallback((position: AdminAssistantPosition) => {
    setLayout((current) => ({
      ...current,
      bubblePosition: clampAdminAssistantPosition(
        position,
        {
          width: ADMIN_ASSISTANT_BUBBLE_SIZE,
          height: ADMIN_ASSISTANT_BUBBLE_SIZE,
        },
        getAdminAssistantViewport(),
      ),
    }));
  }, []);

  const setPanelPosition = useCallback((position: AdminAssistantPosition) => {
    setLayout((current) => ({
      ...current,
      panelPosition: clampAdminAssistantPosition(
        position,
        current.panelSize,
        getAdminAssistantViewport(),
      ),
    }));
  }, []);

  const setPanelSize = useCallback((size: AdminAssistantSize) => {
    setLayout((current) => {
      const panelSize = clampAdminAssistantSize(
        size,
        getAdminAssistantViewport(),
        current.mode,
      );
      return {
        ...current,
        panelSize,
        panelPosition: clampAdminAssistantPosition(
          current.panelPosition,
          panelSize,
          getAdminAssistantViewport(),
        ),
      };
    });
  }, []);

  const positionPanelFromBubble = useCallback(() => {
    setLayout((current) => ({
      ...current,
      panelPosition: panelPositionFromBubble(
        current.bubblePosition,
        current.panelSize,
        getAdminAssistantViewport(),
      ),
    }));
  }, []);

  return {
    ...layout,
    mounted,
    setMode,
    setBubblePosition,
    setPanelPosition,
    setPanelSize,
    positionPanelFromBubble,
  };
}

function readBrowserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
