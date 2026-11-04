// A variant's warranty, in the variant table's details (loaded lazily): the
// product's ("Same as product (…)"), a live policy of its own, or none. An
// archived policy the variant still names stays shown, marked archived; it
// sells without a warranty until the merchant picks another.
import { useFormContext, useWatch, type Control } from "react-hook-form";
import { Field, ReadOnlyValue } from "@/components/ui/field";
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { warrantyMessages } from "~/i18n/warranty";
import type { WarrantyPolicy } from "../../warranty/warranty-api";
import { useWarrantyPolicies } from "../../warranty/use-warranty-policies";
import { warrantySummary } from "../../warranty/warranty-format";
import type { ProductFormValues } from "../types";
import type { DraftVariant } from "./option-matrix-editor-model";

const INHERIT = "inherit";
const NONE = "none";

type FieldProps = {
  error?: string;
  readOnly: boolean;
  variant: DraftVariant;
  name: string;
  onChange: (patch: Partial<DraftVariant>) => void;
};

/** The product's own policy comes from the product form when there is one. */
export function VariantWarrantyField(props: FieldProps) {
  const form = useFormContext<ProductFormValues>() as ReturnType<typeof useFormContext<ProductFormValues>> | null;
  return form ? <WithProductPolicy control={form.control} {...props} /> : <WarrantySelect productPolicyId={null} {...props} />;
}

function WithProductPolicy({ control, ...props }: FieldProps & { control: Control<ProductFormValues> }) {
  const productPolicyId = useWatch({ control, name: "warrantyPolicyId" });
  return <WarrantySelect productPolicyId={productPolicyId ?? null} {...props} />;
}

function WarrantySelect({ readOnly, variant, name, error, onChange, productPolicyId }: FieldProps & { productPolicyId: string | null }) {
  const t = useMessages(warrantyMessages);
  const { policies: list, placeholder } = useWarrantyPolicies();
  if (placeholder) return placeholder;
  const policyName = (id: string | null) => {
    if (!id) return t("none");
    const policy = list.find((candidate) => candidate.id === id);
    if (!policy) return t("policyUnavailable");
    return policy.archivedAt ? t("archivedPolicy", { name: policy.name }) : policy.name;
  };
  const mode = variant.warrantyMode ?? "inherit";
  const ownId = mode === "policy" ? variant.warrantyPolicyId ?? null : null;
  const value = mode === "policy" && ownId ? ownId : mode === "none" ? NONE : INHERIT;
  const effective: WarrantyPolicy | undefined = list.find((policy) =>
    policy.id === (mode === "inherit" ? productPolicyId : ownId));
  const help = mode === "none" || !effective
    ? undefined
    : effective.archivedAt ? t("skuArchivedHelp") : warrantySummary(t, effective);
  const inheritLabel = t("sameAsProduct", { policy: policyName(productPolicyId) });
  const label = t("skuWarrantyFor", { name });

  if (readOnly) {
    return (
      <ReadOnlyValue
        label={t("card")}
        value={value === INHERIT ? inheritLabel : value === NONE ? t("none") : policyName(ownId)}
        help={help}
      />
    );
  }
  const options: SearchableSelectOption[] = [
    { value: INHERIT, label: inheritLabel },
    ...list
      .filter((policy) => !policy.archivedAt || policy.id === ownId)
      .map((policy) => ({
        value: policy.id,
        label: policy.archivedAt ? t("archivedPolicy", { name: policy.name }) : policy.name,
        description: warrantySummary(t, policy),
      })),
    { value: NONE, label: t("none") },
  ];
  return (
    <Field label={t("card")} help={help} error={error}>
      <SearchableSelect
        ariaLabel={label}
        triggerClassName="w-full"
        options={options}
        value={value}
        selectedLabel={ownId && !list.some((policy) => policy.id === ownId) ? policyName(ownId) : undefined}
        searchPlaceholder={t("searchPolicies")}
        emptyMessage={t("noPolicies")}
        onValueChange={(next) => onChange(next === INHERIT
          ? { warrantyMode: "inherit", warrantyPolicyId: null }
          : next === NONE
            ? { warrantyMode: "none", warrantyPolicyId: null }
            : { warrantyMode: "policy", warrantyPolicyId: next })}
      />
    </Field>
  );
}
