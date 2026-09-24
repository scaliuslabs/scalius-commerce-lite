export interface ProductActionPresentation {
  disabled: boolean;
  label: string;
  ariaLabel: string;
}

export interface ProductActionsPresentation {
  addToCart: ProductActionPresentation;
  buyNow: ProductActionPresentation;
}

/** Product page copy from the active checkout language (layout `storefrontCopy`). */
export interface ProductActionCopy {
  addToCartText: string;
  buyNowText: string;
  unavailableText: string;
  chooseOptionText: string;
  fromPriceText: string;
  quantityLabelText: string;
  quantityLimitText: string;
  saleOfferText: string;
  saleOfferSpendText: string;
  freeBenefitText: string;
  percentBenefitText: string;
}

/**
 * Both purchase buttons stay enabled while the buyer is still choosing
 * options (a tap says which option is missing); they are disabled only when
 * nothing, or the exact chosen combination, can be bought.
 */
export function getProductActionsPresentation(input: {
  productName: string;
  anyVariantAvailable: boolean;
  /** The exact chosen (or linked) combination is sold out. */
  chosenVariantSoldOut?: boolean;
  copy: Pick<ProductActionCopy, "addToCartText" | "buyNowText" | "unavailableText">;
}): ProductActionsPresentation {
  const productName = input.productName.trim() || "Product";
  const copy = input.copy;
  const action = (label: string, disabled: boolean) => ({
    disabled,
    label,
    ariaLabel: `${label} — ${productName}`,
  });

  if (!input.anyVariantAvailable || input.chosenVariantSoldOut) {
    return {
      addToCart: action(copy.unavailableText, true),
      buyNow: action(copy.unavailableText, true),
    };
  }

  return {
    addToCart: action(copy.addToCartText, false),
    buyNow: action(copy.buyNowText, false),
  };
}
