import { describe, expect, it } from "vitest";
import { normalizeIntrinsicMediaMetadata } from "./intrinsic-metadata";

describe("intrinsic media metadata", () => {
  it("rounds valid image dimensions without inventing video duration", () => {
    expect(normalizeIntrinsicMediaMetadata("image", {
      width: 1200.4,
      height: 799.6,
      durationSeconds: 10,
    })).toEqual({ width: 1200, height: 800 });
  });

  it("converts finite video duration to integer milliseconds", () => {
    expect(normalizeIntrinsicMediaMetadata("video", {
      width: 1920,
      height: 1080,
      durationSeconds: 23.567,
    })).toEqual({ width: 1920, height: 1080, durationMs: 23_567 });
  });

  it("retains dimensions but omits unavailable duration", () => {
    expect(normalizeIntrinsicMediaMetadata("video", {
      width: 1280,
      height: 720,
      durationSeconds: Number.POSITIVE_INFINITY,
    })).toEqual({ width: 1280, height: 720 });
  });

  it("rejects missing and non-positive dimensions", () => {
    expect(normalizeIntrinsicMediaMetadata("image", {
      width: 0,
      height: 720,
    })).toBeNull();
    expect(normalizeIntrinsicMediaMetadata("video", {
      width: Number.NaN,
      height: 720,
      durationSeconds: 2,
    })).toBeNull();
  });
});
