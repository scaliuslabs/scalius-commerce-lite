// The one writer of how a customer signs in (rules/auth/sign-in-writes-name-their-version.md).
//
// How a customer signs in is `phone`, `email`, their proofs
// (`phone_verified_at`, `email_verified_at`), the recovery mark a sign-in
// reset leaves (`sign_in_recovery`, `sign_in_recovery_at`) and the app
// identities linked to the account (`customer_identities`). Every write of
// any of them is built here and nowhere else (a source policy holds every
// other file to it), and advances `sign_in_version`.
//
// A write that was decided from a read names the version it read: the batch
// leads with a guard that fails it whole when another sign-in write landed
// since (so a session or a history row never commits beside a lost write),
// and the update itself matches only that version. The caller answers 409
// `sign_in_changed` (`signInChangedConflict`); a retry reads again.
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { buildBatchGuard, isBatchGuardError, type Database } from "@scalius/database/client";
import { customerIdentities, customers } from "@scalius/database/schema";
import { NO_PHONE } from "@scalius/shared/customer-auth-policy";
import { ConflictError } from "@scalius/core/errors";

type SQLiteBatchItem = BatchItem<"sqlite">;
type CustomerSet = SQLiteUpdateSetSource<typeof customers>;
type CustomerInsert = typeof customers.$inferInsert;

/** `details.reason` when a sign-in write lost to one that landed after its read. */
export const SIGN_IN_CHANGED_REASON = "sign_in_changed";
const SIGN_IN_CHANGED = "SIGN_IN_CHANGED";

/** The columns of `customers` only this module writes. */
const SIGN_IN_KEYS = ["phone", "email", "phoneVerifiedAt", "emailVerifiedAt", "signInRecovery", "signInRecoveryAt", "signInVersion"] as const;

/** The customer a write was decided from: its id and the `sign_in_version` read with it. */
export interface SignInRead {
    id: string;
    signInVersion: number;
}

/** Whether a set or insert writes a column of how the customer signs in. */
function writesSignIn(values: object): boolean {
    return SIGN_IN_KEYS.some((key) => Object.hasOwn(values, key));
}

/** The answer to a write that lost (409, `details.reason` `sign_in_changed`). */
export function signInChangedConflict(): ConflictError {
    return new ConflictError("How this customer signs in changed since it was read. Read it again and repeat the change.", {
        reason: SIGN_IN_CHANGED_REASON,
    });
}

/** A batch failed because a sign-in write landed after its read. */
export function isSignInChangedError(error: unknown): boolean {
    return isBatchGuardError(error, SIGN_IN_CHANGED);
}

/** Fails the batch unless the customer is still at the version read and `also` holds for its row. */
export function signInUnchanged(db: Database, read: SignInRead, also?: SQL): SQLiteBatchItem {
    return buildBatchGuard(db, sql`EXISTS (
        SELECT 1 FROM ${customers}
        WHERE ${customers.id} = ${read.id} AND ${customers.signInVersion} = ${read.signInVersion}
        ${also ? sql`AND ${also}` : sql``}
    )`, SIGN_IN_CHANGED);
}

/**
 * A contact moved off the recovery contact a reset named ends that reset:
 * the mark matches only the value the reset set.
 */
function recoveryFollowsContact(set: CustomerSet): CustomerSet {
    if (Object.hasOwn(set, "signInRecovery")) return set;
    const moved: SQL[] = [];
    if (Object.hasOwn(set, "phone")) moved.push(sql`(${customers.signInRecovery} = 'phone' AND ${customers.phone} IS NOT ${set.phone})`);
    if (Object.hasOwn(set, "email")) moved.push(sql`(${customers.signInRecovery} = 'email' AND lower(${customers.email}) IS NOT lower(${set.email}))`);
    if (moved.length === 0) return set;
    const ends = sql.join(moved, sql` OR `);
    return {
        ...set,
        signInRecovery: sql`CASE WHEN ${ends} THEN NULL ELSE ${customers.signInRecovery} END`,
        signInRecoveryAt: sql`CASE WHEN ${ends} THEN NULL ELSE ${customers.signInRecoveryAt} END`,
    };
}

function advance(set: CustomerSet): CustomerSet {
    return { ...recoveryFollowsContact(set), signInVersion: sql`${customers.signInVersion} + 1`, updatedAt: sql`unixepoch()` };
}

/**
 * A write decided from `read`: the guard, then the update of only that
 * version. `set` may hold any column; the version always advances.
 */
export function writeSignIn(db: Database, read: SignInRead, set: CustomerSet, also?: SQL): SQLiteBatchItem[] {
    return [
        signInUnchanged(db, read, also),
        db.update(customers).set(advance(set))
            .where(and(eq(customers.id, read.id), eq(customers.signInVersion, read.signInVersion))) as unknown as SQLiteBatchItem,
    ];
}

/**
 * A write whose whole precondition is `where` (checked by the write itself,
 * nothing read before it): a blank email filled, an erasure. When it writes
 * how a row signs in, that row's version advances.
 */
