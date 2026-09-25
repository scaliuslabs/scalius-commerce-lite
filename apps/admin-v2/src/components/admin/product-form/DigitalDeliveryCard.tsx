import React from "react";
import { useWatch, type UseFormReturn } from "react-hook-form";
import type { ProductFormValues } from "./types";

// Loaded only for digital products, so physical products never download it.
const DigitalDeliveryPanel = React.lazy(() =>
  import("./DigitalDeliveryPanel").then((module) => ({ default: module.DigitalDeliveryPanel })));

/**
 * Shopify Digital Downloads' card (Wave B §3.5, §9.1): the files a digital
 * product delivers and its licence-key pools. Shown when the product (or some
 * variant, with "set per variant") is digital; gift cards deliver codes instead.
 */
export function DigitalDeliveryCard({ form, productId, readOnly }: {
  form: UseFormReturn<ProductFormValues>;
  /** Unset while the product is being added (files attach to a saved product). */
  productId: string | undefined;
  readOnly: boolean;
}) {
  const [mode, isGiftCard] = useWatch({ control: form.control, name: ["fulfillmentKind", "isGiftCard"] });
  if (isGiftCard || (mode !== "digital" && mode !== "mixed")) return null;
  return (
    <React.Suspense fallback={null}>
      <DigitalDeliveryPanel productId={productId} readOnly={readOnly} />
    </React.Suspense>
  );
}
