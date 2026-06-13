import { describe, expect, it } from "vitest";
import {
  isRecoverableRouteLoadError,
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
});
