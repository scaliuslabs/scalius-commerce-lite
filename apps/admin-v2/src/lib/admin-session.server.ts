type AdminDb = Pick<D1Database, "prepare">;

const SESSION_COOKIE_NAMES = [
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;

export interface AdminSessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string | null;
  twoFactorEnabled: boolean;
  isSuperAdmin: boolean;
}

export interface AdminSessionRecord {
  user: AdminSessionUser;
  session: {
    id: string;
    twoFactorVerified: boolean;
  };
}

interface AdminSessionRow {
  sessionId: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: string | null;
  twoFactorEnabled: number | boolean | null;
  twoFactorVerified: number | boolean | null;
  isSuperAdmin: number | boolean | null;
}

function truthy(value: number | boolean | null | undefined): boolean {
  return value === true || value === 1;
}

export function getAdminSessionTokenFromCookieHeader(
  cookieHeader: string | null | undefined,
): string | null {
  const cookie = cookieHeader?.trim();
  if (!cookie) return null;

  for (const part of cookie.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (!rawName || rawValueParts.length === 0) continue;
    if (!SESSION_COOKIE_NAMES.includes(rawName as (typeof SESSION_COOKIE_NAMES)[number])) {
      continue;
    }

    const rawValue = rawValueParts.join("=");
    if (!rawValue) continue;

    try {
      const decoded = decodeURIComponent(rawValue);
      const token = decoded.split(".")[0]?.trim();
      if (token) return token;
    } catch {
      const token = rawValue.split(".")[0]?.trim();
      if (token) return token;
    }
  }

  return null;
}

export async function getAdminSessionFromCookieHeader(
  db: AdminDb,
  cookieHeader: string | null | undefined,
): Promise<AdminSessionRecord | null> {
  const token = getAdminSessionTokenFromCookieHeader(cookieHeader);
  if (!token) return null;

  const { retryTransientD1 } = await import("@scalius/core/utils/transient-d1");
  const row = await retryTransientD1(() =>
    db
      .prepare(
        `SELECT
          s.id as sessionId,
          s.user_id as userId,
          s.two_factor_verified as twoFactorVerified,
          u.name as name,
          u.email as email,
          u.image as image,
          u.role as role,
          u.two_factor_enabled as twoFactorEnabled,
          u.is_super_admin as isSuperAdmin
        FROM session s
        INNER JOIN user u ON u.id = s.user_id
        WHERE s.token = ?
          AND s.expires_at > unixepoch()
          AND (
            u.banned = 0
            OR u.banned IS NULL
            OR (u.ban_expires IS NOT NULL AND u.ban_expires <= unixepoch())
          )
        LIMIT 1`,
      )
      .bind(token)
      .first<AdminSessionRow>(),
  );

  if (!row) return null;

  return {
    user: {
      id: row.userId,
      name: row.name,
      email: row.email,
      image: row.image,
      role: row.role,
      twoFactorEnabled: truthy(row.twoFactorEnabled),
      isSuperAdmin: truthy(row.isSuperAdmin),
    },
    session: {
      id: row.sessionId,
      twoFactorVerified: truthy(row.twoFactorVerified),
    },
  };
}
