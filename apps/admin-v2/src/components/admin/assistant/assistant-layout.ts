export type AdminAssistantMode = "floating" | "dock-left" | "dock-right";

export interface AdminAssistantPosition {
  x: number;
  y: number;
}

export interface AdminAssistantSize {
  width: number;
  height: number;
}

export interface AdminAssistantViewport {
  width: number;
  height: number;
}

export interface AdminAssistantLayoutPreferences {
  mode: AdminAssistantMode;
  bubblePosition: AdminAssistantPosition;
  panelPosition: AdminAssistantPosition;
  panelSize: AdminAssistantSize;
}

export const ADMIN_ASSISTANT_LAYOUT_STORAGE_KEY =
  "scalius:admin-assistant-layout:v1";
export const ADMIN_ASSISTANT_BUBBLE_SIZE = 56;
export const ADMIN_ASSISTANT_MIN_PANEL_WIDTH = 320;
export const ADMIN_ASSISTANT_MIN_PANEL_HEIGHT = 360;
export const ADMIN_ASSISTANT_MAX_PANEL_WIDTH = 720;
export const ADMIN_ASSISTANT_MAX_PANEL_HEIGHT = 860;

const DEFAULT_PANEL_WIDTH = 420;
const DEFAULT_PANEL_HEIGHT = 620;
const DESKTOP_EDGE_GAP = 16;
const COMPACT_EDGE_GAP = 8;

export function getAdminAssistantViewport(): AdminAssistantViewport {
  if (typeof window === "undefined") return { width: 1024, height: 768 };
  return {
    width: Math.max(0, window.innerWidth),
    height: Math.max(0, window.innerHeight),
  };
}

export function getAdminAssistantEdgeGap(viewport: AdminAssistantViewport): number {
  return viewport.width < 640 ? COMPACT_EDGE_GAP : DESKTOP_EDGE_GAP;
}

export function createDefaultAdminAssistantLayout(
  viewport = getAdminAssistantViewport(),
): AdminAssistantLayoutPreferences {
  const gap = getAdminAssistantEdgeGap(viewport);
  const panelSize = clampAdminAssistantSize(
    { width: DEFAULT_PANEL_WIDTH, height: DEFAULT_PANEL_HEIGHT },
    viewport,
  );
  const bubblePosition = clampAdminAssistantPosition(
    {
      x: viewport.width - ADMIN_ASSISTANT_BUBBLE_SIZE - gap,
      y: viewport.height - ADMIN_ASSISTANT_BUBBLE_SIZE - gap,
    },
    {
      width: ADMIN_ASSISTANT_BUBBLE_SIZE,
      height: ADMIN_ASSISTANT_BUBBLE_SIZE,
    },
    viewport,
  );

  return {
    mode: "floating",
    bubblePosition,
    panelPosition: clampAdminAssistantPosition(
      {
        x: bubblePosition.x + ADMIN_ASSISTANT_BUBBLE_SIZE - panelSize.width,
        y: bubblePosition.y + ADMIN_ASSISTANT_BUBBLE_SIZE - panelSize.height,
      },
      panelSize,
      viewport,
    ),
    panelSize,
  };
}

export function clampAdminAssistantLayout(
  layout: AdminAssistantLayoutPreferences,
  viewport = getAdminAssistantViewport(),
): AdminAssistantLayoutPreferences {
  const panelSize = clampAdminAssistantSize(layout.panelSize, viewport);
  return {
    mode: isAdminAssistantMode(layout.mode) ? layout.mode : "floating",
    bubblePosition: clampAdminAssistantPosition(
      layout.bubblePosition,
      {
        width: ADMIN_ASSISTANT_BUBBLE_SIZE,
        height: ADMIN_ASSISTANT_BUBBLE_SIZE,
      },
      viewport,
    ),
    panelPosition: clampAdminAssistantPosition(
      layout.panelPosition,
      panelSize,
      viewport,
    ),
    panelSize,
  };
}

