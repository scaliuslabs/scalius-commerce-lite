import type { CheckoutLanguageData } from "../api/types";

function createStaticSvg(markup: string): SVGElement {
  const template = document.createElement("template");
  template.innerHTML = markup.trim();
  return template.content.firstElementChild as SVGElement;
}

export function renderEmptyCartState(
  container: HTMLElement,
  lang: CheckoutLanguageData,
): void {
  const wrapper = document.createElement("div");
  wrapper.className = "text-center py-8 px-4";

  const cartIcon = createStaticSvg(`
    <svg class="mx-auto h-12 w-12 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
    </svg>
  `);

  const title = document.createElement("h3");
  title.className = "mt-2 text-lg font-medium text-foreground";
  title.textContent = lang.languageData.emptyCartText;

  const message = document.createElement("p");
  message.className = "mt-1 text-sm text-muted-foreground";
  message.textContent =
    "Looks like you haven't added anything to your cart yet.";

  const actionWrapper = document.createElement("div");
  actionWrapper.className = "mt-6";

  const continueLink = document.createElement("a");
  continueLink.href = "/";
  continueLink.className =
    "inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-primary-foreground bg-primary hover:bg-primary/90";

  const backIcon = createStaticSvg(`
    <svg class="-ml-1 mr-2 h-5 w-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fill-rule="evenodd" d="M9.707 14.707a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 1.414L7.414 9H15a1 1 0 110 2H7.414l2.293 2.293a1 1 0 010 1.414z" clip-rule="evenodd" />
    </svg>
  `);
  continueLink.append(
    backIcon,
    document.createTextNode(lang.languageData.continueShoppingText),
  );
  actionWrapper.append(continueLink);

  wrapper.append(cartIcon, title, message, actionWrapper);
  container.replaceChildren(wrapper);
}
