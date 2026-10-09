// The Warranty card's body, loaded lazily: the policy select ("No warranty"
// first), the chosen policy's buyer-facing line and "Manage policies". An
// archived policy the product still points at stays shown, marked archived;
// other archived policies can't be picked.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { SearchableSelect, type SearchableSelectOption } from "@/components/ui/searchable-select";
import { Field } from "@/components/ui/field";
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
    <div className="flex flex-col items-start gap-3">
      <Field id="product-warranty-policy" className="self-stretch" help={selected ? warrantySummary(t, selected) : undefined}>
        <SearchableSelect
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
      </Field>
      <Link to="/admin/settings/policies/warranty" className="inline-flex min-h-6 items-center rounded-md text-body text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {t("managePolicies")}
      </Link>
    </div>
  );
}
