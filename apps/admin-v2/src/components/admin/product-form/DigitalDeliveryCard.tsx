import React from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { Skeleton } from "@/components/ui/skeleton";
import { useMessages } from "~/i18n";
import { digitalCardMessages } from "~/i18n/digital-card";
import { CollapsibleCard } from "./CollapsibleCard";
import { DIGITAL_CARD_ID } from "./digital-stock";
import type { ProductFormValues } from "./types";

// Loaded only once a digital product's card is open, so physical products never download it.
const DigitalDeliveryPanel = React.lazy(() =>
  import("./DigitalDeliveryPanel").then((module) => ({ default: module.DigitalDeliveryPanel })));

/**
 * Shopify Digital Downloads' card (Wave B §3.5, §9.1): the files a digital
 * product delivers and its licence-key pools. Always listed by title; open
 * for a digital product (or one with digital variants), closed otherwise.
 * Gift cards deliver codes instead (the Gift card card).
 */
export function DigitalDeliveryCard({ form, productId, readOnly }: {
  form: UseFormReturn<ProductFormValues>;
  /** Unset while the product is being added (files attach to a saved product). */
  productId: string | undefined;
  readOnly: boolean;
}) {
  const t = useMessages(digitalCardMessages);
  const [mode, isGiftCard] = useWatch({ control: form.control, name: ["fulfillmentKind", "isGiftCard"] });
  if (isGiftCard) return null;
  const digital = mode === "digital" || mode === "mixed";
  return (
    <CollapsibleCard
      id={DIGITAL_CARD_ID}
      title={t("title")}
      description={digital ? t("description") : undefined}
      defaultOpen={digital}
      summary={digital ? null : <p className="text-body text-muted-foreground">{t("notDigital")}</p>}
    >
      {!digital ? (
        <p className="text-body text-muted-foreground">{t("notDigitalHelp")}</p>
      ) : productId ? (
        <React.Suspense fallback={<Skeleton className="h-24 w-full" />}>
          <DigitalDeliveryPanel productId={productId} readOnly={readOnly} />
        </React.Suspense>
      ) : (
        <p className="text-body text-muted-foreground">{t("saveFirst")}</p>
      )}
    </CollapsibleCard>
  );
}
