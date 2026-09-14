import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const directory = dirname(fileURLToPath(import.meta.url));
const builderSource = readFileSync(
  resolve(directory, "SeoSettingsBuilder.tsx"),
  "utf8",
);
const outcomeSource = readFileSync(
  resolve(directory, "SeoDiscoveryStatusCard.tsx"),
  "utf8",
);

describe("SEO outcome-first workspace", () => {
  it("keeps the public outcome visible on desktop without preceding mobile controls", () => {
    expect(builderSource).toContain('className="order-last min-w-0 xl:sticky xl:top-4"');
    expect(builderSource).toContain("xl:sticky xl:top-4");
    expect(outcomeSource).toContain("Public discovery outcome");
    expect(outcomeSource).toContain(
      "Preview current edits and inspect published discovery files.",
    );
    expect(outcomeSource).toContain('className="group border-t border-border first:border-t-0"');
  });

  it("keeps exact discovery authorities and consequences in the same workspace", () => {
    for (const authority of [
      "Product catalog feed",
      "UCP catalog discovery",
      "Structured data",
      "Return policy schema",
      "Advanced robots.txt rules",
    ]) {
      expect(builderSource).toContain(authority);
    }
    expect(builderSource).toContain("Save discovery settings");
    // The page draft saves through exactly one contextual save bar.
    expect(builderSource).toContain("<ContextualSaveBar");
    expect(builderSource).toContain("isDirty={isDirty || isSaving}");
    expect(builderSource).toContain("allowSamePathNavigation");
    expect(builderSource.match(/<ContextualSaveBar/g)).toHaveLength(1);
    expect(builderSource).not.toContain("<UnsavedChangesGuard");
  });

  it("builds the workspace from the shared shell furniture", () => {
    expect(builderSource).toContain('from "~/components/admin/shell"');
    expect(builderSource).toContain("<SettingsSection");
    expect(builderSource).toContain("<SkeletonPage");
    expect(builderSource).toContain("<InlineHelp");
    expect(builderSource).toContain("<FieldError");
    expect(outcomeSource).toContain("<StatusBadge");
    expect(outcomeSource).toContain("<EmptyState");
    // Content loads into skeletons, and no per-section Save/Reset row remains.
    expect(builderSource).not.toContain("animate-spin");
    expect(builderSource).not.toContain("Reset");
  });

  it("keeps the nested return-policy editor shrink-safe beside the outcome rail", () => {
    expect(builderSource).toContain(
      'xl:grid-cols-[minmax(0,1fr)_20rem]',
    );
    expect(builderSource).toContain(
      'className="mt-4 grid min-w-0 gap-3 md:grid-cols-2"',
    );
    expect(builderSource).not.toContain(
      'md:grid-cols-2 xl:grid-cols-4',
    );
    expect(builderSource).toContain(
      'className="grid min-w-0 gap-2 md:col-span-2"',
    );
    expect(
      builderSource.match(
        /SelectTrigger[^>]+className="min-h-11 min-w-0 sm:min-h-9"/g,
      ),
    ).toHaveLength(3);
  });
});
