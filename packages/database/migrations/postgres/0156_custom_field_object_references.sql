ALTER TABLE "custom_field_definitions" DROP CONSTRAINT "custom_field_definitions_type_check";
--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_type_check" CHECK("type" IN ('single_line_text', 'multi_line_text', 'integer', 'decimal', 'boolean', 'date', 'date_time', 'url', 'color', 'json', 'money', 'product_reference', 'variant_reference', 'collection_reference', 'media_reference', 'object_reference', 'list.single_line_text', 'list.multi_line_text', 'list.integer', 'list.decimal', 'list.date', 'list.date_time', 'list.url', 'list.color', 'list.money', 'list.product_reference', 'list.variant_reference', 'list.collection_reference', 'list.media_reference', 'list.object_reference'));
--> statement-breakpoint
INSERT INTO scalius_schema_migrations (version, name, source_sha256) VALUES (156, '0156_custom_field_object_references', '801e0c8d279cdc8a0df80ddea09bfecf60f9592fa2bf10f5fed1728e3d1bf4da');
