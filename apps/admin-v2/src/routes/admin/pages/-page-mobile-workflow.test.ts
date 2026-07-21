import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(resolve(import.meta.dirname, "index.tsx"), "utf8");
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
    expect(dialogSource).toContain('Delete {multiple ? "pages" : "page"} permanently?');
    expect(dialogSource).toContain('Move {multiple ? "pages" : "page"} to trash?');
    expect(routeSource).toContain('"View trash"');
    expect(routeSource).toContain("New page");
  });

  it("shows a live link only for the committed page route", () => {
    expect(formSource).toContain("const committedSlug = defaultValues?.slug");
    expect(formSource).toContain("const isCommittedLivePage =");
    expect(formSource).toContain('defaultValues?.publicationMode === "published"');
    expect(formSource).toContain("{isCommittedLivePage ? (");
    expect(formSource).toContain('ariaLabel="Page content"');
    expect(formSource).not.toContain('isEdit && slug && publicationMode === "published"');
  });
});
