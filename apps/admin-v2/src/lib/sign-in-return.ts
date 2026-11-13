// Where sign-in returns a person whose session ended: the dashboard page they
// were on, carried as `?next=` through the sign-in page and the two-step code
// step. Only a path inside this dashboard is ever followed: never another
// origin, however it is spelled (absolute, protocol-relative `//host`,
// backslashes browsers read as slashes, or any of these percent-encoded), so
// the parameter can never be used to send someone elsewhere.
import { isCameraDocumentPath } from "@scalius/shared/scanner-auth";
import { getDashboardBasePath, stripDashboardBasePath, withDashboardBasePath } from "./dashboard-base-path";

/** The pages sign-in may return to (the sign-in pages themselves are not among them). */
const RETURN_ROOTS = ["/admin", "/connect", "/scanner", "/invoices", "/invoice"] as const;
const MAX_RETURN_LENGTH = 2_048;
/** A stand-in origin to parse against: a parsed path that leaves it named another origin. */
const PROBE_ORIGIN = "https://dashboard.invalid";

function decodedForms(value: string): string[] {
  const forms = [value];
  let current = value;
  // Twice: a path encoded twice must not decode into `//host` later.
  for (let round = 0; round < 2; round += 1) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      forms.push(next);
      current = next;
    } catch {
      return [];
    }
  }
  return forms;
}

/**
 * A dashboard path sign-in may return to (`/admin/orders/1001?tab=notes`), or
 * null for anything else: a URL, `//host`, a backslash, a control character,
 * an encoded form of any of them, or a path outside the dashboard's pages.
 */
export function signInReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_RETURN_LENGTH) return null;
  const forms = decodedForms(raw);
  if (forms.length === 0) return null;
  for (const form of forms) {
    if (!form.startsWith("/") || form.startsWith("//") || form.includes("\\")) return null;
    // Control and Unicode format characters (a browser strips tabs and newlines from a URL).
    if (/[\p{Cc}\p{Cf}]/u.test(form)) return null;
  }
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PROBE_ORIGIN) return null;
  const path = url.pathname;
  if (!RETURN_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))) return null;
  return `${path}${url.search}${url.hash}`;
}

/** The page this tab shows now, as a return path (without the dashboard's base path), or null. */
export function currentSignInReturn(): string | null {
  if (typeof window === "undefined") return null;
  const { pathname, search, hash } = window.location;
  const path = stripDashboardBasePath(pathname ?? "", getDashboardBasePath());
  return path === null ? null : signInReturnPath(`${path}${search ?? ""}${hash ?? ""}`);
}

/** The sign-in page's address (with the base path), returning to `next` when it is a dashboard page. */
export function signInHref(next: string | null = currentSignInReturn()): string {
  const path = signInReturnPath(next);
  return withDashboardBasePath(path ? `/auth/login?next=${encodeURIComponent(path)}` : "/auth/login");
}

/** The search a sign-in route keeps: `next` only when it is a dashboard page. */
export function signInReturnSearch(search: Record<string, unknown>): { next?: string } {
  const next = signInReturnPath(search.next);
  return next ? { next } : {};
}

/**
 * Where a finished sign-in goes: the page it returns to, else Home. `href`
 * carries the base path (a router `href` bypasses it); the scanner loads as
 * its own document, the one allowed the camera.
 */
export function afterSignIn(next: string | null | undefined): { href: string; replace: true; reloadDocument?: true } {
  const path = signInReturnPath(next) ?? "/admin";
  return { href: withDashboardBasePath(path), replace: true, ...(isCameraDocumentPath(path) ? { reloadDocument: true as const } : {}) };
}
