INSERT INTO "permissions" ("id", "name", "display_name", "description", "resource", "action", "category", "is_sensitive")
SELECT 'perm_orders_record_payment', 'orders.record_payment', 'Record Payments', 'Record money received against an invoice (bank transfer, cheque, cash)', 'orders', 'record_payment', 'Orders', 1
WHERE NOT EXISTS (SELECT 1 FROM "permissions" WHERE "name" = 'orders.record_payment');
--> statement-breakpoint
INSERT INTO "role_permissions" ("id", "role_id", "permission_id")
SELECT 'rpm_record_payment_' || "granted"."role_id", "granted"."role_id", "record"."id"
FROM "role_permissions" AS "granted"
JOIN "permissions" AS "edit" ON "edit"."id" = "granted"."permission_id" AND "edit"."name" = 'orders.edit'
JOIN "permissions" AS "record" ON "record"."name" = 'orders.record_payment'
WHERE NOT EXISTS (
  SELECT 1 FROM "role_permissions" AS "existing"
  WHERE "existing"."role_id" = "granted"."role_id" AND "existing"."permission_id" = "record"."id"
);
--> statement-breakpoint
INSERT INTO "user_permissions" ("id", "user_id", "permission_id", "granted", "assigned_by")
SELECT 'upm_record_payment_' || "direct"."user_id", "direct"."user_id", "record"."id", "direct"."granted", "direct"."assigned_by"
FROM "user_permissions" AS "direct"
JOIN "permissions" AS "edit" ON "edit"."id" = "direct"."permission_id" AND "edit"."name" = 'orders.edit'
JOIN "permissions" AS "record" ON "record"."name" = 'orders.record_payment'
WHERE NOT EXISTS (
  SELECT 1 FROM "user_permissions" AS "existing"
  WHERE "existing"."user_id" = "direct"."user_id" AND "existing"."permission_id" = "record"."id"
);
--> statement-breakpoint
UPDATE agent_grants
SET permissions_json = substr(rtrim(permissions_json), 1, length(rtrim(permissions_json)) - 1) || ',"orders.record_payment"]'
WHERE position('"orders.edit"' in permissions_json) > 0 AND position('"orders.record_payment"' in permissions_json) = 0;
--> statement-breakpoint
UPDATE agent_device_authorizations
SET requested_permissions_json = substr(rtrim(requested_permissions_json), 1, length(rtrim(requested_permissions_json)) - 1) || ',"orders.record_payment"]'
WHERE position('"orders.edit"' in requested_permissions_json) > 0 AND position('"orders.record_payment"' in requested_permissions_json) = 0;
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (166, '0166_record_payment_permission', 'c6fd2017f48946b361b564269611359aa5f1b15d152bedf45d78350ed7e26ddd');
