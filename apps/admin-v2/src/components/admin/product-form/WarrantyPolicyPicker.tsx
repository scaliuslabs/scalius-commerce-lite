// The Warranty card's body, loaded lazily: the policy select ("No warranty"
// first), the chosen policy's buyer-facing line and "Manage policies". An
// archived policy the product still points at stays shown, marked archived;
// other archived policies can't be picked.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select";
import { Skeleton } from "@/components/ui/skeleton";
import { useMessages } from "~/i18n";
import { warrantyMessages } from "~/i18n/warranty";
import { warrantyPoliciesQueryOptions } from "../warranty/warranty-api";
import { warrantySummary } from "../warranty/warranty-format";
import type { ProductFormValues } from "./types";

const NONE = "none";

export function WarrantyPolicyPicker({ form, readOnly }: {
  form: UseFormReturn<ProductFormValues>;
  readOnly: boolean;
}) {
  const t = useMessages(warrantyMessages);
  const value = useWatch({ control: form.control, name: "warrantyPolicyId" });
  const { data: policies, isError } = useQuery(warrantyPoliciesQueryOptions(true));
  if (!policies && !isError) return <Skeleton className="h-9 w-full" />;

  const list = policies ?? [];
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
    <div className="space-y-2">
      <SearchableSelect
        id="product-warranty-policy"
        ariaLabel={t("policy")}
        options={options}
        value={value ?? NONE}
        disabled={readOnly}
        placeholder={t("choose")}
        searchPlaceholder={t("searchPolicies")}
        emptyMessage={t("noPolicies")}
        onValueChange={(next) =>
          form.setValue("warrantyPolicyId", next === NONE ? null : next, { shouldDirty: true })}
      />
      {selected ? <p className="text-body text-muted-foreground">{warrantySummary(t, selected)}</p> : null}
      <Link to="/admin/settings/policies/warranty" className="inline-block text-body text-link hover:underline">
        {t("managePolicies")}
      </Link>
    </div>
  );
}
