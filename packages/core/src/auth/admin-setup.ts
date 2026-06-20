import { safeBatch, type Database } from "@scalius/database/client";
import { adminSetupClaims, adminSetupRateLimits, user } from "@scalius/database/schema";
import { and, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import { ConflictError, ForbiddenError, RateLimitError } from "../errors";

export interface ClaimedAdminSetup {
  singletonKey: typeof ADMIN_SETUP_SINGLETON_KEY;
  claimId: string;
}

interface SetupCoordinationOptions {
  nowSeconds?: number;
}

interface CompleteSetupPromotionOptions extends SetupCoordinationOptions {
  userId: string;
  name?: string;
}

const ADMIN_SETUP_SINGLETON_KEY = "first_admin";
const ADMIN_SETUP_CLAIM_LEASE_SECONDS = 60;
const ADMIN_SETUP_RATE_LIMIT_ATTEMPTS = 5;
const ADMIN_SETUP_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const MAX_ERROR_LENGTH = 500;

export async function enforceAdminSetupRateLimit(
  db: Database,
  clientIdentifier: string,
  options: SetupCoordinationOptions = {},
): Promise<void> {
  const nowSeconds = options.nowSeconds ?? currentUnixSeconds();
  const key = await buildAdminSetupRateLimitKey(clientIdentifier);
  const windowExpiresAt = nowSeconds + ADMIN_SETUP_RATE_LIMIT_WINDOW_SECONDS;

  const inserted = await db
    .insert(adminSetupRateLimits)
    .values({
      key,
      attempts: 1,
      windowExpiresAt,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
    })
    .onConflictDoNothing()
    .returning({ key: adminSetupRateLimits.key });

  if (inserted[0]?.key) return;

  const reset = await db
    .update(adminSetupRateLimits)
    .set({
      attempts: 1,
      windowExpiresAt,
      updatedAt: nowSeconds,
    })
    .where(
      and(
        eq(adminSetupRateLimits.key, key),
        lte(adminSetupRateLimits.windowExpiresAt, nowSeconds),
      ),
    )
    .returning({ key: adminSetupRateLimits.key });

  if (reset[0]?.key) return;

  const incremented = await db
    .update(adminSetupRateLimits)
    .set({
      attempts: sql`${adminSetupRateLimits.attempts} + 1`,
      updatedAt: nowSeconds,
    })
    .where(
      and(
        eq(adminSetupRateLimits.key, key),
        gt(adminSetupRateLimits.windowExpiresAt, nowSeconds),
        lt(adminSetupRateLimits.attempts, ADMIN_SETUP_RATE_LIMIT_ATTEMPTS),
      ),
    )
    .returning({
      key: adminSetupRateLimits.key,
      attempts: adminSetupRateLimits.attempts,
    });

  if (incremented[0]?.key) return;

  const row = await db
    .select({
      attempts: adminSetupRateLimits.attempts,
      windowExpiresAt: adminSetupRateLimits.windowExpiresAt,
    })
    .from(adminSetupRateLimits)
    .where(eq(adminSetupRateLimits.key, key))
    .get();

  if (row && row.windowExpiresAt > nowSeconds && row.attempts >= ADMIN_SETUP_RATE_LIMIT_ATTEMPTS) {
    throw new RateLimitError(
      "Too many setup attempts. Try again later.",
      Math.max(1, row.windowExpiresAt - nowSeconds),
    );
  }
}

export async function claimAdminSetup(
  db: Database,
  options: SetupCoordinationOptions = {},
): Promise<ClaimedAdminSetup> {
  const nowSeconds = options.nowSeconds ?? currentUnixSeconds();
  const claimId = createAdminSetupClaimId();
  const claimExpiresAt = nowSeconds + ADMIN_SETUP_CLAIM_LEASE_SECONDS;

  const inserted = await db
    .insert(adminSetupClaims)
    .values({
      singletonKey: ADMIN_SETUP_SINGLETON_KEY,
      status: "processing",
      claimId,
      claimExpiresAt,
      completedUserId: null,
      lastError: null,
      createdAt: nowSeconds,
      updatedAt: nowSeconds,
    })
    .onConflictDoNothing()
    .returning({ singletonKey: adminSetupClaims.singletonKey });

  if (inserted[0]?.singletonKey) {
    return { singletonKey: ADMIN_SETUP_SINGLETON_KEY, claimId };
  }

  const existing = await selectAdminSetupClaim(db);
  if (existing?.status === "completed") {
    throw new ForbiddenError("Initial admin setup has already been completed.");
  }

  const reclaimed = await db
    .update(adminSetupClaims)
    .set({
      status: "processing",
      claimId,
      claimExpiresAt,
      lastError: null,
      updatedAt: nowSeconds,
    })
    .where(
      and(
        eq(adminSetupClaims.singletonKey, ADMIN_SETUP_SINGLETON_KEY),
        or(
          eq(adminSetupClaims.status, "failed"),
          and(
            eq(adminSetupClaims.status, "processing"),
            or(
              isNull(adminSetupClaims.claimExpiresAt),
              lte(adminSetupClaims.claimExpiresAt, nowSeconds),
            ),
          ),
        ),
      ),
    )
    .returning({ singletonKey: adminSetupClaims.singletonKey });

  if (reclaimed[0]?.singletonKey) {
    return { singletonKey: ADMIN_SETUP_SINGLETON_KEY, claimId };
  }

  throw new ConflictError("Admin setup is already in progress. Please wait.");
}

export async function assertAdminSetupClaimActive(
  db: Database,
  claim: ClaimedAdminSetup,
  options: SetupCoordinationOptions = {},
): Promise<void> {
  const nowSeconds = options.nowSeconds ?? currentUnixSeconds();
  const row = await db
    .select({ singletonKey: adminSetupClaims.singletonKey })
    .from(adminSetupClaims)
    .where(
      and(
        eq(adminSetupClaims.singletonKey, claim.singletonKey),
        eq(adminSetupClaims.claimId, claim.claimId),
        eq(adminSetupClaims.status, "processing"),
        gt(adminSetupClaims.claimExpiresAt, nowSeconds),
      ),
    )
    .get();

  if (!row) {
    throw new ConflictError("Admin setup claim expired or was replaced. Please retry setup.");
  }
}

export async function markAdminSetupClaimCompleted(
  db: Database,
  claim: ClaimedAdminSetup,
  userId: string | null,
  options: SetupCoordinationOptions = {},
): Promise<void> {
  const nowSeconds = options.nowSeconds ?? currentUnixSeconds();
  const rows = await db
    .update(adminSetupClaims)
    .set({
      status: "completed",
      claimId: null,
      claimExpiresAt: null,
      completedUserId: userId,
      lastError: null,
      updatedAt: nowSeconds,
    })
    .where(
      and(
        eq(adminSetupClaims.singletonKey, claim.singletonKey),
        eq(adminSetupClaims.claimId, claim.claimId),
        eq(adminSetupClaims.status, "processing"),
      ),
    )
    .returning({ singletonKey: adminSetupClaims.singletonKey });

  if (!rows[0]?.singletonKey) {
    throw new ConflictError("Admin setup claim was lost before completion could be stored.");
  }
}

export async function completeAdminSetupClaimWithUserPromotion(
  db: Database,
  claim: ClaimedAdminSetup,
  options: CompleteSetupPromotionOptions,
): Promise<void> {
  const nowSeconds = options.nowSeconds ?? currentUnixSeconds();
  const activeClaimExists = sql`exists (
    select 1 from admin_setup_claims
    where singleton_key = ${claim.singletonKey}
      and claim_id = ${claim.claimId}
      and status = 'processing'
      and claim_expires_at > ${nowSeconds}
  )`;
  const targetUserExists = sql`exists (
    select 1 from "user"
    where "user"."id" = ${options.userId}
  )`;
  const userUpdate: {
    role: "admin";
    isSuperAdmin: true;
    emailVerified: true;
    name?: string;
  } = {
    role: "admin",
    isSuperAdmin: true,
    emailVerified: true,
  };

  if (options.name !== undefined) {
    userUpdate.name = options.name;
  }

  const [promotedRows, claimRows] = await safeBatch(db, [
    db
      .update(user)
      .set(userUpdate)
      .where(and(eq(user.id, options.userId), activeClaimExists))
      .returning({ id: user.id }),
    db
      .update(adminSetupClaims)
      .set({
        status: "completed",
        claimId: null,
        claimExpiresAt: null,
        completedUserId: options.userId,
        lastError: null,
        updatedAt: nowSeconds,
      })
      .where(
        and(
          eq(adminSetupClaims.singletonKey, claim.singletonKey),
          eq(adminSetupClaims.claimId, claim.claimId),
          eq(adminSetupClaims.status, "processing"),
          gt(adminSetupClaims.claimExpiresAt, nowSeconds),
          targetUserExists,
        ),
      )
      .returning({ singletonKey: adminSetupClaims.singletonKey }),
  ] as const);

  if (!promotedRows[0]?.id || !claimRows[0]?.singletonKey) {
    throw new ConflictError("Admin setup claim expired or was replaced before promotion completed.");
  }
}

export async function markAdminSetupClaimFailed(
  db: Database,
  claim: ClaimedAdminSetup,
  error: unknown,
  options: SetupCoordinationOptions = {},
): Promise<void> {
  const nowSeconds = options.nowSeconds ?? currentUnixSeconds();
  await db
    .update(adminSetupClaims)
    .set({
      status: "failed",
      claimId: null,
      claimExpiresAt: null,
      lastError: serializeSetupError(error),
      updatedAt: nowSeconds,
    })
    .where(
      and(
        eq(adminSetupClaims.singletonKey, claim.singletonKey),
        eq(adminSetupClaims.claimId, claim.claimId),
        eq(adminSetupClaims.status, "processing"),
      ),
    );
}

async function selectAdminSetupClaim(db: Database) {
  return await db
    .select({
      singletonKey: adminSetupClaims.singletonKey,
      status: adminSetupClaims.status,
      claimExpiresAt: adminSetupClaims.claimExpiresAt,
    })
    .from(adminSetupClaims)
    .where(eq(adminSetupClaims.singletonKey, ADMIN_SETUP_SINGLETON_KEY))
    .get();
}

async function buildAdminSetupRateLimitKey(identifier: string): Promise<string> {
  const normalized = identifier.trim().toLowerCase() || "unknown";
  const data = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `setup_rate:v1:${arrayBufferToHex(digest)}`;
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function createAdminSetupClaimId(): string {
  return `setup_claim_${crypto.randomUUID()}`;
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function serializeSetupError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_LENGTH);
}
