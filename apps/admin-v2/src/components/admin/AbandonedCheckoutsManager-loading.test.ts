import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./AbandonedCheckoutsManager.tsx", import.meta.url),
  "utf8",
);

describe("incomplete checkout initial loading", () => {
  it("uses mobile cards and desktop rows instead of centered spinners", () => {
    expect(source).toContain('aria-label="Loading incomplete checkouts"');
    expect(source).toContain("<Skeleton");
    expect(source).not.toContain('className="grid h-52 place-items-center"');
    expect(source).not.toContain('className="h-64 text-center"><Loader2');
  });
});
