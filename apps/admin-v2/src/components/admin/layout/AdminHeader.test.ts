import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./AdminHeader.tsx", import.meta.url)),
  "utf8",
);

describe("AdminHeader responsive boundaries", () => {
  it("gives the breadcrumb side bounded flexible space", () => {
    expect(source).toContain(
      'className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden sm:gap-2"',
    );
    expect(source).toContain(
      'className="h-11 w-11 shrink-0 text-muted-foreground hover:text-foreground sm:h-9 sm:w-9"',
    );
    expect(source).toContain('className="h-4 shrink-0 sm:mr-1"');
  });

  it("keeps the action cluster from shrinking into the breadcrumb", () => {
    expect(source).toContain('className="flex shrink-0 items-center"');
    expect(source).toContain(
      'className="relative inline-flex h-11 items-center gap-3 rounded-lg px-2 sm:h-10"',
    );
  });
});
