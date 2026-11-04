// The Warranty card's body, loaded lazily: the policy select ("No warranty"
// first), the chosen policy's buyer-facing line and "Manage policies". An
// archived policy the product still points at stays shown, marked archived;
// other archived policies can't be picked. The policies load as a variant's
// warranty field loads them (useWarrantyPolicies).
import { Link } from "@tanstack/react-router";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select";
import { Field, ReadOnlyValue } from "@/components/ui/field";
import { standaloneLinkClassName } from "@/components/ui/link";
import { useMessages } from "~/i18n";
import { warrantyMessages } from "~/i18n/warranty";
import { useWarrantyPolicies } from "../warranty/use-warranty-policies";
import { warrantySummary } from "../warranty/warranty-format";
import type { ProductFormValues } from "./types";

const NONE = "none";

export function WarrantyPolicyPicker({ form, readOnly }: {
  form: UseFormReturn<ProductFormValues>;
  readOnly: boolean;
}) {
  const t = useMessages(warrantyMessages);
  const value = useWatch({ control: form.control, name: "warrantyPolicyId" });
  // A read-only "No warranty" names no policy: it shows at once.
  const { policies: list, placeholder, failed, failure } = useWarrantyPolicies(!(readOnly && value == null));
  if (placeholder) return placeholder;
  const selected = list.find((policy) => policy.id === value) ?? null;
  const options: SearchableSelectOption[] = [
    { value: NONE, label: t("none") },
    ...list
      .filter((policy) => !policy.archivedAt || policy.id === value)
      .map((policy) => ({
        value: policy.id,
        label: policy.archivedAt ? t("archivedPolicy", { name: policy.name }) : policy.name,
        description: warrantySummary(t, policy),
      })),
  ];

  return (
    <div className="flex flex-col items-start gap-3">
      {readOnly ? (
        <ReadOnlyValue
          label={t("policy")}
          value={value == null ? t("none") : selected
            ? (selected.archivedAt ? t("archivedPolicy", { name: selected.name }) : selected.name)
            : t(failed ? "loadFailed" : "policyUnavailable")}
          help={selected ? warrantySummary(t, selected) : undefined}
        />
      ) : (
        <Field id="product-warranty-policy" className="self-stretch" help={selected ? warrantySummary(t, selected) : undefined}>
          <SearchableSelect
            ariaLabel={t("policy")}
            triggerClassName="w-full"
            options={options}
            value={value ?? NONE}
            selectedLabel={value && !selected ? t(failed ? "loadFailed" : "policyUnavailable") : undefined}
            placeholder={t("choose")}
            searchPlaceholder={t("searchPolicies")}
            emptyMessage={t("noPolicies")}
            onValueChange={(next) =>
              form.setValue("warrantyPolicyId", next === NONE ? null : next, { shouldDirty: true })}
          />
        </Field>
      )}
      {/* "No warranty" stays a choice while the policies fail to load; the list says so, with Try again. */}
      {failure}
      <Link to="/admin/settings/policies/warranty" className={standaloneLinkClassName}>
        {t("managePolicies")}
      </Link>
    </div>
  );
}
