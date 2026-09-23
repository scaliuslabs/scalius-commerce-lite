import { translate } from "~/i18n";
import { fieldErrorMessages } from "~/i18n/save-bar";
import { AdminApiResponseError } from "./admin-api-error";

/** One rejected field from an API validation error, with merchant-readable text. */
export interface ApiFieldIssue {
  /** Dotted body path, e.g. `email` or `sources.0`. */
  path: string;
  message: string;
}

interface ZodIssueLike {
  path?: unknown;
  code?: unknown;
  message?: unknown;
  origin?: unknown;
  format?: unknown;
  minimum?: unknown;
  maximum?: unknown;
}

// zod's built-in messages ("Invalid input: expected number…", "Too small: …")
// are developer text; API-authored messages ("Name is required") are kept.
const ZOD_DEFAULT = /^(Invalid|Too (small|big)|Expected|Unrecognized|Required$)/;

function friendly(issue: ZodIssueLike): string {
  const own = typeof issue.message === "string" ? issue.message.trim() : "";
  if (own && !ZOD_DEFAULT.test(own)) return own;
  const t = (key: keyof typeof fieldErrorMessages.en, vars?: Record<string, string | number>) =>
    translate(fieldErrorMessages, key, vars);
  const min = typeof issue.minimum === "number" ? issue.minimum : null;
  const max = typeof issue.maximum === "number" ? issue.maximum : null;
  switch (issue.code) {
    case "too_small":
      if (issue.origin === "string") return min !== null && min > 1 ? t("minLength", { count: min }) : t("required");
      if (issue.origin === "array" || issue.origin === "set") return t("pickOne");
      return min !== null ? t("atLeast", { min }) : t("invalid");
    case "too_big":
      if (issue.origin === "string") return max !== null ? t("maxLength", { count: max }) : t("tooLong");
      if (issue.origin === "array" || issue.origin === "set") return t("tooMany");
      return max !== null ? t("atMost", { max }) : t("invalid");
    case "invalid_format":
      if (issue.format === "email") return t("email");
      if (issue.format === "url") return t("url");
      return t("invalid");
    case "invalid_type":
      return issue.message === "Required" || /received undefined/.test(own) ? t("required") : t("invalid");
    default:
      return t("invalid");
  }
}

function toPath(path: unknown): string | null {
  if (!Array.isArray(path)) return null;
  return path.map(String).join(".");
}

function fromIssues(value: unknown): ApiFieldIssue[] | null {
  if (!Array.isArray(value)) return null;
  const issues = value.flatMap((item: ZodIssueLike) => {
    const path = item && typeof item === "object" ? toPath(item.path) : null;
    return path === null ? [] : [{ path, message: friendly(item) }];
  });
  return issues.length ? issues : null;
}

/**
 * Field-level problems in an API rejection, or null when the error isn't about
 * specific fields. Understands the two shapes our API returns for a 400:
 * - request validation: `{ error: { name: "ZodError", message: "<JSON issue list>" } }`
 * - service validation: `ValidationError(message, { field })` → `details.field`
 */
export function readApiFieldIssues(error: unknown): ApiFieldIssue[] | null {
  if (!(error instanceof AdminApiResponseError) || (error.status !== 400 && error.status !== 422)) return null;
  const message = error.message.trim();
  if (message.startsWith("[")) {
    try {
      const parsed = fromIssues(JSON.parse(message));
      if (parsed) return parsed;
    } catch {
      // Not an issue list; fall through.
    }
  }
  const details = error.details as { field?: unknown; issues?: unknown } | undefined;
  if (details && typeof details === "object") {
    const listed = fromIssues(details.issues);
    if (listed) return listed;
    if (typeof details.field === "string" && details.field) {
      return [{ path: details.field, message }];
    }
  }
  return null;
}
