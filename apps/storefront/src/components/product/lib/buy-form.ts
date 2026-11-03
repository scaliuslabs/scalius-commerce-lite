// The product page's buy form (ProductSummary.astro): one real form posting
// to `/buy/<slug>`. Its quantity, buttons, purchase options, the
// no-JavaScript picker and a product_main skin's `buyVariant` buttons sit
// outside it and join it with `form=`.
import { HOST_ID_PREFIX } from "@scalius/shared/plugins/host-id";

/**
 * The buy form's id, under the host's id prefix (`HOST_ID_PREFIX`), which
 * app markup can never carry: no app form or element can take over the
 * `form=` association of the form's parts.
 */
export const BUY_FORM_ID = `${HOST_ID_PREFIX}buy-form`;

/**
 * The SKU fields a buy form post can carry. The POST handler reads them by
 * name, strongest first, never by their order in the body: the pressed
 * button's own SKU (a skin's `buyVariant`), the no-JavaScript picker, the
 * form's own field (the SKU the page opened on, kept current by the script).
 */
export const BUY_FORM_VARIANT_FIELDS = {
  button: "variant.button",
  picker: "variant.picker",
  form: "variant",
} as const;
