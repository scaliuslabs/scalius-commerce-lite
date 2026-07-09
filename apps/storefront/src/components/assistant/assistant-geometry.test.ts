import { describe, expect, it } from "vitest";

import {
  ASSISTANT_DOCK_MIN_MAIN_WIDTH,
  ASSISTANT_GEOMETRY_STORAGE_KEY,
  calculateAssistantPanelRect,
  clampAssistantGeometry,
  defaultAssistantGeometry,
  normalizeAssistantGeometry,
  readAssistantGeometry,
  writeAssistantGeometry,
} from "./assistant-geometry";

type MemoryStorage = {
  value: string | null;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

function memoryStorage(initial: string | null = null): MemoryStorage {
  return {
    value: initial,
    getItem(key) {
      return key === ASSISTANT_GEOMETRY_STORAGE_KEY ? this.value : null;
    },
    setItem(key, value) {
      if (key === ASSISTANT_GEOMETRY_STORAGE_KEY) this.value = value;
    },
    removeItem(key) {
      if (key === ASSISTANT_GEOMETRY_STORAGE_KEY) this.value = null;
    },
  };
}

describe("storefront assistant geometry", () => {
  it("clamps panels and launchers inside small and large viewports", () => {
    const small = clampAssistantGeometry(
      {
        mode: "floating",
        panelWidth: 9_999,
        panelHeight: 9_999,
        launcherX: -400,
        launcherY: 80_000,
      },
      { width: 320, height: 568 },
    );

    expect(small).toEqual({
      mode: "floating",
      panelWidth: 288,
      panelHeight: 536,
      launcherX: 16,
      launcherY: 496,
    });

    const large = defaultAssistantGeometry({ width: 1_440, height: 900 });
    expect(large.panelWidth).toBe(424);
    expect(large.panelHeight).toBe(640);
    expect(large.launcherX).toBe(1_368);
    expect(large.launcherY).toBe(828);
  });

  it("persists only the five non-sensitive layout fields", () => {
    const storage = memoryStorage();
    const geometry = {
      mode: "dock-left" as const,
      panelWidth: 480,
      panelHeight: 620,
      launcherX: 32,
      launcherY: 400,
    };

    expect(writeAssistantGeometry(storage, geometry)).toBe(true);
    expect(JSON.parse(storage.value ?? "{}")).toEqual(geometry);
    expect(storage.value).not.toMatch(/message|context|cart|customer|token/i);
    expect(
      readAssistantGeometry(storage, { width: 1_200, height: 800 }),
    ).toEqual(geometry);
  });

  it("rejects malformed persisted data and calculates each panel mode", () => {
    expect(
      normalizeAssistantGeometry(
        {
          mode: "teleport",
          panelWidth: "480",
          panelHeight: 600,
          launcherX: 20,
          launcherY: 20,
        },
        { width: 1_200, height: 800 },
      ),
    ).toBeNull();

    const base = {
      mode: "floating" as const,
      panelWidth: 400,
      panelHeight: 500,
      launcherX: 1_000,
      launcherY: 700,
    };
    expect(
      calculateAssistantPanelRect(base, { width: 1_200, height: 800 }),
    ).toEqual({
      left: 656,
      top: 188,
      width: 400,
      height: 500,
    });
    expect(
      calculateAssistantPanelRect(
        { ...base, mode: "dock-right" },
        { width: 1_200, height: 800 },
      ),
    ).toEqual({ left: 784, top: 16, width: 400, height: 768 });
  });

  it("keeps a usable storefront column beside a docked panel", () => {
    const viewport = { width: 768, height: 900 };
    const docked = clampAssistantGeometry(
      {
        mode: "dock-right",
        panelWidth: 720,
        panelHeight: 640,
        launcherX: 680,
        launcherY: 800,
      },
      viewport,
    );

    expect(docked.panelWidth).toBe(
      viewport.width - ASSISTANT_DOCK_MIN_MAIN_WIDTH,
    );
    expect(viewport.width - docked.panelWidth).toBeGreaterThanOrEqual(
      ASSISTANT_DOCK_MIN_MAIN_WIDTH,
    );

    const floating = clampAssistantGeometry(
      { ...docked, mode: "floating", panelWidth: 720 },
      viewport,
    );
    expect(floating.panelWidth).toBe(720);
  });
});
