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
      'className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden"',
    );
    expect(source).toContain(
      'className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"',
    );
    expect(source).toContain('className="mr-1 h-4 shrink-0"');
  });

  it("keeps the action cluster from shrinking into the breadcrumb", () => {
    expect(source).toContain('className="flex shrink-0 items-center"');
  });
});
