/**
 * Data Migration Script: Collections Schema Update
 *
 * This script migrates existing collections data from the old schema to the new unified schema:
 * - Moves categoryId field into config.categoryIds array
 * - Merges with config.specificCategoryIds if present
 * - Ensures config.productIds exists (from config.specificProductIds)
 * - Sets default values for missing fields
 *
 * Run this BEFORE running drizzle migrations to drop the categoryId column
 *
 * Usage: tsx migrations/migrate-collections-data.ts
 */

import { createClient } from "@libsql/client";
import * as fs from "fs";
import * as path from "path";

// Load environment variables from .env file
function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const envFile = fs.readFileSync(envPath, "utf8");
    envFile.split("\n").forEach((line) => {
      const match = line.match(/^([^=:#]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim().replace(/^["']|["']$/g, "");
        process.env[key] = value;
      }
    });
  }
}

loadEnv();

interface OldConfig {
  featuredProductId?: string;
  specificProductIds?: string[];
  specificCategoryIds?: string[];
  maxProducts?: number;
  title?: string;
  subtitle?: string;
}

interface NewConfig {
  categoryIds: string[];
  productIds: string[];
  featuredProductId?: string;
  maxProducts: number;
  title?: string;
  subtitle?: string;
}

async function migrateCollections() {
  console.log("🚀 Starting collections data migration...\n");

  // Create database client
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN!,
  });

  try {
    // Fetch all collections
    const result = await db.execute(
      "SELECT id, name, type, category_id, config FROM collections WHERE deleted_at IS NULL"
    );

    console.log(`📊 Found ${result.rows.length} collections to migrate\n`);

    if (result.rows.length === 0) {
      console.log("✅ No collections to migrate");
      return;
    }

    let successCount = 0;
    let errorCount = 0;

    // Process each collection
    for (const row of result.rows) {
      const id = row.id as string;
      const name = row.name as string;
      const categoryId = row.category_id as string | null;
      const configStr = row.config as string;

      try {
        // Parse old config
        const oldConfig: OldConfig = JSON.parse(configStr);

        // Build new config
        const newConfig: NewConfig = {
          categoryIds: [],
          productIds: oldConfig.specificProductIds || [],
          featuredProductId: oldConfig.featuredProductId,
          maxProducts: oldConfig.maxProducts || 8,
          title: oldConfig.title,
          subtitle: oldConfig.subtitle,
        };

        // Merge category IDs
        const categoryIdSet = new Set<string>();

        // Add from old categoryId field
        if (categoryId) {
          categoryIdSet.add(categoryId);
        }

        // Add from old config.specificCategoryIds
        if (oldConfig.specificCategoryIds && oldConfig.specificCategoryIds.length > 0) {
          oldConfig.specificCategoryIds.forEach(id => categoryIdSet.add(id));
        }

        newConfig.categoryIds = Array.from(categoryIdSet);

        // Update the collection
        await db.execute({
          sql: "UPDATE collections SET config = ? WHERE id = ?",
          args: [JSON.stringify(newConfig), id],
        });

        console.log(`✅ Migrated: "${name}" (${id})`);
        console.log(`   - Category IDs: ${newConfig.categoryIds.join(", ") || "none"}`);
        console.log(`   - Product IDs: ${newConfig.productIds.length} products`);
        console.log("");

        successCount++;
      } catch (error) {
        console.error(`❌ Error migrating collection "${name}" (${id}):`, error);
        errorCount++;
      }
    }

    console.log("\n" + "=".repeat(50));
    console.log(`✅ Successfully migrated: ${successCount}`);
    if (errorCount > 0) {
      console.log(`❌ Errors: ${errorCount}`);
    }
    console.log("=".repeat(50));
    console.log("\n✨ Data migration complete!");
    console.log("\n📝 Next steps:");
    console.log("   1. Review the migrated data in your database");
    console.log("   2. Run: pnpm db:generate");
    console.log("   3. Run: pnpm db:migrate");
    console.log("   4. The categoryId column will be dropped\n");

  } catch (error) {
    console.error("❌ Migration failed:", error);
    throw error;
  } finally {
    db.close();
  }
}

// Run migration
migrateCollections()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
