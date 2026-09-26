import { getApiV1AdminBrandsFormOptions } from "@scalius/api-client/sdk";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { apiData } from "@/lib/api";
import { queryKeys } from "@/lib/query-keys";
import { translate, useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { brandMessages } from "~/i18n/brands";

/** Live brands matching the typed search (the API returns up to 50, in name order). */
async function loadBrands({ search, signal }: { search: string; signal: AbortSignal }) {
  const data = await apiData(getApiV1AdminBrandsFormOptions({ query: { search: search || undefined }, signal }));
  return {
    options: data.brands.map((brand) => ({
      value: brand.id,
      label: brand.name,
      description: brand.status === "draft" ? translate(productMessages, "statusDraft") : undefined,
    })),
    hasMore: false,
  };
}

/** The product's brand (loaded after the page: it searches brands on the server). */
export default function BrandPicker({
  id,
  value,
  label,
  onChange,
}: {
  id: string;
  value: string | null;
  label: string | null;
  onChange: (value: string | null, label: string | null) => void;
}) {
  const t = useMessages(brandMessages);
  return (
    <SearchableSelect
      id={id}
      value={value ?? ""}
      selectedLabel={value ? label ?? undefined : undefined}
      clearable
      triggerClassName="w-full"
      load={loadBrands}
      queryKey={[...queryKeys.brands.formOptions(), "picker"]}
      placeholder={t("chooseBrand")}
      searchPlaceholder={t("searchBrands")}
      emptyMessage={t("noBrandsFound")}
      onValueChange={(next, option) => onChange(next || null, option?.label ?? null)}
    />
  );
}
