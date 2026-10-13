import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  LISTING_FILTER_TEMPLATE_IDS,
  LISTING_LAYOUT_TEMPLATE_IDS,
  PRODUCT_PAGE_TEMPLATE_IDS,
} from "@/lib/template-options";
import { useMessages } from "~/i18n";
import { catalogTemplateMessages } from "~/i18n/catalog-templates";
import { ReadOnlyValue } from "~/components/ui/field";

type Known = readonly string[];

/**
 * The template a product page or a listing uses; "" is the theme's default
 * (saved as null). A saved id the theme no longer offers stays selectable.
 */
export function TemplateSelect({
  id,
  kind,
  value,
  onChange,
  disabled,
  readOnly = false,
}: {
  id?: string;
  kind: "product" | "listing";
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  /** A saved label rather than a disabled picker; closes an existing picker on revocation. */
  readOnly?: boolean;
}) {
  const t = useMessages(catalogTemplateMessages);
  const known: Known = kind === "product"
    ? PRODUCT_PAGE_TEMPLATE_IDS
    : [...LISTING_LAYOUT_TEMPLATE_IDS, ...LISTING_FILTER_TEMPLATE_IDS];
  const label = (template: string) => t(`${kind === "product" ? "page" : "listing"}_${template}` as never);
  if (readOnly) return <ReadOnlyValue label={t("template")} value={!value ? t("themeDefault") : known.includes(value) ? label(value) : t("unknownTemplate", { id: value })} />;
  return (
    <SearchableSelect
      id={id}
      value={value ?? ""}
      disabled={disabled}
      ariaLabel={t("template")}
      onValueChange={(next) => onChange(next || null)}
      triggerClassName="w-full"
      options={[
        { value: "", label: t("themeDefault") },
        ...(value && !known.includes(value) ? [{ value, label: t("unknownTemplate", { id: value }) }] : []),
        ...(kind === "product"
          ? PRODUCT_PAGE_TEMPLATE_IDS.map((template) => ({ value: template, label: label(template) }))
          : [
              ...LISTING_LAYOUT_TEMPLATE_IDS.map((template) => ({ value: template, label: label(template), group: t("layouts") })),
              ...LISTING_FILTER_TEMPLATE_IDS.map((template) => ({ value: template, label: label(template), group: t("filters") })),
            ]),
      ]}
    />
  );
}
