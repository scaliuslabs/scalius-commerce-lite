import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const INTEGRATIONS_EMAIL_DIR = fileURLToPath(new URL(".", import.meta.url));
const CORE_SRC_DIR = fileURLToPath(new URL("../../", import.meta.url));

describe("email fallback logging boundaries", () => {
  it("does not log raw email bodies when providers are unavailable", () => {
    const activeSource = readFileSync(`${INTEGRATIONS_EMAIL_DIR}/index.ts`, "utf8");
    const universalResendSource = readFileSync(`${CORE_SRC_DIR}/providers/email/resend-adapter.ts`, "utf8");
    const combinedSource = `${activeSource}\n${universalResendSource}`;

    expect(combinedSource).not.toContain("console.log(html");
    expect(combinedSource).not.toContain("console.log(options.html");
    expect(combinedSource).not.toContain("console.log(text");
    expect(combinedSource).not.toContain("logged locally only");
    expect(combinedSource).not.toContain("logging only");
    expect(combinedSource).toContain("contentLogged: false");
  });
});
