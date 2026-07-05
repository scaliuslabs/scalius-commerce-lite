import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const ADMIN_SRC_ROOT = join(REPO_ROOT, "apps", "admin-v2", "src");
const STOREFRONT_SRC_ROOT = join(REPO_ROOT, "apps", "storefront", "src");

const ADMIN_AUTH_FORMS = [
  {
    path: join(ADMIN_SRC_ROOT, "components", "auth", "LoginForm.tsx"),
    action: "/auth/login",
  },
  {
    path: join(ADMIN_SRC_ROOT, "routes", "auth", "forgot-password.tsx"),
    action: "/auth/forgot-password",
  },
  {
    path: join(ADMIN_SRC_ROOT, "components", "auth", "ResetPasswordForm.tsx"),
    action: "/auth/reset-password",
  },
  {
    path: join(ADMIN_SRC_ROOT, "components", "auth", "SetupForm.tsx"),
    action: "/auth/setup",
  },
  {
    path: join(ADMIN_SRC_ROOT, "components", "auth", "TwoFactorForm.tsx"),
    action: "/auth/two-factor",
  },
  {
    path: join(ADMIN_SRC_ROOT, "components", "auth", "TwoFactorSetup.tsx"),
    action: "/auth/setup-2fa",
  },
] as const;

const SENSITIVE_FIELD_NAMES = new Set([
  "code",
  "confirm-password",
  "confirmPassword",
  "currentPassword",
  "email",
  "newPassword",
  "otp",
  "password",
  "phone",
  "token",
  "verificationCode",
]);

function stripSourceComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

function extractOpeningTags(source: string, tagName: string): string[] {
  const text = stripSourceComments(source);
  const tags: string[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf(`<${tagName}`, searchFrom);
    if (start < 0) break;

    const nextChar = text[start + tagName.length + 1];
    if (nextChar && !/[\s>/]/.test(nextChar)) {
      searchFrom = start + tagName.length + 1;
      continue;
    }

    let braceDepth = 0;
    let quote: '"' | "'" | "`" | null = null;
    let escaped = false;

    for (let i = start + tagName.length + 1; i < text.length; i += 1) {
      const char = text[i];

      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }

      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") {
        braceDepth += 1;
        continue;
      }
      if (char === "}" && braceDepth > 0) {
        braceDepth -= 1;
        continue;
      }
      if (char === ">" && braceDepth === 0) {
        tags.push(text.slice(start, i + 1));
        searchFrom = i + 1;
        break;
      }
      if (i === text.length - 1) searchFrom = text.length;
    }
  }

  return tags;
}

function getStringAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`));
  return match?.[1] ?? null;
}

function collectSensitiveNativeFieldNames(source: string): string[] {
  const controlTags = [
    ...extractOpeningTags(source, "input"),
    ...extractOpeningTags(source, "Input"),
  ];

  return controlTags
    .map((tag) => getStringAttribute(tag, "name"))
    .filter((name): name is string => Boolean(name))
    .filter((name) => SENSITIVE_FIELD_NAMES.has(name));
}

function buildAccidentalGetUrl(action: string, fieldNames: string[]): URL {
  const url = new URL(action, "https://dashboard.scalius.test");
  for (const name of fieldNames) {
    url.searchParams.set(name, "SHOULD_NOT_APPEAR_IN_URL");
  }
  return url;
}

describe("auth form URL safety", () => {
  it("keeps admin auth forms POST-only and without sensitive native field names", () => {
    const failures: string[] = [];

    for (const { path, action } of ADMIN_AUTH_FORMS) {
      const source = readFileSync(path, "utf8");
      const formTags = extractOpeningTags(source, "form");
      const sensitiveFieldNames = collectSensitiveNativeFieldNames(source);
      const accidentalGetUrl = buildAccidentalGetUrl(action, sensitiveFieldNames);

      if (formTags.length === 0) {
        failures.push(`${relative(REPO_ROOT, path)} has no form tag`);
      }
      for (const formTag of formTags) {
        if (getStringAttribute(formTag, "method")?.toLowerCase() !== "post") {
          failures.push(`${relative(REPO_ROOT, path)} form is not method=post`);
        }
        if (getStringAttribute(formTag, "action") !== action) {
          failures.push(`${relative(REPO_ROOT, path)} form action is not ${action}`);
        }
        if (!/\bnoValidate\b/.test(formTag)) {
          failures.push(`${relative(REPO_ROOT, path)} form is missing noValidate`);
        }
      }
      if (sensitiveFieldNames.length > 0) {
        failures.push(
          `${relative(REPO_ROOT, path)} would serialize sensitive fields into ${accidentalGetUrl.pathname}${accidentalGetUrl.search}`,
        );
      }
      if (!source.includes("preventDefault()")) {
        failures.push(`${relative(REPO_ROOT, path)} submit handler does not prevent default submit`);
      }
      if (!source.includes("useHydrated()") || !source.includes("!isHydrated ||")) {
        failures.push(`${relative(REPO_ROOT, path)} controls are not hydration-gated`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("keeps storefront customer auth fields outside native forms and query serialization", () => {
    const authModalSource = readFileSync(
      join(STOREFRONT_SRC_ROOT, "components", "AuthModal.tsx"),
      "utf8",
    );
    const sensitiveFieldNames = collectSensitiveNativeFieldNames(authModalSource);
    const accidentalGetUrl = buildAccidentalGetUrl("/account", sensitiveFieldNames);

    expect(extractOpeningTags(authModalSource, "form")).toEqual([]);
    expect(sensitiveFieldNames).toEqual([]);
    expect(accidentalGetUrl.search).toBe("");
  });
});
