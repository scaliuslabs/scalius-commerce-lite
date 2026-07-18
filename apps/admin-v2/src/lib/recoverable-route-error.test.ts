import { describe, expect, it } from "vitest";
import {
  isRecoverableRouteLoadError,
  reloadRecoverableRouteOnce,
  recoverableRouteErrorSignature,
} from "./recoverable-route-error";

describe("recoverable route load errors", () => {
  it("detects stale deployment dynamic import failures", () => {
    expect(
      isRecoverableRouteLoadError(
        new TypeError(
          "Failed to fetch dynamically imported module: https://dashboard.scalius.com/assets/admin-old.js",
        ),
      ),
    ).toBe(true);
    expect(isRecoverableRouteLoadError(new Error("ChunkLoadError"))).toBe(true);
  });

  it("does not treat normal route errors as recoverable asset failures", () => {
    expect(isRecoverableRouteLoadError(new Error("Admin access required"))).toBe(
      false,
    );
  });

  it("keeps recovery signatures bounded", () => {
    expect(recoverableRouteErrorSignature(new Error("x".repeat(500))).length).toBe(
      240,
    );
  });

  it("reloads one time for each stale route asset signature", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    let reloads = 0;
    const input = {
      error: new TypeError(
        "Failed to fetch dynamically imported module: /assets/old-route.js",
      ),
      pathname: "/admin/discounts/disc_1/edit",
      storage,
      reload: () => {
        reloads += 1;
      },
    };

    expect(reloadRecoverableRouteOnce(input)).toBe(true);
    expect(reloadRecoverableRouteOnce(input)).toBe(false);
    expect(reloads).toBe(1);
  });
});
