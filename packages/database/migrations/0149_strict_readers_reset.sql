-- The platform's readers are strict now: a stored shape that changed is reset
-- instead of read through a compatibility path. This migration removes only the
-- rows those readers would reject (valid rows are never touched):
--   T1 theme documents that are not version 9, or version 9 documents that still
--      name a removed block choice, with the history and restore points that go
--      with them; the preview sessions follow the published row.
--   T2 the removed built-in courier ids (`pathao`, `steadfast`) become the
--      Bangladesh pack's. Tracking links and courier names the removed
--      mapping supplied are written onto the shipments, and the delivery rows
--      are switched off with empty keys: the keys are the pack's settings.
--   T3 the removed `sslcommerz` payment id becomes `scalius.bangladesh:sslcommerz`
--      on orders, payments, attempts and settings documents; the old gateway
--      document goes.
--   T4 the SMS document keeps only an app provider id.
--   T5 checkout attempts that never committed (their request hash changed) and
--      abandoned checkouts in the old top-level `items` shape.
--   T6 plaintext two-factor recovery rows.
--   T7 ledger version 1 inventory movements that no document references.
-- Fraud-checker rows are encrypted whole, so SQL cannot see their provider type:
-- an unqualified one reads as absent and the merchant adds the checker again.
-- >>> T1 theme: reset the rows the strict reader rejects (not a version 9 document, or one that still names a removed choice)
DELETE FROM `theme_preview_sessions`
WHERE NOT EXISTS (SELECT 1 FROM `theme_settings` WHERE (`colors` LIKE '{"version":9,%' AND NOT (`colors` LIKE '%"buyBox":{"variant":"spec"%' OR `colors` LIKE '%"buyBox":{"variant":"tech"%' OR `colors` LIKE '%"buyBox":{"variant":"retail"%' OR `colors` LIKE '%"buyBox":{"variant":"mall"%' OR `colors` LIKE '%"buyBox":{"variant":"essentials"%' OR `colors` LIKE '%"buyBox":{"variant":"boutique"%' OR `colors` LIKE '%"buyBox":{"variant":"showcase"%' OR `colors` LIKE '%"buyBox":{"variant":"fashion"%' OR `colors` LIKE '%"buyBox":{"variant":"heritage"%' OR `colors` LIKE '%"buyBox":{"variant":"digital"%' OR `colors` LIKE '%"variant":"boutique-inline"%' OR `colors` LIKE '%"variant":"showcase-simple"%' OR `colors` LIKE '%"variant":"fashion-department"%' OR `colors` LIKE '%"variant":"heritage-nav"%' OR `colors` LIKE '%"variant":"spec-two-row"%' OR `colors` LIKE '%"variant":"tech-rounded"%' OR `colors` LIKE '%"variant":"marketplace-search"%' OR `colors` LIKE '%"variant":"marketplace-light"%' OR `colors` LIKE '%"variant":"mall-departments"%' OR `colors` LIKE '%"variant":"mall-search"%' OR `colors` LIKE '%"variant":"retail-pill"%' OR `colors` LIKE '%"variant":"grocery-shell"%' OR `colors` LIKE '%"variant":"minimal-columns"%' OR `colors` LIKE '%"variant":"product-widgets"%' OR `colors` LIKE '%"variant":"support-dark"%' OR `colors` LIKE '%"variant":"brand-black"%' OR `colors` LIKE '%"variant":"newsletter-grey"%' OR `colors` LIKE '%"variant":"app-banner"%' OR `colors` LIKE '%"phoneBar":"bottom"%' OR `colors` LIKE '%"frequently-bought-together"%' OR `colors` LIKE '%"layout":"app-panel"%' OR `colors` LIKE '%"layout":"story-cards"%' OR `colors` LIKE '%"template":"spec-catalogue"%' OR `colors` LIKE '%"template":"rounded-tech"%' OR `colors` LIKE '%"template":"heritage-editorial"%' OR `colors` LIKE '%"template":"fashion-value"%' OR `colors` LIKE '%"template":"mass-retail"%')));
--> statement-breakpoint
DELETE FROM `theme_settings_drafts`
WHERE NOT (`theme` LIKE '{"version":9,%' AND NOT (`theme` LIKE '%"buyBox":{"variant":"spec"%' OR `theme` LIKE '%"buyBox":{"variant":"tech"%' OR `theme` LIKE '%"buyBox":{"variant":"retail"%' OR `theme` LIKE '%"buyBox":{"variant":"mall"%' OR `theme` LIKE '%"buyBox":{"variant":"essentials"%' OR `theme` LIKE '%"buyBox":{"variant":"boutique"%' OR `theme` LIKE '%"buyBox":{"variant":"showcase"%' OR `theme` LIKE '%"buyBox":{"variant":"fashion"%' OR `theme` LIKE '%"buyBox":{"variant":"heritage"%' OR `theme` LIKE '%"buyBox":{"variant":"digital"%' OR `theme` LIKE '%"variant":"boutique-inline"%' OR `theme` LIKE '%"variant":"showcase-simple"%' OR `theme` LIKE '%"variant":"fashion-department"%' OR `theme` LIKE '%"variant":"heritage-nav"%' OR `theme` LIKE '%"variant":"spec-two-row"%' OR `theme` LIKE '%"variant":"tech-rounded"%' OR `theme` LIKE '%"variant":"marketplace-search"%' OR `theme` LIKE '%"variant":"marketplace-light"%' OR `theme` LIKE '%"variant":"mall-departments"%' OR `theme` LIKE '%"variant":"mall-search"%' OR `theme` LIKE '%"variant":"retail-pill"%' OR `theme` LIKE '%"variant":"grocery-shell"%' OR `theme` LIKE '%"variant":"minimal-columns"%' OR `theme` LIKE '%"variant":"product-widgets"%' OR `theme` LIKE '%"variant":"support-dark"%' OR `theme` LIKE '%"variant":"brand-black"%' OR `theme` LIKE '%"variant":"newsletter-grey"%' OR `theme` LIKE '%"variant":"app-banner"%' OR `theme` LIKE '%"phoneBar":"bottom"%' OR `theme` LIKE '%"frequently-bought-together"%' OR `theme` LIKE '%"layout":"app-panel"%' OR `theme` LIKE '%"layout":"story-cards"%' OR `theme` LIKE '%"template":"spec-catalogue"%' OR `theme` LIKE '%"template":"rounded-tech"%' OR `theme` LIKE '%"template":"heritage-editorial"%' OR `theme` LIKE '%"template":"fashion-value"%' OR `theme` LIKE '%"template":"mass-retail"%'))
  OR NOT EXISTS (SELECT 1 FROM `theme_settings` WHERE (`colors` LIKE '{"version":9,%' AND NOT (`colors` LIKE '%"buyBox":{"variant":"spec"%' OR `colors` LIKE '%"buyBox":{"variant":"tech"%' OR `colors` LIKE '%"buyBox":{"variant":"retail"%' OR `colors` LIKE '%"buyBox":{"variant":"mall"%' OR `colors` LIKE '%"buyBox":{"variant":"essentials"%' OR `colors` LIKE '%"buyBox":{"variant":"boutique"%' OR `colors` LIKE '%"buyBox":{"variant":"showcase"%' OR `colors` LIKE '%"buyBox":{"variant":"fashion"%' OR `colors` LIKE '%"buyBox":{"variant":"heritage"%' OR `colors` LIKE '%"buyBox":{"variant":"digital"%' OR `colors` LIKE '%"variant":"boutique-inline"%' OR `colors` LIKE '%"variant":"showcase-simple"%' OR `colors` LIKE '%"variant":"fashion-department"%' OR `colors` LIKE '%"variant":"heritage-nav"%' OR `colors` LIKE '%"variant":"spec-two-row"%' OR `colors` LIKE '%"variant":"tech-rounded"%' OR `colors` LIKE '%"variant":"marketplace-search"%' OR `colors` LIKE '%"variant":"marketplace-light"%' OR `colors` LIKE '%"variant":"mall-departments"%' OR `colors` LIKE '%"variant":"mall-search"%' OR `colors` LIKE '%"variant":"retail-pill"%' OR `colors` LIKE '%"variant":"grocery-shell"%' OR `colors` LIKE '%"variant":"minimal-columns"%' OR `colors` LIKE '%"variant":"product-widgets"%' OR `colors` LIKE '%"variant":"support-dark"%' OR `colors` LIKE '%"variant":"brand-black"%' OR `colors` LIKE '%"variant":"newsletter-grey"%' OR `colors` LIKE '%"variant":"app-banner"%' OR `colors` LIKE '%"phoneBar":"bottom"%' OR `colors` LIKE '%"frequently-bought-together"%' OR `colors` LIKE '%"layout":"app-panel"%' OR `colors` LIKE '%"layout":"story-cards"%' OR `colors` LIKE '%"template":"spec-catalogue"%' OR `colors` LIKE '%"template":"rounded-tech"%' OR `colors` LIKE '%"template":"heritage-editorial"%' OR `colors` LIKE '%"template":"fashion-value"%' OR `colors` LIKE '%"template":"mass-retail"%')));
