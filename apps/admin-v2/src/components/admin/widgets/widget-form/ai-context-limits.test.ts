import { describe, expect, it } from "vitest";
import {
  AI_CONTEXT_LIMITS,
  getEffectiveImageLimit,
  limitImagesForModel,
} from "./ai-context-limits";

describe("widget AI context limits", () => {
  it("caps provider image limits at the dashboard context limit", () => {
    expect(getEffectiveImageLimit("anthropic/claude-3-5-sonnet")).toBe(
      AI_CONTEXT_LIMITS.maxImages,
    );
  });

  it("limits selected images for the active model before prompt assembly", () => {
    const images = Array.from(
      { length: AI_CONTEXT_LIMITS.maxImages + 2 },
      (_, index) => ({ id: String(index), url: `https://cdn.example.com/${index}.jpg` }),
    );

    const result = limitImagesForModel(images, "openai/gpt-4o");

    expect(result.limit).toBe(AI_CONTEXT_LIMITS.maxImages);
    expect(result.images).toEqual(images.slice(0, AI_CONTEXT_LIMITS.maxImages));
    expect(result.truncated).toBe(2);
  });
});
