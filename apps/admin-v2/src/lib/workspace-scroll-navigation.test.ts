import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workspaceRoutes = [
  ["routes/admin/settings/index.tsx", 2],
  ["routes/admin/settings/notifications.tsx", 1],
  ["routes/admin/settings/hero-sliders.tsx", 1],
  ["routes/admin/settings/theme.tsx", 2],
  ["routes/admin/settings/checkout.tsx", 1],
  ["routes/admin/settings/meta-conversion.tsx", 1],
  ["routes/admin/settings/account.tsx", 1],
  ["routes/admin/settings/taxes.tsx", 2],
  ["routes/admin/inventory/index.tsx", 1],
  ["routes/admin/navigation/index.tsx", 1],
  ["routes/admin/media.tsx", 1],
] as const;

describe("in-place admin workspace navigation", () => {
  it.each(workspaceRoutes)(
    "%s retains the current workspace scroll position",
    (path, minimumOccurrences) => {
      const source = readFileSync(
        fileURLToPath(new URL(`../${path}`, import.meta.url)),
        "utf8",
      );
      const occurrences = source.match(/resetScroll:\s*false/g)?.length ?? 0;

      expect(occurrences).toBeGreaterThanOrEqual(minimumOccurrences);
    },
  );
});
