import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const INTEGRATIONS_EMAIL_DIR = fileURLToPath(new URL(".", import.meta.url));
describe("email fallback logging boundaries", () => {
  it("does not log raw email bodies when providers are unavailable", () => {
    const source = readFileSync(`${INTEGRATIONS_EMAIL_DIR}/index.ts`, "utf8");

    expect(source).not.toContain("console.log(html");
    expect(source).not.toContain("console.log(options.html");
    expect(source).not.toContain("console.log(text");
    expect(source).not.toContain("logged locally only");
    expect(source).not.toContain("logging only");
    expect(source).toContain("contentLogged: false");
  });
});