export function clampAdminAssistantPosition(
  position: AdminAssistantPosition,
  size: AdminAssistantSize,
  viewport = getAdminAssistantViewport(),
): AdminAssistantPosition {
  const gap = getAdminAssistantEdgeGap(viewport);
  const maxX = Math.max(gap, viewport.width - size.width - gap);
  const maxY = Math.max(gap, viewport.height - size.height - gap);
  return {
    x: clampFinite(position.x, gap, maxX),
    y: clampFinite(position.y, gap, maxY),
  };
}

export function clampAdminAssistantSize(
  size: AdminAssistantSize,
  viewport = getAdminAssistantViewport(),
): AdminAssistantSize {
  const gap = getAdminAssistantEdgeGap(viewport);
  const availableWidth = Math.max(1, viewport.width - gap * 2);
  const availableHeight = Math.max(1, viewport.height - gap * 2);
  const minWidth = Math.min(ADMIN_ASSISTANT_MIN_PANEL_WIDTH, availableWidth);
  const minHeight = Math.min(ADMIN_ASSISTANT_MIN_PANEL_HEIGHT, availableHeight);

  return {
    width: clampFinite(
      size.width,
      minWidth,
      Math.min(ADMIN_ASSISTANT_MAX_PANEL_WIDTH, availableWidth),
    ),
    height: clampFinite(
      size.height,
      minHeight,
      Math.min(ADMIN_ASSISTANT_MAX_PANEL_HEIGHT, availableHeight),
    ),
  };
}

export function panelPositionFromBubble(
  bubblePosition: AdminAssistantPosition,
  panelSize: AdminAssistantSize,
  viewport = getAdminAssistantViewport(),
): AdminAssistantPosition {
  return clampAdminAssistantPosition(
    {
      x: bubblePosition.x + ADMIN_ASSISTANT_BUBBLE_SIZE - panelSize.width,
      y: bubblePosition.y + ADMIN_ASSISTANT_BUBBLE_SIZE - panelSize.height,
    },
    panelSize,
    viewport,
  );
}

export function readAdminAssistantLayoutPreferences(
  storage: Pick<Storage, "getItem"> | null,
  viewport = getAdminAssistantViewport(),
): AdminAssistantLayoutPreferences {
  const fallback = createDefaultAdminAssistantLayout(viewport);
  if (!storage) return fallback;

  try {
    const raw = storage.getItem(ADMIN_ASSISTANT_LAYOUT_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const mode = isAdminAssistantMode(parsed.mode) ? parsed.mode : fallback.mode;
    const bubblePosition = readPosition(parsed.bubblePosition) ?? fallback.bubblePosition;
    const panelPosition = readPosition(parsed.panelPosition) ?? fallback.panelPosition;
    const panelSize = readSize(parsed.panelSize) ?? fallback.panelSize;

    return clampAdminAssistantLayout(
      { mode, bubblePosition, panelPosition, panelSize },
      viewport,
    );
  } catch {
    return fallback;
  }
}

export function writeAdminAssistantLayoutPreferences(
  storage: Pick<Storage, "setItem"> | null,
  layout: AdminAssistantLayoutPreferences,
): void {
  if (!storage) return;
  try {
    storage.setItem(
      ADMIN_ASSISTANT_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        mode: layout.mode,
        bubblePosition: layout.bubblePosition,
        panelPosition: layout.panelPosition,
        panelSize: layout.panelSize,
      }),
    );
  } catch {
    // Layout persistence is optional; storage can be unavailable or quota-limited.
  }
}

export function isAdminAssistantMode(value: unknown): value is AdminAssistantMode {
  return value === "floating" || value === "dock-left" || value === "dock-right";
}

function readPosition(value: unknown): AdminAssistantPosition | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) return null;
  return { x: Number(record.x), y: Number(record.y) };
}

function readSize(value: unknown): AdminAssistantSize | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Number.isFinite(record.width) || !Number.isFinite(record.height)) return null;
  return { width: Number(record.width), height: Number(record.height) };
}

function clampFinite(value: number, minimum: number, maximum: number): number {
  const finite = Number.isFinite(value) ? value : minimum;
  return Math.round(Math.min(maximum, Math.max(minimum, finite)));
}
