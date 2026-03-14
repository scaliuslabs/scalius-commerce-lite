-- Migration 0019: Add missing indexes and document FK constraints
--
-- NOTE: SQLite does not support ALTER TABLE ADD CONSTRAINT FOREIGN KEY.
-- FK constraints are defined in the Drizzle schema (.references()) and enforced
-- at the ORM layer + on new table creation. This migration only adds indexes
-- that improve query performance on FK columns and common query patterns.
--
-- FK constraints added to Drizzle schema (ORM-level enforcement):
--   products.categoryId         -> categories.id          (SET NULL on delete)
--   productImages.productId     -> products.id            (CASCADE on delete)
--   productVariants.productId   -> products.id            (CASCADE on delete)
--   orderItems.productId        -> products.id            (SET NULL on delete)
--   orderItems.variantId        -> productVariants.id     (SET NULL on delete)
--   inventoryMovements.variantId-> productVariants.id     (SET NULL on delete)
--   inventoryMovements.orderId  -> orders.id              (SET NULL on delete)
--   deliveryLocations.parentId  -> deliveryLocations.id   (SET NULL on delete)
--   deliveryShipments.providerId-> deliveryProviders.id   (SET NULL on delete)
--   media.folderId              -> mediaFolders.id        (SET NULL on delete)
--   productLowStockAlerts.variantId -> productVariants.id (CASCADE on delete)
--   productLowStockAlerts.productId -> products.id        (CASCADE on delete)
--   discountProducts.productId  -> products.id            (CASCADE on delete)
--   discountCollections.collectionId -> collections.id    (CASCADE on delete)

-- ============================================================
-- Auth indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint

-- ============================================================
-- Customer indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS `customers_email_idx` ON `customers` (`email`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `customer_history_customer_id_idx` ON `customer_history` (`customer_id`);--> statement-breakpoint

-- ============================================================
-- Marketing indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS `discounts_code_idx` ON `discounts` (`code`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `discounts_deleted_at_idx` ON `discounts` (`deleted_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `discount_usage_discount_customer_idx` ON `discount_usage` (`discount_id`, `customer_id`);--> statement-breakpoint

-- ============================================================
-- System indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS `admin_fcm_tokens_user_id_idx` ON `admin_fcm_tokens` (`user_id`);--> statement-breakpoint

-- ============================================================
-- Content indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS `widget_history_widget_id_idx` ON `widget_history` (`widget_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pages_deleted_at_idx` ON `pages` (`deleted_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `widgets_deleted_at_idx` ON `widgets` (`deleted_at`);--> statement-breakpoint

-- ============================================================
-- Product indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS `product_attribute_values_product_id_idx` ON `product_attribute_values` (`product_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_rich_content_product_id_idx` ON `product_rich_content` (`product_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `products_deleted_at_idx` ON `products` (`deleted_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `categories_deleted_at_idx` ON `categories` (`deleted_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `collections_deleted_at_idx` ON `collections` (`deleted_at`);--> statement-breakpoint

-- ============================================================
-- Delivery indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS `delivery_shipments_provider_status_idx` ON `delivery_shipments` (`provider_id`, `status`);--> statement-breakpoint

-- ============================================================
-- Shipping methods soft-delete index
-- ============================================================
CREATE INDEX IF NOT EXISTS `shipping_methods_deleted_at_idx` ON `shipping_methods` (`deleted_at`);
