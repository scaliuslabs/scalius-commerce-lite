import type { Database } from "@scalius/database/client";
import { scannerTokenClaims } from "@scalius/database/schema";
import {
  SCANNER_SESSION_TTL_SECONDS,
  SCANNER_TOKEN_TTL_SECONDS,
  sha256Hex,
} from "@scalius/shared/scanner-auth";
import { and, eq, gt, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import { ConflictError, UnauthorizedError } from "../errors";

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

export async function cleanupExpiredScannerTokenClaims(
  db: Database,
  options: { nowSeconds?: number; limit?: number } = {},
): Promise<ScannerTokenCleanupResult> {
  const nowSeconds = options.nowSeconds ?? toUnixSeconds(Date.now());
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  const consumedRetentionCutoff = nowSeconds - SCANNER_SESSION_TTL_SECONDS;
  const rows = await db
    .select({ tokenHash: scannerTokenClaims.tokenHash })
    .from(scannerTokenClaims)
    .where(
      or(
        and(
          isNull(scannerTokenClaims.consumedAt),
          lte(scannerTokenClaims.expiresAt, nowSeconds),
        ),
        and(
          isNotNull(scannerTokenClaims.consumedAt),
          lte(scannerTokenClaims.consumedAt, consumedRetentionCutoff),
        ),
      ),
    )
    .limit(limit + 1);

  const deleteIds = rows.slice(0, limit).map((row) => row.tokenHash);
  if (deleteIds.length > 0) {
    await db
      .delete(scannerTokenClaims)
      .where(inArray(scannerTokenClaims.tokenHash, deleteIds));
  }

  return {
    scanned: Math.min(rows.length, limit),
    deleted: deleteIds.length,
    limit,
    hasMore: rows.length > limit,
  };
}

function toUnixSeconds(timestampMs: number): number {
  return Math.floor(timestampMs / 1000);
}
