import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const INTEGRATIONS_EMAIL_DIR = fileURLToPath(new URL(".", import.meta.url));

describe("email fallback logging boundaries", () => {
  it("does not log raw email bodies when providers are unavailable", () => {
    const activeSource = readFileSync(`${INTEGRATIONS_EMAIL_DIR}/index.ts`, "utf8");

    expect(activeSource).not.toContain("console.log(html");
    expect(activeSource).not.toContain("console.log(options.html");
    expect(activeSource).not.toContain("console.log(text");
    expect(activeSource).not.toContain("logged locally only");
    expect(activeSource).not.toContain("logging only");
    expect(activeSource).toContain("contentLogged: false");
  });
});
