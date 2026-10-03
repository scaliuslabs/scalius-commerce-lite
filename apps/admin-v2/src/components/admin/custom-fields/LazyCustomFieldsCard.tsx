import { lazy, Suspense, type ComponentProps } from "react";
import type { CustomFieldsCard as CustomFieldsCardType } from "./CustomFieldsCard";

// The Custom data card (its field inputs, the media picker's copy and the
// card's own save) loads just after the page that shows it: the order and
// product pages render without waiting for it.
const CustomFieldsCard = lazy(() => import("./CustomFieldsCard").then((module) => ({ default: module.CustomFieldsCard })));

/** The side column's Custom data card, downloaded with the page's other cards instead of before it. */
export function LazyCustomFieldsCard(props: ComponentProps<typeof CustomFieldsCardType>) {
  return (
    <Suspense fallback={null}>
      <CustomFieldsCard {...props} />
    </Suspense>
  );
}
