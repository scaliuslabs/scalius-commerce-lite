import type { MiddlewareHandler } from "hono";

// A route's request schema refusal, as @hono/zod-openapi answers it without a
// hook, is `{ success: false, error: { name: "ZodError", message: "<the
// issue list as a JSON string>" } }`: no `code`, and a message nobody can
// read. Every API response passes here once, so each such refusal becomes the
// API's ErrorResponse: code `validation_error`, a message naming the field
// and what it expects, and the issues (zod's own, paths as arrays) in
// details.issues, where the dashboard's field errors and the agent tools'
// `field` already read them.

const MAX_ISSUES = 20;

interface Issue {
  path?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issuePath(issue: Issue): string {
  return Array.isArray(issue.path) ? issue.path.map(String).join(".") : "";
}

/** "media.0.id: Expected ... (and 2 more problems)": the first issue, with its field. */
export function validationMessage(issues: readonly Issue[]): string {
  const first = issues[0];
  if (!first) return "The request is not valid.";
  const path = issuePath(first);
  const text = typeof first.message === "string" && first.message.trim() ? first.message.trim() : "Invalid value.";
  const more = issues.length - 1;
  return `${path ? `${path}: ` : ""}${text}${more > 0 ? ` (and ${more} more problem${more === 1 ? "" : "s"}; see details.issues)` : ""}`;
}

/** The ErrorResponse body for a raw zod refusal body, or null when the body is something else. */
export function normalizeZodRefusal(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || body.success !== false || !isRecord(body.error)) return null;
  const error = body.error;
  if (error.name !== "ZodError" || typeof error.code === "string" || typeof error.message !== "string") return null;
  let issues: Issue[] = [];
  try {
    const parsed = JSON.parse(error.message) as unknown;
    if (Array.isArray(parsed)) issues = parsed.filter(isRecord);
  } catch {
    // Not an issue list: keep the message as the one problem.
    issues = [{ message: error.message }];
  }
  return {
    success: false,
    error: {
      code: "validation_error",
      message: validationMessage(issues),
      details: { issues: issues.slice(0, MAX_ISSUES) },
    },
  };
}

/** Rewrites a route's raw zod refusal (400) into the ErrorResponse; every other response passes untouched. */
export const requestValidationErrorMiddleware: MiddlewareHandler = async (c, next) => {
  await next();
  const response = c.res;
  if (response.status !== 400 || !(response.headers.get("content-type") ?? "").includes("application/json")) return;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return;
  }
  const normalized = normalizeZodRefusal(body);
  if (!normalized) return;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  c.res = undefined;
  c.res = new Response(JSON.stringify(normalized), { status: 400, headers });
};
