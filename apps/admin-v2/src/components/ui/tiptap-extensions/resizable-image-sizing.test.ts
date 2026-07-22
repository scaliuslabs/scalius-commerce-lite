import { describe, expect, it } from "vitest";
import {
  clampRichTextImageWidth,
  normalizeRichTextImageWidthPercent,
  richTextImageWidthPercent,
} from "./resizable-image-sizing";

describe("rich-text image sizing", () => {
  it("uses the same minimum for drag preview and persisted width", () => {
    const editorWidth = 896;
    const previewWidth = clampRichTextImageWidth(80, editorWidth);

    expect(previewWidth).toBeCloseTo(179.2);
    expect(richTextImageWidthPercent(previewWidth, editorWidth)).toBe(20);
  });

  it("retains a usable pixel floor on a narrow editor", () => {
    const editorWidth = 318;
    const previewWidth = clampRichTextImageWidth(20, editorWidth);

    expect(previewWidth).toBe(80);
    expect(richTextImageWidthPercent(previewWidth, editorWidth)).toBe(25);
  });

  it("never grows beyond the editor content width", () => {
    expect(clampRichTextImageWidth(1200, 640)).toBe(640);
    expect(richTextImageWidthPercent(640, 640)).toBe(100);
  });

  it("normalizes custom percentage input to the supported range", () => {
    expect(normalizeRichTextImageWidthPercent("55.6")).toBe(56);
    expect(normalizeRichTextImageWidthPercent("4")).toBe(20);
    expect(normalizeRichTextImageWidthPercent("140")).toBe(100);
    expect(normalizeRichTextImageWidthPercent("")).toBeNull();
    expect(normalizeRichTextImageWidthPercent("not a number")).toBeNull();
  });
});
