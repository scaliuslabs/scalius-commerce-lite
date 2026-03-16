type VariantScrollState = {
  hasPageLoadListener: boolean;
  lastHandledKey: string;
  scrollTimer: ReturnType<typeof setTimeout> | null;
};

type VariantScrollWindow = Window & {
  __adminProductsEditVariantScrollState?: VariantScrollState;
};

export function initVariantScroll(): void {
  const win = window as VariantScrollWindow;
  const stateKey = "__adminProductsEditVariantScrollState";

  const runtime: VariantScrollState = (win[stateKey] ??= {
    hasPageLoadListener: false,
    lastHandledKey: "",
    scrollTimer: null,
  });

  const maybeScrollToVariants = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const isNewProduct = urlParams.get("new") === "true";
    const navigationKey = `${window.location.pathname}${window.location.search}`;

    if (!isNewProduct || runtime.lastHandledKey === navigationKey) {
      return;
    }
    runtime.lastHandledKey = navigationKey;

    if (runtime.scrollTimer) {
      clearTimeout(runtime.scrollTimer);
    }

    runtime.scrollTimer = setTimeout(() => {
      const variantSection = document.getElementById("variant-section");
      if (variantSection) {
        variantSection.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }
    }, 500);
  };

  if (!runtime.hasPageLoadListener) {
    document.addEventListener("astro:page-load", maybeScrollToVariants);
    runtime.hasPageLoadListener = true;
  }

  maybeScrollToVariants();
}
