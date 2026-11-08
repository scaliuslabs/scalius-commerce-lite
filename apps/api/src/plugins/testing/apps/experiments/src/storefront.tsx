/** @jsxImportSource @scalius/plugin-sdk/storefront */
// The delivery note the island varies: the control is in the cached markup,
// so a buyer without JavaScript or consent sees it, and nothing shifts.

import { Island, defineStorefront, type ComponentProps } from "@scalius/plugin-sdk/storefront";

function DeliveryNote(props: ComponentProps) {
  if (props.target !== "product.buy_box.after") return null;
  return (
    <Island name="note" props={{}} hydrate="load">
      <p class="acme-note" data-variant="control">Free delivery over ৳2,000</p>
    </Island>
  );
}

export default defineStorefront({ components: { delivery_note: DeliveryNote } });
