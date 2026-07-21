import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  resolve(import.meta.dirname, "index.tsx"),
  "utf8",
);
const formSource = readFileSync(
  resolve(import.meta.dirname, "../../../components/admin/PageForm.tsx"),
  "utf8",
);

describe("article merchant workflow boundaries", () => {
  it("keeps article lists filtered at the server boundary", () => {
    expect(routeSource).toContain('contentType: "article"');
    expect(routeSource).toContain('itemLabel="articles"');
    expect(routeSource).toContain('to="/admin/articles/$articleId/edit"');
  });

  it("uses a dedicated public path and article metadata without a second editor", () => {
    expect(formSource).toContain('contentType?: "page" | "article"');
    expect(formSource).toContain('contentType === "article" ? "/blog/" : "/"');
    expect(formSource).toContain('name="excerpt"');
    expect(formSource).toContain('name="author"');
    expect(formSource).toContain('name="tags"');
    expect(formSource).toContain("<DeferredTiptapEditor");
  });
});
