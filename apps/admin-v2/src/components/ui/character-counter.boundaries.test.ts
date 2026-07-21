import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./character-counter.tsx", import.meta.url)),
  "utf8",
);

describe("character counter boundaries", () => {
  it("uses a quiet limit indicator without congratulatory guidance", () => {
    expect(source).toContain("{current} / {limit} {label}");
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("tabular-nums text-muted-foreground");
    expect(source).not.toContain("Good!");
    expect(source).not.toContain("(recommended:");
    expect(source).not.toContain("CheckCircle2");
  });
});
