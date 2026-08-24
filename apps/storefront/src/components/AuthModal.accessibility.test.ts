import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const storefrontRoot = process.cwd().endsWith("/apps/storefront")
  ? process.cwd()
  : resolve(process.cwd(), "apps/storefront");

const source = readFileSync(
  resolve(storefrontRoot, "src/components/AuthModal.tsx"),
  "utf8",
);

describe("AuthModal accessibility contract", () => {
  it("supports Escape, traps focus, and restores the opening control", () => {
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain('if (event.key === "Escape")');
    expect(source).toContain('if (event.key !== "Tab" || !dialog) return;');
    expect(source).toContain("previouslyFocusedElementRef");
    expect(source).toContain("if (previouslyFocused?.isConnected) previouslyFocused.focus()");
  });
});
