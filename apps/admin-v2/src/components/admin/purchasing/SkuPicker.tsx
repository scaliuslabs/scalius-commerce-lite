import { useRef } from "react";
import { SearchableSelect, type SearchableSelectLoader } from "~/components/ui/searchable-select";
import { fetchInventory, type InventoryVariant } from "~/lib/api-query-options/inventory";
import { useMessages } from "~/i18n";
import { purchasingMessages } from "~/i18n/purchasing";
import { lineName } from "./purchasing-format";

const PAGE_SIZE = 20;

/**
 * Finds a SKU on the server (product, SKU or barcode) and hands it to the
 * document: each pick adds one line. SKUs already on the document stay in
 * the list, marked and not pickable. With `location` each option also says
 * how many are on hand there (a transfer's origin).
 */
export function SkuPicker({
  onPick,
  addedIds,
  location,
  disabled,
  id,
}: {
  onPick: (variant: InventoryVariant) => void;
  addedIds: ReadonlySet<string>;
  location?: { id: string; name: string } | null;
  disabled?: boolean;
  id?: string;
}) {
  const t = useMessages(purchasingMessages);
  // The full rows behind the options loaded so far, to hand over on pick.
  const loaded = useRef(new Map<string, InventoryVariant>());

  const load: SearchableSelectLoader = async ({ search, page }) => {
    const result = await fetchInventory({
      section: "variants",
      search: search || undefined,
      page,
      limit: PAGE_SIZE,
      sort: "productName",
      order: "asc",
      ...(location ? { locationId: location.id } : {}),
    });
    const variants = result.variants ?? [];
    for (const variant of variants) loaded.current.set(variant.id, variant);
    const pages = result.pagination?.totalPages ?? page;
    return {
      options: variants.map((variant) => {
        const added = addedIds.has(variant.id);
        return {
          value: variant.id,
          label: lineName(variant, t("unknownProduct")),
          description: added
            ? t("alreadyAdded", { sku: variant.sku })
            : location
              ? t("skuOptionOnHand", { sku: variant.sku, count: variant.locationOnHand ?? 0, location: location.name })
              : t("skuOption", { sku: variant.sku }),
          keywords: [variant.sku, variant.barcode ?? ""],
          disabled: added,
        };
      }),
      hasMore: page < pages,
    };
  };

  return (
    <SearchableSelect
      id={id}
      triggerClassName="w-full"
      value=""
      placeholder={t("searchToAdd")}
      searchPlaceholder={t("searchToAdd")}
      ariaLabel={t("searchToAdd")}
      disabled={disabled}
      load={load}
      // Which SKUs are added changes the options' marks, and the location their counts.
      queryKey={["purchasing", "sku-picker", location?.id ?? "", [...addedIds].sort().join(",")]}
      onValueChange={(value) => {
        const variant = loaded.current.get(value);
        if (variant && !addedIds.has(variant.id)) onPick(variant);
      }}
    />
  );
}
