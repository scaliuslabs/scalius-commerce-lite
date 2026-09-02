import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { verifyPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vitest";

import {
  createTursoDatabase,
  safeBatch,
  type Database,
} from "@scalius/database/client";
import { compileSqliteMigrationForProvider } from "@scalius/database/migration-artifacts";
import {
  account,
  adminInvitations,
  adminSetupClaims,
  roles,
  session,
  user,
  userRoles,
} from "@scalius/database/schema";
import * as schema from "@scalius/database/schema";

import { ConflictError } from "../errors";
import {
  CredentialIdentityConflictError,
  completeAdminSetupClaimWithCredentialIdentity,
  createInvitedAdminCredentialAccount,
  prepareCredentialIdentity,
} from "./credential-account";

interface SqliteD1Result {
  results: Record<string, SQLOutputValue>[];
  success: true;
  meta: Record<string, never>;
}

interface SqliteD1Statement {
  bind(...values: SQLInputValue[]): SqliteD1Statement;
  run(): Promise<SqliteD1Result>;
  all(): Promise<SqliteD1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): SqliteD1Result;
}

interface ProviderHarness {
  db: Database;
  sqlite: DatabaseSync;
  d1Binding?: D1Database;
}

const migrationDirectory = fileURLToPath(new URL(
  "../../../database/migrations/",
  import.meta.url,
));

function createProviderSchemaDatabase(provider: "d1" | "turso"): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationDirectory)
    .filter((candidate) => /^\d{4}_.+\.sql$/.test(candidate))
    .sort()) {
    const migration = readFileSync(`${migrationDirectory}/${name}`, "utf8");
    sqlite.exec(compileSqliteMigrationForProvider(migration, provider));
  }
  return sqlite;
}

function statementRows(
  statement: StatementSync,
  values: SQLInputValue[],
): Record<string, SQLOutputValue>[] {
  return statement.all(...values);
}

