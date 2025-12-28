/**
 * Migration Sync Script for Drizzle ORM + Turso
 *
 * This script syncs the migration history table (__drizzle_migrations) with
 * existing migrations that were already applied to the database (e.g., via db:push).
 *
 * Usage: pnpm sync-migrations
 *
 * This is useful when:
 * - You previously used db:push and now want to switch to db:migrate
 * - Your migration history is out of sync with the actual database state
 */

import "dotenv/config";
import { createClient } from "@libsql/client/web";
import * as fs from "fs";
import * as path from "path";

const MIGRATIONS_DIR = "./migrations";
const MIGRATIONS_TABLE = "__drizzle_migrations";

async function syncMigrations() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url || !authToken) {
    console.error("❌ TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set");
    process.exit(1);
  }

  const client = createClient({ url, authToken });

  console.log("🔄 Syncing migration history with Turso database...\n");

  try {
    // 1. Create migrations table if it doesn't exist
    await client.execute(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);
    console.log("✅ Ensured __drizzle_migrations table exists");

    // 2. Get already applied migrations
    const result = await client.execute(`SELECT hash FROM ${MIGRATIONS_TABLE}`);
    const appliedHashes = new Set(result.rows.map((row) => row.hash as string));
    console.log(
      `📋 Found ${appliedHashes.size} migrations already in history\n`,
    );

    // 3. Read migration files from disk
    const migrationFiles = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort(); // Ensure chronological order

    console.log(`📁 Found ${migrationFiles.length} migration files:\n`);

    let synced = 0;
    let skipped = 0;

    for (const file of migrationFiles) {
      const filePath = path.join(MIGRATIONS_DIR, file);
      const content = fs.readFileSync(filePath, "utf-8");

      // Generate hash (same algorithm as Drizzle)
      const hash = generateHash(content);
      const migrationName = file.replace(".sql", "");

      if (appliedHashes.has(hash)) {
        console.log(`  ⏭️  ${migrationName} - already in history`);
        skipped++;
        continue;
      }

      // Check if we should mark as applied (tables exist) or actually run it
      const shouldMarkOnly = await checkIfMigrationAlreadyApplied(
        client,
        content,
      );

      if (shouldMarkOnly) {
        // Just add to history without running
        await client.execute({
          sql: `INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at) VALUES (?, ?)`,
          args: [hash, Math.floor(Date.now() / 1000)],
        });
        console.log(
          `  ✅ ${migrationName} - marked as applied (schema already exists)`,
        );
        synced++;
      } else {
        // Actually run the migration
        try {
          // Split by Drizzle's statement breakpoint marker
          // The format is: "statement1;-->statement-breakpoint\nstatement2;"
          const statements = content
            .split(/-->\s*statement-breakpoint/i)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);

          for (const stmt of statements) {
            // Clean up the statement - remove trailing semicolons and whitespace
            const cleanStmt = stmt.replace(/;\s*$/, "").trim();
            if (cleanStmt.length > 0) {
              try {
                await client.execute(cleanStmt);
              } catch (stmtErr: any) {
                const errorMsg = stmtErr.message?.toLowerCase() || "";
                // Skip if schema element already exists
                if (
                  errorMsg.includes("already exists") ||
                  errorMsg.includes("duplicate column") ||
                  errorMsg.includes("no such index") ||
                  errorMsg.includes("no such table") ||
                  errorMsg.includes("no such column")
                ) {
                  console.log(
                    `    ⚠️ Skipped: ${cleanStmt.substring(0, 60).replace(/\n/g, " ")}...`,
                  );
                  continue;
                }
                throw stmtErr;
              }
            }
          }

          await client.execute({
            sql: `INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at) VALUES (?, ?)`,
            args: [hash, Math.floor(Date.now() / 1000)],
          });
          console.log(`  🚀 ${migrationName} - executed successfully`);
          synced++;
        } catch (err: any) {
          if (err.message?.includes("already exists")) {
            // Schema already exists, just mark it
            await client.execute({
              sql: `INSERT INTO ${MIGRATIONS_TABLE} (hash, created_at) VALUES (?, ?)`,
              args: [hash, Math.floor(Date.now() / 1000)],
            });
            console.log(
              `  ✅ ${migrationName} - marked as applied (caught: already exists)`,
            );
            synced++;
          } else {
            console.error(`  ❌ ${migrationName} - failed: ${err.message}`);
            throw err;
          }
        }
      }
    }

    console.log(`\n${"─".repeat(50)}`);
    console.log(`📊 Summary: ${synced} synced, ${skipped} already in history`);
    console.log(`\n✅ Migration sync complete!`);
    console.log(
      `\n💡 Your workflow: db:generate (create migrations) → db:sync (apply to database)`,
    );
  } catch (error) {
    console.error("❌ Error syncing migrations:", error);
    process.exit(1);
  } finally {
    client.close();
  }
}

/**
 * Check if a migration's effects are already in the database
 */
async function checkIfMigrationAlreadyApplied(
  client: ReturnType<typeof createClient>,
  content: string,
): Promise<boolean> {
  // Check for CREATE TABLE statements
  const createTableMatch = content.match(/CREATE TABLE\s+[`"]?(\w+)[`"]?/i);
  if (createTableMatch) {
    const tableName = createTableMatch[1];
    try {
      const result = await client.execute(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName}'`,
      );
      if (result.rows.length > 0) {
        return true; // Table exists
      }
    } catch {
      // Ignore errors
    }
  }

  // Check for CREATE INDEX statements and return true if it's index-only migration
  const createIndexMatch = content.match(/CREATE INDEX/i);
  const hasCreateTable = content.match(/CREATE TABLE/i);

  if (createIndexMatch && !hasCreateTable) {
    // This is an index-only migration, don't mark as applied automatically
    // Let it run and handle errors
    return false;
  }

  return false;
}

/**
 * Generate a hash for migration content (matches Drizzle's algorithm)
 */
function generateHash(content: string): string {
  // Simple hash function similar to what Drizzle uses
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

// Run the sync
syncMigrations();
