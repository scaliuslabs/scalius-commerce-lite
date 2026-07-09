export type AssistantPanelMode = "floating" | "dock-left" | "dock-right";

export type AssistantViewport = {
  width: number;
  height: number;
};

export type AssistantGeometry = {
  mode: AssistantPanelMode;
  panelWidth: number;
  panelHeight: number;
  launcherX: number;
  launcherY: number;
};

export type AssistantPanelRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type GeometryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const ASSISTANT_GEOMETRY_STORAGE_KEY =
  "scalius.storefront-assistant.geometry.v1";
export const ASSISTANT_LAUNCHER_SIZE = 56;
export const ASSISTANT_EDGE_GAP = 16;
export const ASSISTANT_MIN_PANEL_WIDTH = 340;
export const ASSISTANT_MAX_PANEL_WIDTH = 720;
export const ASSISTANT_MIN_PANEL_HEIGHT = 420;
export const ASSISTANT_MAX_PANEL_HEIGHT = 840;

const DEFAULT_PANEL_WIDTH = 424;
const DEFAULT_PANEL_HEIGHT = 640;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function availablePanelWidth(viewport: AssistantViewport): number {
  return Math.max(240, viewport.width - ASSISTANT_EDGE_GAP * 2);
}

function availablePanelHeight(viewport: AssistantViewport): number {
  return Math.max(320, viewport.height - ASSISTANT_EDGE_GAP * 2);
}

export function defaultAssistantGeometry(
  viewport: AssistantViewport,
): AssistantGeometry {
  return clampAssistantGeometry(
    {
      mode: "floating",
      panelWidth: DEFAULT_PANEL_WIDTH,
      panelHeight: DEFAULT_PANEL_HEIGHT,
      launcherX: viewport.width - ASSISTANT_LAUNCHER_SIZE - ASSISTANT_EDGE_GAP,
      launcherY: viewport.height - ASSISTANT_LAUNCHER_SIZE - ASSISTANT_EDGE_GAP,
    },
    viewport,
  );
}

export function clampAssistantGeometry(
  geometry: AssistantGeometry,
  viewport: AssistantViewport,
): AssistantGeometry {
  const maxPanelWidth = Math.min(
    ASSISTANT_MAX_PANEL_WIDTH,
    availablePanelWidth(viewport),
  );
  const maxPanelHeight = Math.min(
    ASSISTANT_MAX_PANEL_HEIGHT,
    availablePanelHeight(viewport),
  );
  const minPanelWidth = Math.min(ASSISTANT_MIN_PANEL_WIDTH, maxPanelWidth);
  const minPanelHeight = Math.min(ASSISTANT_MIN_PANEL_HEIGHT, maxPanelHeight);
  const maxLauncherX = Math.max(
    ASSISTANT_EDGE_GAP,
    viewport.width - ASSISTANT_LAUNCHER_SIZE - ASSISTANT_EDGE_GAP,
  );
  const maxLauncherY = Math.max(
    ASSISTANT_EDGE_GAP,
    viewport.height - ASSISTANT_LAUNCHER_SIZE - ASSISTANT_EDGE_GAP,
  );

  return {
    mode: geometry.mode,
    panelWidth: Math.round(
      clamp(geometry.panelWidth, minPanelWidth, maxPanelWidth),
    ),
    panelHeight: Math.round(
      clamp(geometry.panelHeight, minPanelHeight, maxPanelHeight),
    ),
    launcherX: Math.round(
      clamp(geometry.launcherX, ASSISTANT_EDGE_GAP, maxLauncherX),
    ),
    launcherY: Math.round(
      clamp(geometry.launcherY, ASSISTANT_EDGE_GAP, maxLauncherY),
    ),
  };
}

