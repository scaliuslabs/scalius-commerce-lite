import { sweepExpiredRows } from "../utils/sweep-expired-rows";
import type { Database } from "@scalius/database/client";
import { scannerTokenClaims } from "@scalius/database/schema";
import {
  SCANNER_SESSION_TTL_SECONDS,
  SCANNER_TOKEN_TTL_SECONDS,
} from "@scalius/shared/scanner-auth";
import { sha256Hex } from "@scalius/shared/hash";
import { and, eq, gt, isNotNull, isNull, lte, or } from "drizzle-orm";
import { ConflictError, UnauthorizedError } from "../errors";
import { liveStaffSql } from "./rbac/helpers";
import { PERMISSIONS } from "./rbac/permissions";

interface ScannerTokenClaimOptions {
  nowMs?: number;
}

interface CreateScannerTokenClaimInput extends ScannerTokenClaimOptions {
  token: string;
  adminId: string;
  adminName: string;
}

interface ConsumeScannerTokenClaimInput extends ScannerTokenClaimOptions {
  token: string;
  sessionId: string;
}

export interface ConsumedScannerTokenClaim {
  tokenHash: string;
  adminId: string;
  adminName: string;
}

export interface ScannerTokenCleanupResult {
  scanned: number;
  deleted: number;
  limit: number;
  hasMore: boolean;
}

export async function createScannerTokenClaim(
  db: Database,
  input: CreateScannerTokenClaimInput,
): Promise<void> {
  const nowSeconds = toUnixSeconds(input.nowMs ?? Date.now());
  const tokenHash = await sha256Hex(input.token);
  const inserted = await db
    .insert(scannerTokenClaims)
    .values({
      tokenHash,
      adminId: input.adminId,
      adminName: input.adminName,
      consumedAt: null,
      consumedSessionHash: null,
      expiresAt: nowSeconds + SCANNER_TOKEN_TTL_SECONDS,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
    })
    .onConflictDoNothing()
    .returning({ tokenHash: scannerTokenClaims.tokenHash });

  if (!inserted[0]?.tokenHash) {
    throw new ConflictError("Scanner token already exists. Please generate a new token.");
  }
}

export async function consumeScannerTokenClaim(
  db: Database,
  input: ConsumeScannerTokenClaimInput,
): Promise<ConsumedScannerTokenClaim> {
  const nowSeconds = toUnixSeconds(input.nowMs ?? Date.now());
  const tokenHash = await sha256Hex(input.token);
  const sessionIdHash = await sha256Hex(input.sessionId);
  const rows = await db
    .update(scannerTokenClaims)
    .set({
      consumedAt: nowSeconds,
      consumedSessionHash: sessionIdHash,
      sessionExpiresAt: nowSeconds + SCANNER_SESSION_TTL_SECONDS,
      updatedAt: nowSeconds,
    })
    .where(
      and(
        eq(scannerTokenClaims.tokenHash, tokenHash),
        isNull(scannerTokenClaims.consumedAt),
        gt(scannerTokenClaims.expiresAt, nowSeconds),
      ),
    )
    .returning({
      tokenHash: scannerTokenClaims.tokenHash,
      adminId: scannerTokenClaims.adminId,
      adminName: scannerTokenClaims.adminName,
    });

  const row = rows[0];
  if (!row) {
    throw new UnauthorizedError("Token invalid or expired");
  }

  return row;
}

export interface ScannerSession {
  adminId: string;
  adminName: string;
}

/**
 * The most a scanner device may ever do: the permissions its allowlisted
 * routes (`@scalius/shared/scanner-auth`) ask for. Product costs are not
 * among them, so a phone on the warehouse floor never shows them.
 */
export const SCANNER_PERMISSION_CEILING: ReadonlySet<string> = new Set([
  PERMISSIONS.PRODUCTS_VIEW,
  PERMISSIONS.PRODUCTS_ADJUST_STOCK,
  PERMISSIONS.INVENTORY_VIEW,
  PERMISSIONS.INVENTORY_MANAGE,
]);

/** A scanner's authority: what its staff member may do now, within the ceiling. */
export function scannerPermissions(staffPermissions: ReadonlySet<string>): Set<string> {
  return new Set([...staffPermissions].filter((permission) => SCANNER_PERMISSION_CEILING.has(permission)));
}

/**
 * The live scanner session behind a `scanner_sid` cookie: the claim row that
 * session consumed, until `session_expires_at`, while the staff member who
 * paired it exists and is not suspended. What the session may do is decided
 * per request from that staff member's current permissions
 * (`scannerPermissions`), like a dashboard session. With `refresh`, the
 * session slides another full lifetime from now. Deleting or suspending the
 * staff member deletes the row.
 */
export async function readScannerSession(
  db: Database,
  sessionId: string,
  options: ScannerTokenClaimOptions & { refresh?: boolean } = {},
): Promise<ScannerSession | null> {
  const nowSeconds = toUnixSeconds(options.nowMs ?? Date.now());
  const live = and(
    eq(scannerTokenClaims.consumedSessionHash, await sha256Hex(sessionId)),
    gt(scannerTokenClaims.sessionExpiresAt, nowSeconds),
    liveStaffSql(scannerTokenClaims.adminId),
  );
  const session = { adminId: scannerTokenClaims.adminId, adminName: scannerTokenClaims.adminName };
  const rows = options.refresh
    ? await db.update(scannerTokenClaims)
      .set({ sessionExpiresAt: nowSeconds + SCANNER_SESSION_TTL_SECONDS, updatedAt: nowSeconds })
      .where(live)
      .returning(session)
    : await db.select(session).from(scannerTokenClaims).where(live).limit(1);
  return rows[0] ?? null;
}

export async function cleanupExpiredScannerTokenClaims(
  db: Database,
  options: { nowSeconds?: number; limit?: number } = {},
): Promise<ScannerTokenCleanupResult> {
  const nowSeconds = options.nowSeconds ?? toUnixSeconds(Date.now());
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  const expired = or(
    and(
      isNull(scannerTokenClaims.consumedAt),
      lte(scannerTokenClaims.expiresAt, nowSeconds),
    ),
    and(
      isNotNull(scannerTokenClaims.consumedAt),
      or(
        isNull(scannerTokenClaims.sessionExpiresAt),
        lte(scannerTokenClaims.sessionExpiresAt, nowSeconds),
      ),
    ),
  );
  return sweepExpiredRows(db, scannerTokenClaims, scannerTokenClaims.tokenHash, expired, limit);
}

function toUnixSeconds(timestampMs: number): number {
  return Math.floor(timestampMs / 1000);
}
