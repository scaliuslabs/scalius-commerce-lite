export const SCANNER_COOKIE_NAME = "scanner_sid";
export const SCANNER_TOKEN_TTL_SECONDS = 15 * 60;
export const SCANNER_SESSION_TTL_SECONDS = 6 * 60 * 60;

const SCANNER_API_ALLOWLIST = new Set([
  "GET /api/v1/admin/inventory/scanner/lookup",
  // The location picker: where the scanner counts and adjusts stock.
  "GET /api/v1/admin/inventory/locations",
  "POST /api/v1/admin/inventory/stock-adjust",
  "POST /api/v1/admin/inventory/stock-set",
  // Receiving by scan (0109): pick an open purchase order or transfer.
  "GET /api/v1/admin/inventory/purchase-orders",
  "GET /api/v1/admin/inventory/transfers",
]);

/** One document id path segment (`po_…`, `trf_…`). */
const DOCUMENT_ID = "[A-Za-z0-9_-]{1,100}";

/** Receiving by scan (0109): read one open document and receive its lines. */
const SCANNER_API_PATTERNS: ReadonlyArray<readonly [method: string, path: RegExp]> = [
  ["GET", new RegExp(`^/api/v1/admin/inventory/purchase-orders/${DOCUMENT_ID}$`)],
  ["POST", new RegExp(`^/api/v1/admin/inventory/purchase-orders/${DOCUMENT_ID}/receive$`)],
  ["GET", new RegExp(`^/api/v1/admin/inventory/transfers/${DOCUMENT_ID}$`)],
  ["POST", new RegExp(`^/api/v1/admin/inventory/transfers/${DOCUMENT_ID}/receive$`)],
];

export function parseCookie(cookieHeader: string | null | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const chunk of cookieHeader.split(";")) {
    const [rawName, ...valueParts] = chunk.trim().split("=");
    if (rawName === name) {
      const value = valueParts.join("=");
      return value ? decodeURIComponent(value) : undefined;
    }
  }
  return undefined;
}

export function buildScannerSessionCookie(
  sessionId: string,
  maxAgeSeconds: number,
  options: { secure: boolean },
): string {
  const parts = [
    `${SCANNER_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function isAllowedScannerApiRequest(pathname: string, method: string): boolean {
  const normalizedPath = pathname.startsWith("/api/v1")
    ? pathname
    : `/api/v1${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
  const upperMethod = method.toUpperCase();
  return SCANNER_API_ALLOWLIST.has(`${upperMethod} ${normalizedPath}`)
    || SCANNER_API_PATTERNS.some(([allowedMethod, path]) => allowedMethod === upperMethod && path.test(normalizedPath));
}