export function normalizeAssistantGeometry(
  value: unknown,
  viewport: AssistantViewport,
): AssistantGeometry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const mode = record.mode;
  const panelWidth = finiteNumber(record.panelWidth);
  const panelHeight = finiteNumber(record.panelHeight);
  const launcherX = finiteNumber(record.launcherX);
  const launcherY = finiteNumber(record.launcherY);

  if (
    (mode !== "floating" && mode !== "dock-left" && mode !== "dock-right") ||
    panelWidth === null ||
    panelHeight === null ||
    launcherX === null ||
    launcherY === null
  ) {
    return null;
  }

  return clampAssistantGeometry(
    { mode, panelWidth, panelHeight, launcherX, launcherY },
    viewport,
  );
}

export function readAssistantGeometry(
  storage: GeometryStorage,
  viewport: AssistantViewport,
): AssistantGeometry | null {
  try {
    const serialized = storage.getItem(ASSISTANT_GEOMETRY_STORAGE_KEY);
    if (!serialized) return null;
    return normalizeAssistantGeometry(JSON.parse(serialized), viewport);
  } catch {
    return null;
  }
}

export function writeAssistantGeometry(
  storage: GeometryStorage,
  geometry: AssistantGeometry,
): boolean {
  try {
    storage.setItem(
      ASSISTANT_GEOMETRY_STORAGE_KEY,
      JSON.stringify({
        mode: geometry.mode,
        panelWidth: geometry.panelWidth,
        panelHeight: geometry.panelHeight,
        launcherX: geometry.launcherX,
        launcherY: geometry.launcherY,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearAssistantGeometry(storage: GeometryStorage): boolean {
  try {
    storage.removeItem(ASSISTANT_GEOMETRY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function calculateAssistantPanelRect(
  geometry: AssistantGeometry,
  viewport: AssistantViewport,
): AssistantPanelRect {
  const current = clampAssistantGeometry(geometry, viewport);
  const width = current.panelWidth;
  const height = current.panelHeight;
  const maxLeft = Math.max(
    ASSISTANT_EDGE_GAP,
    viewport.width - width - ASSISTANT_EDGE_GAP,
  );
  const maxTop = Math.max(
    ASSISTANT_EDGE_GAP,
    viewport.height - height - ASSISTANT_EDGE_GAP,
  );

  if (current.mode === "dock-left") {
    return {
      left: ASSISTANT_EDGE_GAP,
      top: ASSISTANT_EDGE_GAP,
      width,
      height: availablePanelHeight(viewport),
    };
  }
  if (current.mode === "dock-right") {
    return {
      left: maxLeft,
      top: ASSISTANT_EDGE_GAP,
      width,
      height: availablePanelHeight(viewport),
    };
  }

  const launcherOnLeft =
    current.launcherX + ASSISTANT_LAUNCHER_SIZE / 2 < viewport.width / 2;
  const preferredLeft = launcherOnLeft
    ? current.launcherX
    : current.launcherX + ASSISTANT_LAUNCHER_SIZE - width;
  const preferredTop = current.launcherY - height - 12;

  return {
    left: Math.round(clamp(preferredLeft, ASSISTANT_EDGE_GAP, maxLeft)),
    top: Math.round(clamp(preferredTop, ASSISTANT_EDGE_GAP, maxTop)),
    width,
    height,
  };
}

export function moveAssistantLauncher(
  geometry: AssistantGeometry,
  viewport: AssistantViewport,
  deltaX: number,
  deltaY: number,
): AssistantGeometry {
  return clampAssistantGeometry(
    {
      ...geometry,
      launcherX: geometry.launcherX + deltaX,
      launcherY: geometry.launcherY + deltaY,
    },
    viewport,
  );
}

export function resizeAssistantPanel(
  geometry: AssistantGeometry,
  viewport: AssistantViewport,
  widthDelta: number,
  heightDelta: number,
): AssistantGeometry {
  return clampAssistantGeometry(
    {
      ...geometry,
      panelWidth: geometry.panelWidth + widthDelta,
      panelHeight:
        geometry.mode === "floating"
          ? geometry.panelHeight + heightDelta
          : geometry.panelHeight,
    },
    viewport,
  );
}
