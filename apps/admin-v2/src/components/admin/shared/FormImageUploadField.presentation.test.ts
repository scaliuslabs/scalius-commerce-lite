import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./FormImageUploadField.tsx", import.meta.url),
  "utf8",
);

describe("FormImageUploadField presentation boundary", () => {
  it("preserves the complete selected asset in the shared preview", () => {
    expect(source).toContain('fit: "scale-down"');
    expect(source).toContain("object-contain");
    expect(source).not.toContain("object-cover");
  });

  it("keeps the preview transform bounded and the remove action named", () => {
    expect(source).toContain("width: 640");
    expect(source).toContain("height: 480");
    expect(source).toContain("aria-label={`Remove ${value.filename}`}");
    expect(source).toContain("h-11 w-11 sm:h-8 sm:w-8");
    expect(source).toContain('triggerLabel = "Choose image"');
    expect(source).toContain('changeTriggerLabel = "Change image"');
  });

  it("keeps the empty state compact instead of reserving a full preview ratio", () => {
    expect(source).toContain("min-h-28");
    expect(source).not.toContain("aspectRatio,\n            maxWidth");
  });
});
