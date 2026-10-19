import { lazy, Suspense, type ComponentProps } from "react";
import { useWatch } from "react-hook-form";
import type { DigitalDeliveryCard as DigitalDeliveryCardType } from "./DigitalDeliveryCard";
import type { GiftCardProductCard as GiftCardProductCardType } from "./GiftCardProductCard";
import type { AttributesSection as AttributesSectionType } from "./AttributesSection";
import type { ProductSearchListing as ProductSearchListingType } from "./ProductSearchListing";

// The cards under the variants (digital delivery, gift card, attributes, search
// listing) sit below everything a product needs first. Their code and words
// load right after the page, and each holds its place with a quiet box (no
// pulse) the height of the closed card, so nothing above or below moves.
const loadDigital = () => import("./DigitalDeliveryCard");
const loadGiftCard = () => import("./GiftCardProductCard");
const loadAttributes = () => import("./AttributesSection");
const loadSearchListing = () => import("./ProductSearchListing");
void loadDigital().catch(() => {});
void loadGiftCard().catch(() => {});
void loadAttributes().catch(() => {});
void loadSearchListing().catch(() => {});

const DigitalDeliveryCard = lazy(() => loadDigital().then((module) => ({ default: module.DigitalDeliveryCard })));
const GiftCardProductCard = lazy(() => loadGiftCard().then((module) => ({ default: module.GiftCardProductCard })));
const AttributesSection = lazy(() => loadAttributes().then((module) => ({ default: module.AttributesSection })));
const ProductSearchListing = lazy(() => loadSearchListing().then((module) => ({ default: module.ProductSearchListing })));

/** Digital delivery draws nothing for a gift card, so the box exists only when the card will. */
export function LazyDigitalDeliveryCard(props: ComponentProps<typeof DigitalDeliveryCardType>) {
  const isGiftCard = useWatch({ control: props.form.control, name: "isGiftCard" });
  if (isGiftCard) return null;
  return (
    <Suspense fallback={<div className="min-h-22" aria-hidden />}>
      <DigitalDeliveryCard {...props} />
    </Suspense>
  );
}

export function LazyGiftCardProductCard(props: ComponentProps<typeof GiftCardProductCardType>) {
  return (
    <Suspense fallback={<div className="min-h-22" aria-hidden />}>
      <GiftCardProductCard {...props} />
    </Suspense>
  );
}

export function LazyAttributesSection(props: ComponentProps<typeof AttributesSectionType>) {
  return (
    <Suspense fallback={<div className="min-h-19" aria-hidden />}>
      <AttributesSection {...props} />
    </Suspense>
  );
}

export function LazyProductSearchListing(props: ComponentProps<typeof ProductSearchListingType>) {
  return (
    <Suspense fallback={<div className="min-h-60" aria-hidden />}>
      <ProductSearchListing {...props} />
    </Suspense>
  );
}