--> statement-breakpoint
DELETE FROM `theme_settings_versions`
WHERE NOT ((`theme` LIKE '{"version":9,%' OR `theme` LIKE '%"theme":{"version":9,%') AND NOT (`theme` LIKE '%"buyBox":{"variant":"spec"%' OR `theme` LIKE '%"buyBox":{"variant":"tech"%' OR `theme` LIKE '%"buyBox":{"variant":"retail"%' OR `theme` LIKE '%"buyBox":{"variant":"mall"%' OR `theme` LIKE '%"buyBox":{"variant":"essentials"%' OR `theme` LIKE '%"buyBox":{"variant":"boutique"%' OR `theme` LIKE '%"buyBox":{"variant":"showcase"%' OR `theme` LIKE '%"buyBox":{"variant":"fashion"%' OR `theme` LIKE '%"buyBox":{"variant":"heritage"%' OR `theme` LIKE '%"buyBox":{"variant":"digital"%' OR `theme` LIKE '%"variant":"boutique-inline"%' OR `theme` LIKE '%"variant":"showcase-simple"%' OR `theme` LIKE '%"variant":"fashion-department"%' OR `theme` LIKE '%"variant":"heritage-nav"%' OR `theme` LIKE '%"variant":"spec-two-row"%' OR `theme` LIKE '%"variant":"tech-rounded"%' OR `theme` LIKE '%"variant":"marketplace-search"%' OR `theme` LIKE '%"variant":"marketplace-light"%' OR `theme` LIKE '%"variant":"mall-departments"%' OR `theme` LIKE '%"variant":"mall-search"%' OR `theme` LIKE '%"variant":"retail-pill"%' OR `theme` LIKE '%"variant":"grocery-shell"%' OR `theme` LIKE '%"variant":"minimal-columns"%' OR `theme` LIKE '%"variant":"product-widgets"%' OR `theme` LIKE '%"variant":"support-dark"%' OR `theme` LIKE '%"variant":"brand-black"%' OR `theme` LIKE '%"variant":"newsletter-grey"%' OR `theme` LIKE '%"variant":"app-banner"%' OR `theme` LIKE '%"phoneBar":"bottom"%' OR `theme` LIKE '%"frequently-bought-together"%' OR `theme` LIKE '%"layout":"app-panel"%' OR `theme` LIKE '%"layout":"story-cards"%' OR `theme` LIKE '%"template":"spec-catalogue"%' OR `theme` LIKE '%"template":"rounded-tech"%' OR `theme` LIKE '%"template":"heritage-editorial"%' OR `theme` LIKE '%"template":"fashion-value"%' OR `theme` LIKE '%"template":"mass-retail"%'))
  OR NOT EXISTS (SELECT 1 FROM `theme_settings` WHERE (`colors` LIKE '{"version":9,%' AND NOT (`colors` LIKE '%"buyBox":{"variant":"spec"%' OR `colors` LIKE '%"buyBox":{"variant":"tech"%' OR `colors` LIKE '%"buyBox":{"variant":"retail"%' OR `colors` LIKE '%"buyBox":{"variant":"mall"%' OR `colors` LIKE '%"buyBox":{"variant":"essentials"%' OR `colors` LIKE '%"buyBox":{"variant":"boutique"%' OR `colors` LIKE '%"buyBox":{"variant":"showcase"%' OR `colors` LIKE '%"buyBox":{"variant":"fashion"%' OR `colors` LIKE '%"buyBox":{"variant":"heritage"%' OR `colors` LIKE '%"buyBox":{"variant":"digital"%' OR `colors` LIKE '%"variant":"boutique-inline"%' OR `colors` LIKE '%"variant":"showcase-simple"%' OR `colors` LIKE '%"variant":"fashion-department"%' OR `colors` LIKE '%"variant":"heritage-nav"%' OR `colors` LIKE '%"variant":"spec-two-row"%' OR `colors` LIKE '%"variant":"tech-rounded"%' OR `colors` LIKE '%"variant":"marketplace-search"%' OR `colors` LIKE '%"variant":"marketplace-light"%' OR `colors` LIKE '%"variant":"mall-departments"%' OR `colors` LIKE '%"variant":"mall-search"%' OR `colors` LIKE '%"variant":"retail-pill"%' OR `colors` LIKE '%"variant":"grocery-shell"%' OR `colors` LIKE '%"variant":"minimal-columns"%' OR `colors` LIKE '%"variant":"product-widgets"%' OR `colors` LIKE '%"variant":"support-dark"%' OR `colors` LIKE '%"variant":"brand-black"%' OR `colors` LIKE '%"variant":"newsletter-grey"%' OR `colors` LIKE '%"variant":"app-banner"%' OR `colors` LIKE '%"phoneBar":"bottom"%' OR `colors` LIKE '%"frequently-bought-together"%' OR `colors` LIKE '%"layout":"app-panel"%' OR `colors` LIKE '%"layout":"story-cards"%' OR `colors` LIKE '%"template":"spec-catalogue"%' OR `colors` LIKE '%"template":"rounded-tech"%' OR `colors` LIKE '%"template":"heritage-editorial"%' OR `colors` LIKE '%"template":"fashion-value"%' OR `colors` LIKE '%"template":"mass-retail"%')));
