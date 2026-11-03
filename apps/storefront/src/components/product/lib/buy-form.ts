// The product page's buy form (ProductSummary.astro): one real form posting
// to `/buy/<slug>`. Its quantity, buttons, purchase options, the
// no-JavaScript picker and a product_main skin's `buyVariant` buttons sit
// outside it and join it with `form=`.

/** The buy form's id. */
export const BUY_FORM_ID = "product-buy-form";

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
