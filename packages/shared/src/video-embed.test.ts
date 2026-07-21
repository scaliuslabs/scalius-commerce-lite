import { describe, expect, it } from "vitest";
import { normalizeVideoEmbedUrl } from "./video-embed";

describe("normalizeVideoEmbedUrl", () => {
  it.each([
    [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ],
    [
      "https://youtu.be/dQw4w9WgXcQ?t=30",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ],
    [
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    ],
    [
      "https://vimeo.com/76979871",
      "https://player.vimeo.com/video/76979871",
    ],
    [
      "https://player.vimeo.com/video/76979871?h=abc123",
      "https://player.vimeo.com/video/76979871?h=abc123",
    ],
    [
      "https://vimeo.com/76979871/8f6f4a7b9c",
      "https://player.vimeo.com/video/76979871?h=8f6f4a7b9c",
    ],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeVideoEmbedUrl(input)).toBe(expected);
  });

  it.each([
    "",
    "javascript:alert(1)",
    "https://example.com/video/123",
    "https://youtube.com/watch?v=not valid",
    "https://vimeo.com/channels/staffpicks",
    "https://player.vimeo.com/video/not-a-number",
  ])("rejects unsupported input %s", (input) => {
    expect(normalizeVideoEmbedUrl(input)).toBeNull();
  });
});