export function writeCustomerWhere(db: Database, where: SQL, set: CustomerSet): SQLiteBatchItem {
    return db.update(customers).set(writesSignIn(set) ? advance(set) : set).where(where) as unknown as SQLiteBatchItem;
}

/** The columns an erasure clears of how the customer signs in, and its linked identities. */
export function eraseSignIn(db: Database, where: SQL, rest: CustomerSet, identitiesOf: SQL): SQLiteBatchItem[] {
    return [
        writeCustomerWhere(db, where, {
            ...rest,
            email: null,
            phone: NO_PHONE,
            phoneVerifiedAt: null,
            emailVerifiedAt: null,
            signInRecovery: null,
            signInRecoveryAt: null,
        }),
        db.delete(customerIdentities).where(identitiesOf) as unknown as SQLiteBatchItem,
    ];
}

/** A new customer row; one that proves a contact (a sign-up) starts at version 0. */
export function insertCustomer(db: Database, values: CustomerInsert): SQLiteBatchItem {
    return db.insert(customers).values({ ...values, signInVersion: 0 }) as unknown as SQLiteBatchItem;
}

/** An app identity (`provider`, `subject`) linked to a customer the same batch creates or writes. */
export function linkIdentity(db: Database, input: { providerId: string; subject: string; customerId: string; at: number }): SQLiteBatchItem {
    return db.insert(customerIdentities).values({
        providerId: input.providerId,
        subject: input.subject,
        customerId: input.customerId,
        createdAt: input.at,
        lastUsedAt: input.at,
    }) as unknown as SQLiteBatchItem;
}

/**
 * A sign-in with a linked app identity, decided from `read`: the account
 * must not have changed how it signs in since (a reset removes the identity
 * and signs it out everywhere).
 */
export function signInWithLinkedIdentity(db: Database, read: SignInRead, identity: { providerId: string; subject: string; at: number }): SQLiteBatchItem[] {
    return [
        signInUnchanged(db, read),
        db.update(customers).set({ lastAuthenticatedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
            .where(eq(customers.id, read.id)) as unknown as SQLiteBatchItem,
        db.update(customerIdentities).set({ lastUsedAt: identity.at })
            .where(and(eq(customerIdentities.providerId, identity.providerId), eq(customerIdentities.subject, identity.subject))) as unknown as SQLiteBatchItem,
    ];
}

/** The account a proof was resolved to, as read. */
export interface ProofRead extends SignInRead {
    phoneVerifiedAt: Date | null;
    emailVerifiedAt: Date | null;
    signInRecovery: "phone" | "email" | null;
}

/**
 * A code to `identifier` proved `account`, decided from its read: the
 * contact the row holds must still be exactly `identifier` (the one the code
 * went to) and the version the one read. A proof that changes nothing (the
 * contact already proven, no reset pending) only checks; one that proves the
 * contact or ends a reset writes it and advances the version. `link` adds an
 * app identity, which always advances it.
 */
export function proveSignIn(
    db: Database,
    account: ProofRead,
    method: "email" | "phone",
    identifier: string,
    link?: { providerId: string; subject: string; at: number },
): SQLiteBatchItem[] {
    const holds = method === "email" ? sql`lower(${customers.email}) = ${identifier}` : sql`${customers.phone} = ${identifier}`;
    const proven = method === "email" ? account.emailVerifiedAt : account.phoneVerifiedAt;
    if (proven && !account.signInRecovery && !link) {
        return [
            signInUnchanged(db, account, holds),
            db.update(customers).set({ lastAuthenticatedAt: sql`unixepoch()`, updatedAt: sql`unixepoch()` })
                .where(eq(customers.id, account.id)) as unknown as SQLiteBatchItem,
        ];
    }
    return [
        ...writeSignIn(db, account, {
            ...(method === "email"
                ? { emailVerifiedAt: sql`coalesce(${customers.emailVerifiedAt}, unixepoch())` }
                : { phoneVerifiedAt: sql`coalesce(${customers.phoneVerifiedAt}, unixepoch())` }),
            // A proof ends a sign-in reset: the account signs in again.
            signInRecovery: null,
            signInRecoveryAt: null,
            lastAuthenticatedAt: sql`unixepoch()`,
        }, holds),
        ...(link ? [linkIdentity(db, { ...link, customerId: account.id })] : []),
    ];
}

/**
 * A sign-in reset, decided from `read`: the one recovery contact is set and
 * marked, every proof is cleared and every linked identity removed.
 */
export function resetSignInWrites(db: Database, read: SignInRead, method: "phone" | "email", value: string): SQLiteBatchItem[] {
    return [
        ...writeSignIn(db, read, {
            ...(method === "phone" ? { phone: value } : { email: value }),
            phoneVerifiedAt: null,
            emailVerifiedAt: null,
            signInRecovery: method,
            signInRecoveryAt: sql`unixepoch()`,
        }, sql`${customers.erasedAt} IS NULL`),
        db.delete(customerIdentities).where(eq(customerIdentities.customerId, read.id)) as unknown as SQLiteBatchItem,
    ];
}
