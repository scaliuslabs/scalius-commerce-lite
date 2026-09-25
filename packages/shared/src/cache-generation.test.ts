import { describe, expect, it } from "vitest";
import { normalizeCacheGeneration, readWorkerVersion } from "./cache-generation";

describe("cache generation", () => {
  it("accepts only opaque lowercase tokens", () => {
    expect(normalizeCacheGeneration("a1b2c3d4e5f60718")).toBe("a1b2c3d4e5f60718");
    expect(normalizeCacheGeneration("A1")).toBeNull();
    expect(normalizeCacheGeneration("")).toBeNull();
    expect(normalizeCacheGeneration(42)).toBeNull();
  });
});

describe("worker version", () => {
  it("reads the version metadata id", () => {
    expect(readWorkerVersion({ CF_VERSION_METADATA: { id: "0c9e8f5e-2b1a-4c3d-9e8f-5e2b1a4c3d9e" } }))
      .toBe("0c9e8f5e-2b1a-4c3d-9e8f-5e2b1a4c3d9e");
  });

  it("is null without the binding or with an unusable id, so nothing is cached", () => {
    expect(readWorkerVersion(undefined)).toBeNull();
    expect(readWorkerVersion({})).toBeNull();
    expect(readWorkerVersion({ CF_VERSION_METADATA: null })).toBeNull();
    expect(readWorkerVersion({ CF_VERSION_METADATA: { id: "" } })).toBeNull();
    expect(readWorkerVersion({ CF_VERSION_METADATA: { id: "a/b?c" } })).toBeNull();
    expect(readWorkerVersion({ CF_VERSION_METADATA: { id: 7 } })).toBeNull();
  });
});
