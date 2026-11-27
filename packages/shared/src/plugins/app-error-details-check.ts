// A refusal's `error.details` checked against its code's sealed declaration
// (`APP_ERROR_CODES[code].details`) where the refusal is made. Kept apart
// from the projection so the error classes stay light.

import { APP_ERROR_CODES, isAppErrorCode, type AppErrorCodeEntry } from "./app-errors";

type Declared = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A dotted path (`items.0.sku`, an older producer's form) as keys and list indexes. */
function pathOf(path: unknown): unknown {
  if (typeof path !== "string") return path;
  return path === "" ? [] : path.split(".").map((segment) => (/^\d+$/u.test(segment) ? Number(segment) : segment));
}

/**
 * A refusal's details in the form apps receive: for `validation_error`, a
 * bare list of issues is `{ issues }` and a dotted path is keys and indexes.
 * Every other code's details are as sent.
 */
export function normalizedDetails(code: string, details: unknown): unknown {
  if (code !== "validation_error") return details;
  const raw = Array.isArray(details) ? { issues: details } : details;
  if (!isRecord(raw) || !Array.isArray(raw.issues)) return raw;
  return { ...raw, issues: raw.issues.map((issue) => (isRecord(issue) && "path" in issue ? { ...issue, path: pathOf(issue.path) } : issue)) };
}

/** Every way `value` breaks a declared details schema (the subset the table uses), as `<path>: <problem>`. */
function detailsIssues(schema: Declared, value: unknown, path: string, out: string[]): void {
  const at = path || "details";
  if (Array.isArray(schema.anyOf)) {
    const fits = (schema.anyOf as Declared[]).some((variant) => {
      const probe: string[] = [];
      detailsIssues(variant, value, path, probe);
      return probe.length === 0;
    });
    if (!fits) out.push(`${at}: matches none of its forms`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) out.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        out.push(`${at}: an object is declared`);
        return;
      }
      const record = value as Record<string, unknown>;
      for (const key of (schema.required ?? []) as string[]) if (record[key] === undefined) out.push(`${path ? `${path}.` : ""}${key}: required, missing`);
      for (const [key, child] of Object.entries((schema.properties ?? {}) as Record<string, Declared>)) {
        if (record[key] !== undefined) detailsIssues(child, record[key], path ? `${path}.${key}` : key, out);
      }
      return;
    }
    case "array":
      if (!Array.isArray(value)) out.push(`${at}: a list is declared`);
      else value.forEach((item, index) => detailsIssues(schema.items as Declared, item, `${path}[${index}]`, out));
      return;
    case "string":
      if (typeof value !== "string") out.push(`${at}: a string is declared`);
      return;
    case "integer":
      if (!Number.isInteger(value)) out.push(`${at}: an integer is declared`);
      return;
    case "number":
      if (typeof value !== "number") out.push(`${at}: a number is declared`);
      return;
    case "boolean":
      if (typeof value !== "boolean") out.push(`${at}: a boolean is declared`);
      return;
  }
}

/**
 * How a refusal's details, in the form apps receive them, break its code's declaration: a declared field
 * missing or of another shape (extra fields are fine: the bridge leaves them
 * out). Empty for a code that declares none, and for details that carry none
 * of the declared fields of a code whose fields are all optional.
 */
export function declaredDetailsProblems(code: string, details: unknown): string[] {
  const declared = isAppErrorCode(code) ? (APP_ERROR_CODES[code] as AppErrorCodeEntry).details : undefined;
  if (!declared) return [];
  const required = (declared.required ?? []) as string[];
  if (details === undefined && required.length === 0) return [];
  const out: string[] = [];
  detailsIssues(declared, normalizedDetails(code, details) ?? {}, "", out);
  return out;
}

const warned = new Set<string>();

/** Set (to true, on globalThis) by the test setup: a producer that breaks its declaration throws. */
export const STRICT_DETAILS_FLAG = Symbol.for("scalius.appErrorDetails.strict");

/**
 * Checks a refusal's details against its code's declaration where it is
 * made (`AppError`): production logs each code's first problem once per
 * isolate (code and path, never a value); the test setup throws instead, so
 * every test that drives a producer holds it to the sealed shape.
 */
export function checkDeclaredDetails(code: string, details: unknown): void {
  if (!isAppErrorCode(code) || !(APP_ERROR_CODES[code] as AppErrorCodeEntry).details) return;
  const problems = declaredDetailsProblems(code, details);
  if (problems.length === 0) return;
  if (Reflect.get(globalThis, STRICT_DETAILS_FLAG) === true) {
    throw new Error(`${code} details break their sealed declaration (APP_ERROR_CODES): ${problems.join("; ")}.`);
  }
  if (warned.has(code) || warned.size >= 50) return;
  warned.add(code);
  console.warn(JSON.stringify({ event: "app_error_details_mismatch", code, problems: problems.slice(0, 5) }));
}