--> statement-breakpoint
DELETE FROM `theme_restore_points`
WHERE NOT ((`theme` LIKE '{"version":9,%' OR `theme` LIKE '%"theme":{"version":9,%') AND NOT (`theme` LIKE '%"buyBox":{"variant":"spec"%' OR `theme` LIKE '%"buyBox":{"variant":"tech"%' OR `theme` LIKE '%"buyBox":{"variant":"retail"%' OR `theme` LIKE '%"buyBox":{"variant":"mall"%' OR `theme` LIKE '%"buyBox":{"variant":"essentials"%' OR `theme` LIKE '%"buyBox":{"variant":"boutique"%' OR `theme` LIKE '%"buyBox":{"variant":"showcase"%' OR `theme` LIKE '%"buyBox":{"variant":"fashion"%' OR `theme` LIKE '%"buyBox":{"variant":"heritage"%' OR `theme` LIKE '%"buyBox":{"variant":"digital"%' OR `theme` LIKE '%"variant":"boutique-inline"%' OR `theme` LIKE '%"variant":"showcase-simple"%' OR `theme` LIKE '%"variant":"fashion-department"%' OR `theme` LIKE '%"variant":"heritage-nav"%' OR `theme` LIKE '%"variant":"spec-two-row"%' OR `theme` LIKE '%"variant":"tech-rounded"%' OR `theme` LIKE '%"variant":"marketplace-search"%' OR `theme` LIKE '%"variant":"marketplace-light"%' OR `theme` LIKE '%"variant":"mall-departments"%' OR `theme` LIKE '%"variant":"mall-search"%' OR `theme` LIKE '%"variant":"retail-pill"%' OR `theme` LIKE '%"variant":"grocery-shell"%' OR `theme` LIKE '%"variant":"minimal-columns"%' OR `theme` LIKE '%"variant":"product-widgets"%' OR `theme` LIKE '%"variant":"support-dark"%' OR `theme` LIKE '%"variant":"brand-black"%' OR `theme` LIKE '%"variant":"newsletter-grey"%' OR `theme` LIKE '%"variant":"app-banner"%' OR `theme` LIKE '%"phoneBar":"bottom"%' OR `theme` LIKE '%"frequently-bought-together"%' OR `theme` LIKE '%"layout":"app-panel"%' OR `theme` LIKE '%"layout":"story-cards"%' OR `theme` LIKE '%"template":"spec-catalogue"%' OR `theme` LIKE '%"template":"rounded-tech"%' OR `theme` LIKE '%"template":"heritage-editorial"%' OR `theme` LIKE '%"template":"fashion-value"%' OR `theme` LIKE '%"template":"mass-retail"%'));
--> statement-breakpoint
DELETE FROM `theme_settings`
WHERE NOT (`colors` LIKE '{"version":9,%' AND NOT (`colors` LIKE '%"buyBox":{"variant":"spec"%' OR `colors` LIKE '%"buyBox":{"variant":"tech"%' OR `colors` LIKE '%"buyBox":{"variant":"retail"%' OR `colors` LIKE '%"buyBox":{"variant":"mall"%' OR `colors` LIKE '%"buyBox":{"variant":"essentials"%' OR `colors` LIKE '%"buyBox":{"variant":"boutique"%' OR `colors` LIKE '%"buyBox":{"variant":"showcase"%' OR `colors` LIKE '%"buyBox":{"variant":"fashion"%' OR `colors` LIKE '%"buyBox":{"variant":"heritage"%' OR `colors` LIKE '%"buyBox":{"variant":"digital"%' OR `colors` LIKE '%"variant":"boutique-inline"%' OR `colors` LIKE '%"variant":"showcase-simple"%' OR `colors` LIKE '%"variant":"fashion-department"%' OR `colors` LIKE '%"variant":"heritage-nav"%' OR `colors` LIKE '%"variant":"spec-two-row"%' OR `colors` LIKE '%"variant":"tech-rounded"%' OR `colors` LIKE '%"variant":"marketplace-search"%' OR `colors` LIKE '%"variant":"marketplace-light"%' OR `colors` LIKE '%"variant":"mall-departments"%' OR `colors` LIKE '%"variant":"mall-search"%' OR `colors` LIKE '%"variant":"retail-pill"%' OR `colors` LIKE '%"variant":"grocery-shell"%' OR `colors` LIKE '%"variant":"minimal-columns"%' OR `colors` LIKE '%"variant":"product-widgets"%' OR `colors` LIKE '%"variant":"support-dark"%' OR `colors` LIKE '%"variant":"brand-black"%' OR `colors` LIKE '%"variant":"newsletter-grey"%' OR `colors` LIKE '%"variant":"app-banner"%' OR `colors` LIKE '%"phoneBar":"bottom"%' OR `colors` LIKE '%"frequently-bought-together"%' OR `colors` LIKE '%"layout":"app-panel"%' OR `colors` LIKE '%"layout":"story-cards"%' OR `colors` LIKE '%"template":"spec-catalogue"%' OR `colors` LIKE '%"template":"rounded-tech"%' OR `colors` LIKE '%"template":"heritage-editorial"%' OR `colors` LIKE '%"template":"fashion-value"%' OR `colors` LIKE '%"template":"mass-retail"%'));
-- <<< T1
--> statement-breakpoint
-- >>> T2 couriers: the pack's courier ids replace the removed built-in ones; the old keys are the pack's settings now
UPDATE `delivery_shipments` SET `tracking_url` = 'https://merchant.pathao.com/tracking?consignment_id=' || `tracking_id`
WHERE `provider_type` = 'pathao' AND `tracking_url` IS NULL AND `tracking_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `delivery_shipments` SET `tracking_url` = 'https://steadfast.com.bd/t/' || `tracking_id`
WHERE `provider_type` = 'steadfast' AND `tracking_url` IS NULL AND `tracking_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `delivery_shipments` SET `courier_name` = CASE `provider_type` WHEN 'pathao' THEN 'Pathao' ELSE 'Steadfast' END
WHERE `provider_type` IN ('pathao', 'steadfast') AND (`courier_name` IS NULL OR `courier_name` = '');
--> statement-breakpoint
UPDATE `delivery_shipments` SET `provider_type` = 'scalius.bangladesh:' || `provider_type`
WHERE `provider_type` IN ('pathao', 'steadfast');
--> statement-breakpoint
UPDATE `delivery_providers`
SET `type` = 'scalius.bangladesh:' || `type`, `credentials` = '{}', `config` = '{}', `is_active` = 0,
    `last_test_attempt_at` = NULL, `last_test_success_at` = NULL, `last_test_failure_at` = NULL, `last_test_success_fingerprint` = NULL
