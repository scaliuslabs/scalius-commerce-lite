export interface ProductActionPresentation {
  disabled: boolean;
  label: string;
  ariaLabel: string;
}

export interface ProductActionsPresentation {
  addToCart: ProductActionPresentation;
  buyNow: ProductActionPresentation;
}

export function getProductActionsPresentation(input: {
  productName: string;
  exactVariantAvailable: boolean;
  anyVariantAvailable: boolean;
}): ProductActionsPresentation {
  const productName = input.productName.trim() || "Product";

  if (!input.anyVariantAvailable) {
    const ariaLabel = `Unavailable — ${productName}`;
    return {
      addToCart: { disabled: true, label: "Unavailable", ariaLabel },
      buyNow: { disabled: true, label: "Unavailable", ariaLabel },
    };
  }

  if (!input.exactVariantAvailable) {
    return {
      addToCart: {
        disabled: true,
        label: "Select Options",
        ariaLabel: `Select Options — choose an available ${productName} option`,
      },
      buyNow: {
        disabled: true,
        label: "Buy Now",
        ariaLabel: `Buy Now — select an available ${productName} option first`,
      },
    };
  }

  return {
    addToCart: {
      disabled: false,
      label: "Add to Cart",
      ariaLabel: `Add to Cart — ${productName}`,
    },
    buyNow: {
      disabled: false,
      label: "Buy Now",
      ariaLabel: `Buy Now — ${productName}`,
    },
  };
}
