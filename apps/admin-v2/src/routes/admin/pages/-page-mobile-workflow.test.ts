import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  resolve(import.meta.dirname, "index.tsx"),
  "utf8",
);
const dialogSource = readFileSync(
  resolve(import.meta.dirname, "-PageDeleteDialog.tsx"),
  "utf8",
);
const formSource = readFileSync(
  resolve(import.meta.dirname, "../../../components/admin/PageForm.tsx"),
  "utf8",
);

describe("page mobile workflow boundaries", () => {
  it("uses touch-sized list, filter, bulk, and destructive controls", () => {
    expect(routeSource).toContain('className="h-11 sm:h-9"');
    expect(routeSource).toContain('className="h-11 w-[150px] sm:h-9"');
    expect(dialogSource).toContain('className="h-11 text-xs sm:h-8"');
    expect(dialogSource).toContain('"h-11 text-xs sm:h-8"');
  });

  it("keeps destructive copy direct and in sentence case", () => {
    expect(dialogSource).toContain(
      "{multiple ? entityPlural : entityName} permanently?",
    );
    expect(dialogSource).toContain(
      "{multiple ? entityPlural : entityName} to trash?",
    );
    expect(routeSource).toContain('"View trash"');
    expect(routeSource).toContain("New page");
    expect(routeSource).not.toContain("Manage your website pages and content.");
    expect(routeSource).toContain('searchPlaceholder="Search pages…"');
  });

  it("keeps the shared page and article editor labels compact and consistent", () => {
    expect(formSource).toContain('newLabel={contentType === "article" ? "New article" : "New page"}');
    expect(formSource).toContain('title="Search listing"');
    expect(formSource).toContain("Defaults to the content title.");
    expect(formSource).not.toContain("Search Engine Listing");
    expect(formSource).not.toContain("Recommended: 150-160 characters");
  });

  it("shows a live link only for the committed page route", () => {
    expect(formSource).toContain("const committedSlug = defaultValues?.slug");
    expect(formSource).toContain("const isCommittedLivePage =");
    expect(formSource).toContain(
      'defaultValues?.publicationMode === "published"',
    );
    expect(formSource).toContain("{isCommittedLivePage ? (");
    expect(formSource).toMatch(
      /ariaLabel=\{\s*contentType === "article"\s*\? "Article content"\s*: "Page content"\s*\}/,
    );
    expect(formSource).not.toContain(
      'isEdit && slug && publicationMode === "published"',
    );
  });
});
