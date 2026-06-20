export const SCANNER_COOKIE_NAME = "scanner_sid";
export const SCANNER_TOKEN_TTL_SECONDS = 15 * 60;
export const SCANNER_SESSION_TTL_SECONDS = 6 * 60 * 60;

export interface ScannerSessionPayload {
  adminId: string;
  adminName: string;
  createdAt: number;
  lastSeenAt?: number;
  claimTokenHash?: string;
}

const SCANNER_API_ALLOWLIST = new Set([
  "GET /api/v1/admin/inventory/scanner/lookup",
  "POST /api/v1/admin/inventory/stock-adjust",
  "POST /api/v1/admin/inventory/stock-set",
]);

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function getScannerSessionKey(sessionId: string): Promise<string> {
  return `scanner:session:${await sha256Hex(sessionId)}`;
}

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
  return SCANNER_API_ALLOWLIST.has(`${method.toUpperCase()} ${normalizedPath}`);
}
