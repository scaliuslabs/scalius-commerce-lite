import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readLayoutSource(filename: string) {
  return readFileSync(new URL(filename, import.meta.url), "utf8");
}

describe("persistent admin layout router subscriptions", () => {
  it.each(["./AppSidebar.tsx", "./AdminHeader.tsx"])(
    "subscribes %s to pathname only",
    (filename) => {
      const source = readLayoutSource(filename);

      expect(source).toContain("select: (location) => location.pathname");
      expect(source).not.toContain("useLocation()");
    },
  );
});
