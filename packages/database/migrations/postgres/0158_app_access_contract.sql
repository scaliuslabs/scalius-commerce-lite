ALTER TABLE "webhook_subscriptions" ADD COLUMN "customer_data" text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
INSERT INTO "permissions" ("id", "name", "display_name", "description", "resource", "action", "category", "is_sensitive")
SELECT 'perm_products_adjust_stock', 'products.adjust_stock', 'Adjust Stock', 'Adjust, count and import on-hand quantities, and set them when saving products', 'products', 'adjust_stock', 'Products', 0
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "name" = 'products.adjust_stock');
--> statement-breakpoint
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT 'rpm_adjust_stock_' || "granted"."role_id", "granted"."role_id", "adjust"."id"
FROM "role_permissions" AS "granted"
JOIN "permissions" AS "edit" ON "edit"."id" = "granted"."permission_id" AND "edit"."name" = 'products.edit'
JOIN "permissions" AS "adjust" ON "adjust"."name" = 'products.adjust_stock'
WHERE NOT EXISTS (
  SELECT 1 FROM "role_permissions" AS "existing"
  WHERE "existing"."role_id" = "granted"."role_id" AND "existing"."permission_id" = "adjust"."id"
);
--> statement-breakpoint
INSERT INTO "user_permissions" ("id", "user_id", "permission_id", "granted", "assigned_by")
SELECT 'upm_adjust_stock_' || "direct"."user_id", "direct"."user_id", "adjust"."id", "direct"."granted", "direct"."assigned_by"
FROM "user_permissions" AS "direct"
JOIN "permissions" AS "edit" ON "edit"."id" = "direct"."permission_id" AND "edit"."name" = 'products.edit'
JOIN "permissions" AS "adjust" ON "adjust"."name" = 'products.adjust_stock'
WHERE NOT EXISTS (
  SELECT 1 FROM "user_permissions" AS "existing"
  WHERE "existing"."user_id" = "direct"."user_id" AND "existing"."permission_id" = "adjust"."id"
);
--> statement-breakpoint
UPDATE agent_grants
SET permissions_json = substr(rtrim(permissions_json), 1, length(rtrim(permissions_json)) - 1) || ',"products.adjust_stock"]'
WHERE position('"products.edit"' in permissions_json) > 0 AND position('"products.adjust_stock"' in permissions_json) = 0;
--> statement-breakpoint
UPDATE agent_device_authorizations
SET requested_permissions_json = substr(rtrim(requested_permissions_json), 1, length(rtrim(requested_permissions_json)) - 1) || ',"products.adjust_stock"]'
WHERE position('"products.edit"' in requested_permissions_json) > 0 AND position('"products.adjust_stock"' in requested_permissions_json) = 0;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (158, '0158_app_access_contract', '426ef68a6024a8e1a7f18f0bfc6defe19a0e35ef835f5acf1a049505af275493');
