// The product's warranty (Wave B §5.3, §9.1): a policy select with its
// preview line and "Manage policies". The card shell is here; the select and
// the policy list load lazily, so the products/new bundle stays in budget.
import React from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import type { ProductFormValues } from "./types";

const WarrantyPolicyPicker = React.lazy(() =>
  import("./WarrantyPolicyPicker").then((module) => ({ default: module.WarrantyPolicyPicker })));

export function WarrantyCard({ form, readOnly }: {
  form: UseFormReturn<ProductFormValues>;
  readOnly: boolean;
}) {
  const t = useMessages(productMessages);
  const isGiftCard = useWatch({ control: form.control, name: "isGiftCard" });
  if (isGiftCard) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("warranty")}</CardTitle>
      </CardHeader>
      <CardContent>
        <React.Suspense fallback={<Skeleton className="h-9 w-full" />}>
          <WarrantyPolicyPicker form={form} readOnly={readOnly} />
        </React.Suspense>
      </CardContent>
    </Card>
  );
}
