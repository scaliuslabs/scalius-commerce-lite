// The product page's buy form (ProductSummary.astro): one real form posting
// to `/buy/<slug>`. Its quantity, buttons, purchase options, the
// no-JavaScript picker and a product_main skin's `buyVariant` buttons sit
// outside it and join it with `form=`.

/**
 * The buy form's id. No app markup can carry it: an app's ids start with
 * `<app name>-` (lowercase letters, digits and hyphens), and this id has an
 * underscore before its first hyphen, so no app form or element can take
 * over the `form=` association of the form's parts.
 */
export const BUY_FORM_ID = "sx_buy-form";

/**
 * A product_main skin's SKU controls the host bound to this form
 * (lib/extensions/purchase-controls.ts): `data-sx-bound`, which only the host
 * writes, on a `chooseVariant` control or a `buyVariant` button.
 */
export const SKIN_CHOOSE_CONTROL = "[data-sx-bound][data-choose-variant]";
export const SKIN_BUY_CONTROL = "[data-sx-bound][data-buy-variant]";

/** Form field names of the buyer inputs (ProductBuyerInputs.astro): `property.<key>`. */
export const BUYER_INPUT_FIELD_PREFIX = "property.";

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

/**
 * The purchase-option radios' field (ProductPurchaseOptions.astro): `purchaseOption`
 * while one app offers options, `purchaseOption.<app id>` per app when several do
 * (one radio group each, so a line can carry one option of each app).
 */
export const PURCHASE_OPTION_FIELD = "purchaseOption";

/** The radio group name of one app's options (`appId`), or of the one group (null). */
export function purchaseOptionFieldName(appId: string | null): string {
  return appId ? `${PURCHASE_OPTION_FIELD}.${appId}` : PURCHASE_OPTION_FIELD;
}