WHERE `type` IN ('pathao', 'steadfast');
-- <<< T2
--> statement-breakpoint
-- >>> T3 payments: SSLCommerz is the pack's provider only; the old document and the removed id go
UPDATE `orders` SET `payment_method` = 'scalius.bangladesh:sslcommerz' WHERE `payment_method` = 'sslcommerz';
--> statement-breakpoint
UPDATE `order_payments` SET `payment_method` = 'scalius.bangladesh:sslcommerz' WHERE `payment_method` = 'sslcommerz';
--> statement-breakpoint
UPDATE `payment_session_attempts` SET `gateway` = 'scalius.bangladesh:sslcommerz' WHERE `gateway` = 'sslcommerz';
--> statement-breakpoint
UPDATE `refund_attempts` SET `gateway` = 'scalius.bangladesh:sslcommerz' WHERE `gateway` = 'sslcommerz';
--> statement-breakpoint
UPDATE `checkout_attempts` SET `payment_method` = 'scalius.bangladesh:sslcommerz' WHERE `payment_method` = 'sslcommerz';
--> statement-breakpoint
UPDATE `settings` SET `value` = REPLACE(`value`, '"sslcommerz"', '"scalius.bangladesh:sslcommerz"'), `revision` = `revision` + 1
WHERE `value` LIKE '%"sslcommerz"%' AND `category` <> 'sslcommerz';
--> statement-breakpoint
DELETE FROM `settings` WHERE `category` = 'sslcommerz';
-- <<< T3
--> statement-breakpoint
-- >>> T4 sms: the choice is an app provider id and nothing else is kept in the document
UPDATE `settings` SET `value` = json_object('activeProvider', CASE WHEN instr(json_extract(`value`, '$.activeProvider'), ':') > 0 THEN json_extract(`value`, '$.activeProvider') ELSE '' END), `revision` = `revision` + 1
WHERE `category` = 'sms' AND `key` = 'document' AND json_valid(`value`) AND `value` <> json_object('activeProvider', CASE WHEN instr(json_extract(`value`, '$.activeProvider'), ':') > 0 THEN json_extract(`value`, '$.activeProvider') ELSE '' END);
-- <<< T4
--> statement-breakpoint
-- >>> T5 checkout attempts: the request hash changed, so an attempt that never committed cannot be retried or replayed
DELETE FROM `checkout_attempts` WHERE `status` <> 'committed';
--> statement-breakpoint
DELETE FROM `abandoned_checkouts`
WHERE `checkout_data` NOT LIKE '%"cart":%' AND `checkout_data` LIKE '%"items":%';
-- <<< T5
--> statement-breakpoint
-- >>> T6 two-factor recovery codes are stored encrypted; a plaintext row (a JSON list) is reset, so its owner enrols again
DELETE FROM `two_factor` WHERE `backup_codes` LIKE '[%';
-- <<< T6
--> statement-breakpoint
-- >>> T7 inventory ledger: version 1 movements have no counter facts and nothing reads them any more (a movement a document still names stays)
DELETE FROM `inventory_movements`
WHERE `ledger_version` = 1
  AND `id` NOT IN (SELECT `movement_id` FROM `inventory_operations` WHERE `movement_id` IS NOT NULL)
  AND `id` NOT IN (SELECT `movement_id` FROM `inventory_transfer_movements`)
  AND `id` NOT IN (SELECT `inventory_movement_id` FROM `order_return_receipt_lines` WHERE `inventory_movement_id` IS NOT NULL)
  AND `id` NOT IN (SELECT `movement_id` FROM `purchase_order_receipt_lines`);
-- <<< T7
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (149, '0149_strict_readers_reset', 'baf742367eff349777d07762e938980de263094ac2721e7c6c027ab6f0510c25');
