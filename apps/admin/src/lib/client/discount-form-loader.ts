const formMap: Record<string, string> = {
  amount_off_products: "amount-off-products-form",
  amount_off_order: "amount-off-order-form",
  free_shipping: "free-shipping-form",
};

// Mapping for lazy loading components
const formComponentMap: Record<string, () => Promise<void>> = {
  amount_off_products: async () => {
    const container = document.getElementById("amount-off-products-form");
    const placeholder = document.getElementById(
      "lazy-amount-off-products-placeholder"
    );
    if (container && placeholder) {
      const [module, React, ReactDOM] = await Promise.all([
        import("@/components/admin/discount/amount-off-products"),
        import("react"),
        import("react-dom/client"),
      ]);

      // Create a new div to render the React component into
      const mountPoint = document.createElement("div");
      container.appendChild(mountPoint);

      // Remove placeholder
      placeholder.remove();

      // Mount the component
      const { AmountOffProductsForm } = module;
      ReactDOM.createRoot(mountPoint).render(
        React.createElement(AmountOffProductsForm, {})
      );
    }
  },
  amount_off_order: async () => {
    const container = document.getElementById("amount-off-order-form");
    const placeholder = document.getElementById(
      "lazy-amount-off-order-placeholder"
    );
    if (container && placeholder) {
      const [module, React, ReactDOM] = await Promise.all([
        import("@/components/admin/discount/AmountOffOrderForm"),
        import("react"),
        import("react-dom/client"),
      ]);

      // Create a new div to render the React component into
      const mountPoint = document.createElement("div");
      container.appendChild(mountPoint);

      // Remove placeholder
      placeholder.remove();

      // Mount the component
      const { AmountOffOrderForm } = module;
      ReactDOM.createRoot(mountPoint).render(
        React.createElement(AmountOffOrderForm, {})
      );
    }
  },
  free_shipping: async () => {
    const container = document.getElementById("free-shipping-form");
    const placeholder = document.getElementById(
      "lazy-free-shipping-placeholder"
    );
    if (container && placeholder) {
      const [module, React, ReactDOM] = await Promise.all([
        import("@/components/admin/discount/FreeShippingForm"),
        import("react"),
        import("react-dom/client"),
      ]);

      // Create a new div to render the React component into
      const mountPoint = document.createElement("div");
      container.appendChild(mountPoint);

      // Remove placeholder
      placeholder.remove();

      // Mount the component
      const { FreeShippingForm } = module;
      ReactDOM.createRoot(mountPoint).render(
        React.createElement(FreeShippingForm, {})
      );
    }
  },
};

type DiscountPageState = {
  cleanup?: () => void;
  hasPageLoadListener?: boolean;
};

type DiscountPageWindow = Window & {
  __discountsNewPageState?: DiscountPageState;
};

let typeSelectorElement: HTMLElement | null = null;
let changeTypeSection: HTMLElement | null = null;
let formLoaded: Record<string, boolean> = {};

// Function to handle showing/hiding forms AND the selector/button
function handleFormDisplay(newSelectedType: string | null): void {
  const isFormSelected = newSelectedType !== null && newSelectedType in formMap;

  // Hide/Show Type Selector
  if (typeSelectorElement) {
    if (isFormSelected) {
      typeSelectorElement.classList.add("hidden");
    } else {
      typeSelectorElement.classList.remove("hidden");
    }
  }

  // Hide/Show Change Type Button Section
  if (changeTypeSection) {
    if (isFormSelected) {
      changeTypeSection.classList.remove("hidden");
    } else {
      changeTypeSection.classList.add("hidden");
    }
  }

  // Hide all forms first
  Object.values(formMap).forEach((formId) => {
    const formElement = document.getElementById(formId);
    if (formElement) {
      formElement.classList.add("hidden");
    }
  });

  // Show the selected form if valid
  if (isFormSelected && newSelectedType) {
    const formId = formMap[newSelectedType];
    const formElement = document.getElementById(formId);
    if (formElement) {
      formElement.classList.remove("hidden");

      // Lazy load the component if not already loaded
      if (!formLoaded[newSelectedType]) {
        formComponentMap[newSelectedType]?.();
        formLoaded[newSelectedType] = true;
      }
    }
  }
}

// Function to show the type selector and hide forms/button
function showTypeSelector(): void {
  handleFormDisplay(null); // Passing null hides all forms and shows selector
}

function initDiscountPage(): void {
  const win = window as DiscountPageWindow;
  const pageState = win.__discountsNewPageState!;

  // Clear previous listeners before wiring up current DOM.
  pageState.cleanup?.();
  pageState.cleanup = undefined;

  const pageContainer = document.getElementById("discount-form-container");
  if (!pageContainer) {
    typeSelectorElement = null;
    changeTypeSection = null;
    formLoaded = {};
    return;
  }

  // Get elements for the current page instance.
  typeSelectorElement = document.getElementById("discount-type-selector");
  changeTypeSection = document.getElementById("change-type-section");
  const changeTypeButton = document.getElementById(
    "change-discount-type-button"
  );
  formLoaded = {};

  const onDiscountTypeSelected = (event: Event) => {
    const selectedType = (event as CustomEvent<{ type: string }>)?.detail?.type;
    if (selectedType) {
      handleFormDisplay(selectedType);
    }
  };

  const onChangeTypeClick = () => {
    showTypeSelector();
  };

  // Attach listener to the DiscountTypeSelector component.
  if (typeSelectorElement) {
    typeSelectorElement.addEventListener(
      "discountTypeSelected",
      onDiscountTypeSelected as EventListener
    );
  } else {
    console.error("Could not find #discount-type-selector element.");
  }

  // Attach listener to the Change Type button.
  if (changeTypeButton) {
    changeTypeButton.addEventListener("click", onChangeTypeClick);
  } else {
    console.error("Could not find #change-discount-type-button element.");
  }

  pageState.cleanup = () => {
    typeSelectorElement?.removeEventListener(
      "discountTypeSelected",
      onDiscountTypeSelected as EventListener
    );
    changeTypeButton?.removeEventListener("click", onChangeTypeClick);
  };
}

export function initDiscountFormLoader(): void {
  const win = window as DiscountPageWindow;
  win.__discountsNewPageState ??= {};

  if (!win.__discountsNewPageState.hasPageLoadListener) {
    document.addEventListener("astro:page-load", initDiscountPage);
    win.__discountsNewPageState.hasPageLoadListener = true;
  }

  initDiscountPage();
}
