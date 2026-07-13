import { describe, expect, it } from "vitest";
import { formatDuration, formatFileType } from "./formatters";

describe("media presentation formatters", () => {
  it("uses merchant-readable labels for every supported media type", () => {
    expect(formatFileType("image/avif")).toBe("AVIF Image");
    expect(formatFileType("video/mp4")).toBe("MP4 Video");
    expect(formatFileType("video/webm")).toBe("WebM Video");
  });

  it("formats finite positive durations without inventing missing metadata", () => {
    expect(formatDuration(1_000)).toBe("0:01");
    expect(formatDuration(65_400)).toBe("1:05");
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(Number.NaN)).toBeNull();
  });
});
