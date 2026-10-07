// The product's sales channels (docs/MARKETS-DESIGN.md D6), Shopify's
// "Publishing" card under Status. The card shell is here; the channel list
// loads lazily, so the product editor's first download stays in budget.
import React from "react";
import type { UseFormReturn } from "react-hook-form";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import type { ProductFormValues } from "./types";

const PublishingChannels = React.lazy(() =>
  import("./PublishingChannels").then((module) => ({ default: module.PublishingChannels })));

export function PublishingCard({ form, readOnly }: {
  form: UseFormReturn<ProductFormValues>;
  readOnly: boolean;
}) {
  const t = useMessages(productMessages);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("publishing")}</CardTitle>
      </CardHeader>
      <CardContent>
        <React.Suspense fallback={<Skeleton className="h-40 w-full" />}>
          <PublishingChannels form={form} readOnly={readOnly} />
        </React.Suspense>
      </CardContent>
    </Card>
  );
}
