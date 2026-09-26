import { NativeSelect } from "@/components/ui/native-select";
import {
  LISTING_FILTER_TEMPLATE_IDS,
  LISTING_LAYOUT_TEMPLATE_IDS,
  PRODUCT_PAGE_TEMPLATE_IDS,
} from "@/lib/template-options";
import { useMessages } from "~/i18n";
import { catalogTemplateMessages } from "~/i18n/catalog-templates";

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
}: {
  id?: string;
  kind: "product" | "listing";
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const t = useMessages(catalogTemplateMessages);
  const known: Known = kind === "product"
    ? PRODUCT_PAGE_TEMPLATE_IDS
    : [...LISTING_LAYOUT_TEMPLATE_IDS, ...LISTING_FILTER_TEMPLATE_IDS];
  const label = (template: string) => t(`${kind === "product" ? "page" : "listing"}_${template}` as never);
  return (
    <NativeSelect
      id={id}
      value={value ?? ""}
      disabled={disabled}
      aria-label={t("template")}
      onValueChange={(next) => onChange(next || null)}
    >
      <option value="">{t("themeDefault")}</option>
      {value && !known.includes(value) ? <option value={value}>{t("unknownTemplate", { id: value })}</option> : null}
      {kind === "product" ? (
        PRODUCT_PAGE_TEMPLATE_IDS.map((template) => <option key={template} value={template}>{label(template)}</option>)
      ) : (
        <>
          <optgroup label={t("layouts")}>
            {LISTING_LAYOUT_TEMPLATE_IDS.map((template) => <option key={template} value={template}>{label(template)}</option>)}
          </optgroup>
          <optgroup label={t("filters")}>
            {LISTING_FILTER_TEMPLATE_IDS.map((template) => <option key={template} value={template}>{label(template)}</option>)}
          </optgroup>
        </>
      )}
    </NativeSelect>
  );
}
