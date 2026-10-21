-- App-owned catalogue content (the stable app API's
-- dashboard.resources.app_content.delete): the app that created a product,
-- category, brand, collection or media file, written by the platform when the
-- app's create operation succeeds. An app permanently deletes only what it
-- created, and only from the trash. Private operational state: no public read
-- touches it.
CREATE TABLE "app_resource_owners" (
	"resource_type" text COLLATE "C" NOT NULL,
	"resource_id" text COLLATE "C" NOT NULL,
	"plugin_id" text COLLATE "C" NOT NULL,
	"created_at" bigint DEFAULT (cast(strftime('%s','now') as bigint)) NOT NULL,
	PRIMARY KEY("resource_type", "resource_id"),
	CONSTRAINT "app_resource_owners_type_check" CHECK("app_resource_owners"."resource_type" IN ('product', 'category', 'brand', 'collection', 'media')),
	CONSTRAINT "app_resource_owners_plugin_shape" CHECK(length("app_resource_owners"."plugin_id") BETWEEN 3 AND 100 AND "app_resource_owners"."plugin_id" !~ '[^a-z0-9.-]' AND strpos("app_resource_owners"."plugin_id", '.') > 1 AND strpos("app_resource_owners"."plugin_id", '.') < length("app_resource_owners"."plugin_id"))
);
--> statement-breakpoint
CREATE INDEX "app_resource_owners_plugin_idx" ON "app_resource_owners" ("plugin_id");
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (165, '0165_app_resource_owners', 'edb157b0afaef9bf112a064ee0cad556e4c6207149fa2f98a0bc25d9bacbc15c');
