export interface ProductActionPresentation {
  disabled: boolean;
  label: string;
  ariaLabel: string;
}

export interface ProductActionsPresentation {
  addToCart: ProductActionPresentation;
  buyNow: ProductActionPresentation;
}

/** Button copy from the active checkout language (layout `storefrontCopy`). */
export interface ProductActionCopy {
  addToCartText: string;
  buyNowText: string;
  selectOptionsText: string;
  unavailableText: string;
}

export const DEFAULT_PRODUCT_ACTION_COPY: ProductActionCopy = {
  addToCartText: "Add to Cart",
  buyNowText: "Buy Now",
  selectOptionsText: "Select Options",
  unavailableText: "Unavailable",
};

export function getProductActionsPresentation(input: {
  productName: string;
  exactVariantAvailable: boolean;
  anyVariantAvailable: boolean;
  copy?: ProductActionCopy;
}): ProductActionsPresentation {
  const productName = input.productName.trim() || "Product";
  const copy = input.copy ?? DEFAULT_PRODUCT_ACTION_COPY;
  const action = (label: string, disabled: boolean) => ({
    disabled,
    label,
    ariaLabel: `${label} — ${productName}`,
  });

  if (!input.anyVariantAvailable) {
    return {
      addToCart: action(copy.unavailableText, true),
      buyNow: action(copy.unavailableText, true),
    };
  }

  if (!input.exactVariantAvailable) {
    return {
      addToCart: action(copy.selectOptionsText, true),
      buyNow: action(copy.buyNowText, true),
    };
  }

  return {
    addToCart: action(copy.addToCartText, false),
    buyNow: action(copy.buyNowText, false),
  };
}
