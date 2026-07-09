import { describe, expect, it, vi } from "vitest";

import {
  ADMIN_ASSISTANT_BUBBLE_SIZE,
  ADMIN_ASSISTANT_LAYOUT_STORAGE_KEY,
  ADMIN_ASSISTANT_DOCK_NAV_RESERVE,
  ADMIN_ASSISTANT_MIN_MAIN_CONTENT_WIDTH,
  clampAdminAssistantLayout,
  clampAdminAssistantSize,
  createDefaultAdminAssistantLayout,
  panelPositionFromBubble,
  readAdminAssistantLayoutPreferences,
  writeAdminAssistantLayoutPreferences,
  type AdminAssistantViewport,
} from "./assistant-layout";

describe("admin assistant layout preferences", () => {
  const viewport: AdminAssistantViewport = { width: 1_280, height: 800 };

  it("keeps default panel and bubble geometry inside the viewport", () => {
    const layout = createDefaultAdminAssistantLayout(viewport);

    expect(layout.mode).toBe("floating");
    expect(layout.bubblePosition.x + ADMIN_ASSISTANT_BUBBLE_SIZE).toBeLessThan(
      viewport.width,
    );
    expect(layout.bubblePosition.y + ADMIN_ASSISTANT_BUBBLE_SIZE).toBeLessThan(
      viewport.height,
    );
    expect(layout.panelPosition.x).toBeGreaterThanOrEqual(16);
    expect(layout.panelPosition.y).toBeGreaterThanOrEqual(16);
    expect(layout.panelPosition.x + layout.panelSize.width).toBeLessThanOrEqual(
      viewport.width - 16,
    );
    expect(layout.panelPosition.y + layout.panelSize.height).toBeLessThanOrEqual(
      viewport.height - 16,
    );
  });

  it("clamps stale saved geometry after a viewport shrinks", () => {
    const layout = clampAdminAssistantLayout(
      {
        mode: "dock-left",
        bubblePosition: { x: 10_000, y: -400 },
        panelPosition: { x: 9_000, y: 9_000 },
        panelSize: { width: 4_000, height: 4_000 },
      },
      { width: 375, height: 600 },
    );

    expect(layout.mode).toBe("dock-left");
    expect(layout.panelSize.width).toBe(359);
    expect(layout.panelSize.height).toBe(584);
    expect(layout.panelPosition).toEqual({ x: 8, y: 8 });
    expect(layout.bubblePosition).toEqual({ x: 311, y: 8 });
  });

  it("recovers from malformed storage and persists geometry only", () => {
    const getItem = vi.fn(() => "not-json");
    const fallback = readAdminAssistantLayoutPreferences({ getItem }, viewport);
    expect(fallback).toEqual(createDefaultAdminAssistantLayout(viewport));

    const setItem = vi.fn();
    writeAdminAssistantLayoutPreferences({ setItem }, {
      ...fallback,
      mode: "dock-right",
    });

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem.mock.calls[0]?.[0]).toBe(ADMIN_ASSISTANT_LAYOUT_STORAGE_KEY);
    const saved = JSON.parse(String(setItem.mock.calls[0]?.[1]));
    expect(saved).toEqual({
      mode: "dock-right",
      bubblePosition: fallback.bubblePosition,
      panelPosition: fallback.panelPosition,
      panelSize: fallback.panelSize,
    });
    expect(JSON.stringify(saved)).not.toMatch(/message|history|context|token/i);
  });

  it("opens a floating panel from the bubble while respecting viewport bounds", () => {
    const position = panelPositionFromBubble(
      { x: 1_100, y: 700 },
      { width: 420, height: 620 },
      viewport,
    );
    expect(position).toEqual({ x: 736, y: 136 });
  });

  it("reserves usable navigation and main-content width for desktop docks", () => {
    const compactDesktop = { width: 1_024, height: 768 };
    const docked = clampAdminAssistantSize(
      { width: 720, height: 620 },
      compactDesktop,
      "dock-right",
    );
    const floating = clampAdminAssistantSize(
      { width: 720, height: 620 },
      compactDesktop,
      "floating",
    );

    expect(docked.width).toBe(320);
    expect(
      ADMIN_ASSISTANT_DOCK_NAV_RESERVE +
        docked.width +
        ADMIN_ASSISTANT_MIN_MAIN_CONTENT_WIDTH,
    ).toBeLessThanOrEqual(compactDesktop.width);
    expect(floating.width).toBe(720);

    expect(
      clampAdminAssistantSize(
        { width: 720, height: 620 },
        viewport,
        "dock-left",
      ).width,
    ).toBe(560);
  });
});
