import type { ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { customFieldItemType, isCustomFieldListType, type CustomFieldWireValue } from "@scalius/shared/custom-fields";
import { numberFormatter } from "@scalius/shared/locale-format";
import { ReadOnlyValue } from "~/components/ui/field";
import { usePermissions } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { dashboardNumberLocale, formatDateTime, formatNumber, useMessages } from "~/i18n";
import { customFieldMessages } from "~/i18n/custom-fields";
import { collectionsByIdsQueryOptions } from "~/lib/api-query-options/collections";
import type { CustomFieldEntry } from "~/lib/api-query-options/custom-fields";
import { productsByIdsQueryOptions } from "~/lib/api-query-options/products";

// Older Intl engines coerce strings to Number; retain exact saved digits there.
const exactDecimals = numberFormatter("en", { useGrouping: false, maximumFractionDigits: 9 })
  .format("9007199254740993.000000001" as unknown as number) === "9007199254740993.000000001";

function SavedReferences({ type, ids, list }: { type: "product_reference" | "collection_reference"; ids: string[]; list: boolean }) {
  const canView = usePermissions().hasPermission(type === "product_reference" ? PERMISSIONS.PRODUCTS_VIEW : PERMISSIONS.COLLECTIONS_VIEW);
  const uniqueIds = [...new Set(ids)];
  const batches = canView ? Array.from({ length: Math.ceil(uniqueIds.length / 90) }, (_, index) => uniqueIds.slice(index * 90, (index + 1) * 90)) : [];
  const products = useQueries({ queries: type === "product_reference" ? batches.map(productsByIdsQueryOptions) : [] });
  const collections = useQueries({ queries: type === "collection_reference" ? batches.map(collectionsByIdsQueryOptions) : [] });
  const names = new Map([
    ...products.flatMap((query) => query.isError ? [] : query.data?.products ?? []),
    ...collections.flatMap((query) => query.isError ? [] : query.data?.collections ?? []),
  ].map((record) => [record.id, record.name]));
  const values = ids.map((id) => names.get(id) || <code>{id}</code>);
  return list ? <ul className="space-y-1">{values.map((value, index) => <li key={index}>{value}</li>)}</ul> : values[0];
}

/** Saved wire values only: drafts must not become facts when permission changes. */
export function SavedCustomFieldValue({ field, label, help }: { field: CustomFieldEntry; label: ReactNode; help?: ReactNode }) {
  const t = useMessages(customFieldMessages);
  const { fmt } = useCurrency();
  const type = customFieldItemType(field.definition.type);
  const list = isCustomFieldListType(field.definition.type);
  const value = field.value;
  const items = list && Array.isArray(value) ? value : [value];
  const item = (saved: CustomFieldWireValue): ReactNode => {
    if (type === "json") return <pre className="whitespace-pre-wrap break-words font-mono">{JSON.stringify(saved, null, 2)}</pre>;
    if (saved === null || saved === "") return null;
    switch (type) {
      case "boolean": return saved ? t("yes") : t("no");
      case "integer": return formatNumber(saved as number);
      case "decimal": {
        // Intl accepts exact decimal strings; the ES2022 typings predate that overload.
        const format = numberFormatter(dashboardNumberLocale(), { maximumFractionDigits: 9 }).format as unknown as (value: string) => string;
        return exactDecimals ? format(saved as string) : saved as string;
      }
      case "money": return fmt(saved as number);
      case "date": return formatDateTime(new Date(`${saved}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
      case "date_time": return formatDateTime(new Date(saved as string), { dateStyle: "medium", timeStyle: "medium" });
      case "variant_reference":
      case "media_reference": return <code>{saved as string}</code>;
      default: return <span className="whitespace-pre-wrap">{saved as string}</span>;
    }
  };
  const empty = value === null || (type !== "json" && value === "") || (list && items.length === 0);
  const shown = empty ? null
    : type === "product_reference" || type === "collection_reference"
      ? <SavedReferences type={type} ids={items as string[]} list={list} />
      : list ? <ul className="space-y-1">{items.map((saved, index) => <li key={index}>{item(saved)}</li>)}</ul> : item(value);
  return <ReadOnlyValue label={label} value={shown} help={help} numeric={type === "integer" || type === "decimal" || type === "money"} />;
}
