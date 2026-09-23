import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FORM_SCHEMAS_SOURCE = fileURLToPath(
  new URL("./form-schemas.ts", import.meta.url),
);

describe("resource form canonical validation", () => {
  it("uses resource-aware canonical route validators for category and page forms", () => {
    const formSchemasSource = readFileSync(FORM_SCHEMAS_SOURCE, "utf8");

    expect(formSchemasSource).toContain("isValidResourceCanonicalPath");
    expect(formSchemasSource).toMatch(
      /canonicalPathFormSchema\(\s*"category"\s*,\s*"\/categories\/summer-shoes"\s*,?\s*\)/,
    );
    expect(formSchemasSource).toContain('"/categories/summer-shoes"');
    expect(formSchemasSource).toContain(
      'const resourceKind = value.contentType === "article" ? "article" : "page"',
    );
    expect(formSchemasSource).toContain("`/blog/${value.slug}`");
    expect(formSchemasSource).toContain(
      "isValidResourceCanonicalPath(resourceKind, value.canonicalPath)",
    );
  });
});

describe("customer form phone validation", () => {
  it("shares the strict phone parser used by the customer API", () => {
    const formSchemasSource = readFileSync(FORM_SCHEMAS_SOURCE, "utf8");

    expect(formSchemasSource).toContain(
      'import { phoneNumberSchema } from "@scalius/shared/customer-utils";',
    );
    expect(formSchemasSource).toContain("phone: phoneNumberSchema,");
    expect(formSchemasSource).not.toMatch(
      /phone:\s*z\s*\.string\(\)\s*\.min\(7/,
    );
  });
});