function d1Statement(
  sqlite: DatabaseSync,
  query: string,
  values: SQLInputValue[] = [],
): SqliteD1Statement {
  const execute = (): SqliteD1Result => ({
    results: statementRows(sqlite.prepare(query), values),
    success: true,
    meta: {},
  });
  return {
    bind: (...nextValues) => d1Statement(sqlite, query, nextValues),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = statementRows(sqlite.prepare(query), values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

function createD1Database(sqlite: DatabaseSync): {
  db: Database;
  binding: D1Database;
} {
  const binding = {
    prepare: (query: string) => d1Statement(sqlite, query),
    async batch(statements: SqliteD1Statement[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const d1Binding = binding as unknown as D1Database;
  return {
    db: drizzle(d1Binding, { schema }) as unknown as Database,
    binding: d1Binding,
  };
}

function createStatefulTursoDatabase(sqlite: DatabaseSync): Database {
  return createTursoDatabase(
    { url: "turso://credential-conformance.turso.io", authToken: "test" },
    {
      connect: () => ({
        async batch(statements, options) {
          const transactional = options?.mode !== undefined;
          if (transactional) {
            sqlite.exec(options?.mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
          }
          try {
            const results = statements.map((statement) => {
              const sqlText = typeof statement === "string" ? statement : statement.sql;
              const args = typeof statement === "string" || statement.args === undefined
                ? []
                : statement.args;
              if (!Array.isArray(args)) {
                throw new Error("Credential Turso conformance accepts positional arguments only.");
              }
              const prepared = sqlite.prepare(sqlText);
              if (prepared.columns().length === 0) {
                const result = prepared.run(...args as SQLInputValue[]);
                return { rows: [], rowsAffected: Number(result.changes) };
              }
              prepared.setReturnArrays(true);
              return {
                rows: prepared.all(
                  ...args as SQLInputValue[],
                ) as unknown as SQLOutputValue[][],
                rowsAffected: 0,
              };
            });
            if (transactional) sqlite.exec("COMMIT");
            return results;
          } catch (error) {
            if (transactional && sqlite.isTransaction) sqlite.exec("ROLLBACK");
            throw error;
          }
        },
      }),
      writeBatchMode: "concurrent",
    },
  );
}

async function createHarness(provider: "d1" | "turso"): Promise<ProviderHarness> {
  const sqlite = createProviderSchemaDatabase(provider);
  sqlite.exec("PRAGMA foreign_keys = ON");
  if (provider === "d1") {
    const d1 = createD1Database(sqlite);
    return { db: d1.db, sqlite, d1Binding: d1.binding };
  }
  return {
    db: createStatefulTursoDatabase(sqlite),
    sqlite,
  };
}

describe.each(["d1", "turso"] as const)(
  "%s credential account conformance",
  (provider) => {
    it("atomically creates a blocked invite with a Better Auth-compatible credential", async () => {
      const { db, sqlite, d1Binding } = await createHarness(provider);
      const createdAt = new Date("2026-08-03T00:00:00.000Z");
      const password = "InvitedAdminPassword123!";

      try {
        await safeBatch(db, [
          db.insert(user).values({
            id: "inviter",
            name: "Store Owner",
            email: "owner@example.test",
            emailVerified: true,
            role: "admin",
            isSuperAdmin: true,
            createdAt,
            updatedAt: createdAt,
          }),
          db.insert(roles).values({
            id: "catalog_role",
            name: "catalog_role",
            displayName: "Catalog role",
            createdAt,
            updatedAt: createdAt,
          }),
        ] as const);

        const credential = await prepareCredentialIdentity({
          userId: "invited_admin",
          accountRowId: "invited_admin_account",
          name: "  Invited Admin  ",
          email: "  INVITED@EXAMPLE.TEST  ",
          password,
          createdAt,
        });
        const created = await createInvitedAdminCredentialAccount(
          db,
          credential,
          {
            invitedByUserId: "inviter",
            roleId: "catalog_role",
            invitationId: "invite_conformance",
            roleAssignmentId: "invite_role_conformance",
          },
        );

        expect(created).toEqual({
          userId: "invited_admin",
          invitationId: "invite_conformance",
          email: "invited@example.test",
        });
        await expect(db.select({
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          emailVerified: user.emailVerified,
          mustChangePassword: user.mustChangePassword,
          mustEnrollTwoFactor: user.mustEnrollTwoFactor,
        }).from(user).where(eq(user.id, "invited_admin")).get()).resolves.toEqual({
          id: "invited_admin",
          name: "Invited Admin",
          email: "invited@example.test",
          role: "admin",
          emailVerified: true,
          mustChangePassword: true,
          mustEnrollTwoFactor: true,
        });

        const credentialRow = await db.select({
          accountId: account.accountId,
          providerId: account.providerId,
          issuer: account.issuer,
          password: account.password,
        }).from(account).where(eq(account.id, "invited_admin_account")).get();
        expect(credentialRow).toMatchObject({
          accountId: "invited_admin",
          providerId: "credential",
          issuer: "local:credential",
        });
        expect(await verifyPassword({
          hash: credentialRow?.password ?? "",
          password,
        })).toBe(true);
        await expect(db.select({ id: session.id })
          .from(session)
          .where(eq(session.userId, "invited_admin")))
          .resolves.toEqual([]);
        if (d1Binding) {
          const { createAuth } = await import("./auth");
          const auth = createAuth({
            DB: d1Binding,
            DATABASE_PROVIDER: "d1",
            BETTER_AUTH_SECRET: "credential-conformance-secret-at-least-32-characters",
            BETTER_AUTH_URL: "https://credential-conformance.example.test",
          } as unknown as Env);
          const signIn = await auth.api.signInEmail({
            body: { email: "invited@example.test", password },
          });
          expect(signIn.token).toEqual(expect.any(String));
          await expect(db.select({ id: session.id })
            .from(session)
            .where(eq(session.token, signIn.token!))
            .get()).resolves.toEqual(expect.objectContaining({ id: expect.any(String) }));
        }
        await expect(db.select({ id: adminInvitations.id })
          .from(adminInvitations)
          .where(eq(adminInvitations.id, "invite_conformance"))
          .get()).resolves.toEqual({ id: "invite_conformance" });
        await expect(db.select({ id: userRoles.id })
          .from(userRoles)
          .where(eq(userRoles.id, "invite_role_conformance"))
          .get()).resolves.toEqual({ id: "invite_role_conformance" });

        const duplicate = await prepareCredentialIdentity({
          userId: "duplicate_admin",
          accountRowId: "duplicate_admin_account",
          name: "Duplicate Admin",
          email: "INVITED@example.test",
          password,
          createdAt,
        });
        await expect(createInvitedAdminCredentialAccount(db, duplicate, {
          invitedByUserId: "inviter",
          invitationId: "duplicate_invite",
        })).rejects.toBeInstanceOf(CredentialIdentityConflictError);
        await expect(db.select({ id: account.id })
          .from(account)
          .where(eq(account.id, "duplicate_admin_account"))
          .get()).resolves.toBeUndefined();
      } finally {
        sqlite.close();
      }
    });

    it("creates the first admin with its claim or rolls the whole batch back", async () => {
      const { db, sqlite } = await createHarness(provider);
      const createdAt = new Date("2026-08-03T00:00:00.000Z");
      const nowSeconds = 1_900_000_000;

      try {
        await db.insert(adminSetupClaims).values({
          singletonKey: "first_admin",
          status: "processing",
          claimId: "active_claim",
          claimExpiresAt: nowSeconds + 60,
          createdAt: nowSeconds,
          updatedAt: nowSeconds,
        });
        const credential = await prepareCredentialIdentity({
          userId: "first_admin",
          accountRowId: "first_admin_account",
          name: "First Admin",
          email: "FIRST@EXAMPLE.TEST",
          password: "FirstAdminPassword123!",
          createdAt,
        });

        await completeAdminSetupClaimWithCredentialIdentity(
          db,
          { singletonKey: "first_admin", claimId: "active_claim" },
          credential,
          { nowSeconds },
        );

        await expect(db.select({
          role: user.role,
          isSuperAdmin: user.isSuperAdmin,
          emailVerified: user.emailVerified,
        }).from(user).where(eq(user.id, "first_admin")).get()).resolves.toEqual({
          role: "admin",
          isSuperAdmin: true,
          emailVerified: true,
        });
        await expect(db.select({
          status: adminSetupClaims.status,
          claimId: adminSetupClaims.claimId,
          completedUserId: adminSetupClaims.completedUserId,
        }).from(adminSetupClaims).where(eq(
          adminSetupClaims.singletonKey,
          "first_admin",
        )).get()).resolves.toEqual({
          status: "completed",
          claimId: null,
          completedUserId: "first_admin",
        });
      } finally {
        sqlite.close();
      }

      const expired = await createHarness(provider);
      try {
        await expired.db.insert(adminSetupClaims).values({
          singletonKey: "first_admin",
          status: "processing",
          claimId: "expired_claim",
          claimExpiresAt: nowSeconds - 1,
          createdAt: nowSeconds - 120,
          updatedAt: nowSeconds - 120,
        });
        const credential = await prepareCredentialIdentity({
          userId: "orphan_admin",
          accountRowId: "orphan_admin_account",
          name: "Orphan Admin",
          email: "orphan@example.test",
          password: "OrphanAdminPassword123!",
          createdAt,
        });

        await expect(completeAdminSetupClaimWithCredentialIdentity(
          expired.db,
          { singletonKey: "first_admin", claimId: "expired_claim" },
          credential,
          { nowSeconds },
        )).rejects.toBeInstanceOf(ConflictError);
        await expect(expired.db.select({ id: user.id })
          .from(user)
          .where(eq(user.id, "orphan_admin"))
          .get()).resolves.toBeUndefined();
        await expect(expired.db.select({ id: account.id })
          .from(account)
          .where(eq(account.id, "orphan_admin_account"))
          .get()).resolves.toBeUndefined();
      } finally {
        expired.sqlite.close();
      }
    });
  },
);
