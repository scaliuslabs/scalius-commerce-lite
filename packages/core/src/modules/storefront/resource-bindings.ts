import { brands, categories, collections, customFieldDefinitions, customFieldValues, pages, productBuyerState } from "@scalius/database/schema";
import { sql, type SQL } from "drizzle-orm";
import type { BindingResource, BindingResourceSelector } from "@scalius/shared/storefront-theme/bindings";
import { deps } from "../../cache-deps";

/** The public resource already selected by the buyer's page, in a template's cache key. */
export type { BindingResourceSelector } from "@scalius/shared/storefront-theme/bindings";

export function resourceProductFieldsSql(resource: BindingResourceSelector): SQL<string> {
  const { ownerType, id } = resource;
  deps.customFieldDefinitions(ownerType);
  const visible: Record<BindingResourceSelector["ownerType"], SQL> = {
    product: sql`EXISTS (SELECT 1 FROM ${productBuyerState} AS binding_owner WHERE binding_owner.product_id = ${id} AND binding_owner.is_public = 1)`,
    category: sql`EXISTS (SELECT 1 FROM ${categories} AS binding_owner WHERE binding_owner.id = ${id} AND binding_owner.status = 'published' AND binding_owner.deleted_at IS NULL)`,
    collection: sql`EXISTS (SELECT 1 FROM ${collections} AS binding_owner WHERE binding_owner.id = ${id} AND binding_owner.is_active = 1 AND binding_owner.deleted_at IS NULL)`,
    brand: sql`EXISTS (SELECT 1 FROM ${brands} AS binding_owner WHERE binding_owner.id = ${id} AND binding_owner.status = 'published' AND binding_owner.deleted_at IS NULL)`,
    page: sql`EXISTS (SELECT 1 FROM ${pages} AS binding_owner WHERE binding_owner.id = ${id} AND binding_owner.is_published = 1 AND binding_owner.deleted_at IS NULL AND (binding_owner.published_at IS NULL OR binding_owner.published_at <= unixepoch()))`,
  };
  if (ownerType === "product") deps.product(id);
  else if (ownerType === "category") deps.category(id);
  else if (ownerType === "collection") deps.collection(id);
  else if (ownerType === "brand") deps.brand(id);
  else deps.page(id);
  return sql<string>`(SELECT COALESCE(json_group_array(json_object(
    'namespace', binding_definition.namespace, 'key', binding_definition.key,
    'type', binding_definition.type, 'value', binding_value.value)), '[]')
    FROM ${customFieldValues} AS binding_value JOIN ${customFieldDefinitions} AS binding_definition ON binding_definition.id = binding_value.definition_id
    WHERE binding_value.owner_type = ${ownerType} AND binding_value.owner_id = ${id}
      AND binding_definition.storefront_visible = 1 AND ${visible[ownerType]}
      AND binding_definition.type IN ('product_reference', 'list.product_reference', 'collection_reference'))`;
}

export function readResourceProductFields(value: string | undefined): BindingResource | undefined {
  if (!value) return undefined;
  try {
    const rows = JSON.parse(value) as Array<{ namespace: string; key: string; type: string; value: string }>;
    return { customFields: rows.map((field) => ({ ...field, value: field.type === "list.product_reference" ? JSON.parse(field.value) as unknown : field.value })) };
  } catch { return undefined; }
}
