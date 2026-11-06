// The checkout's payment methods as the buyer chooses between them: one card
// per method (a radio in a radiogroup) and the chosen method's details (its
// test-mode notice, card form and the Pay button the page moves there). The
// theme's `checkout.paymentChoices` says how they look: `list`, one row per
// method with its details opening under it, or `tiles`, a grid of tiles with
// the chosen method's details under the grid. The page states the style on
// its container (`data-payment-choices`); which methods show, their order and
// every action stay the checkout's own (lib/checkout/index.ts). The theme
// editor's sample checkout draws its sample methods with the same parts.
import type { StorefrontPaymentChoiceStyle } from "@scalius/shared/storefront-theme";
import type { GatewayPresentation } from "./gateway-presentation";

/** Where the tiles style puts the chosen method's details: right under the grid. */
export const PAYMENT_CHOICE_DETAILS_ID = "paymentChoiceDetails";

export interface PaymentChoiceParts {
  card: HTMLElement;
  /** The radio (a button), or the one method's row when it is the only one. */
  control: HTMLElement;
  details: HTMLElement;
}

/**
 * The style the page asks for. Tiles need two methods or more: a single
 * method is a row (it has nothing to choose between).
 */
export function paymentChoiceStyle(container: HTMLElement, count: number): StorefrontPaymentChoiceStyle {
  return container.dataset.paymentChoices === "tiles" && count > 1 ? "tiles" : "list";
}

function appendTextElement(parent: HTMLElement, tagName: keyof HTMLElementTagNameMap, className: string, text: string): HTMLElement {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function appendProviderIdentity(parent: HTMLElement, presentation: GatewayPresentation): void {
  // One badge size for every method (Shopify's payment rows): a brand's
  // wordmark fills it, a plain icon sits in its middle. Marks are drawn for
  // white, so the badge stays white in the dark colours unless the mark has
  // a dark version.
  if (!presentation.markSrc) return;
  const identity = document.createElement("span");
  identity.className =
    `flex h-8 w-16 shrink-0 items-center justify-center rounded-md border border-border bg-white px-1.5${presentation.darkMarkSrc ? " dark:bg-card" : ""}`;
  identity.setAttribute("aria-hidden", "true");
  const wordmark = presentation.markKind === "wordmark";
  const light = document.createElement("img");
  light.src = presentation.markSrc;
  light.alt = "";
  light.width = wordmark ? 52 : 20;
  light.height = 20;
  light.className = wordmark ? "h-5 w-full object-contain" : "h-5 w-5 object-contain";
  if (presentation.darkMarkSrc) light.classList.add("dark:hidden");
  identity.appendChild(light);
  if (presentation.darkMarkSrc) {
    const dark = document.createElement("img");
    dark.src = presentation.darkMarkSrc;
    dark.alt = "";
    dark.width = 20;
    dark.height = 20;
    dark.className = "hidden h-5 w-5 object-contain dark:block";
    identity.appendChild(dark);
  }
  parent.appendChild(identity);
}

function appendRadioMark(control: HTMLElement, className: string): void {
  const check = document.createElement("span");
  check.className = className;
  check.setAttribute("aria-hidden", "true");
  const dot = document.createElement("span");
  dot.className = "check-dot hidden h-2.5 w-2.5 rounded-full bg-primary";
  check.appendChild(dot);
  control.appendChild(check);
}

function appendPaymentChoiceContent(
  control: HTMLElement,
  presentation: GatewayPresentation,
  label: string,
  showRadio: boolean,
  style: StorefrontPaymentChoiceStyle,
): void {
  const copy = document.createElement("div");
  copy.className = "min-w-0 flex-1";
  appendTextElement(copy, "p", "text-sm font-semibold text-foreground", label);
  if (presentation.description) {
    appendTextElement(copy, "p", "mt-0.5 text-xs leading-4 text-muted-foreground", presentation.description);
  }
  if (style === "tiles") {
    // A tile: the mark on top, the words under it, the radio at the top corner.
    appendProviderIdentity(control, presentation);
    control.appendChild(copy);
    if (showRadio) {
      appendRadioMark(control, "method-check absolute end-3 top-3 flex h-5 w-5 items-center justify-center rounded-full border-2 border-input");
    }
  } else {
    control.appendChild(copy);
    appendProviderIdentity(control, presentation);
    if (showRadio) {
      appendRadioMark(control, "method-check flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-input");
    }
  }
  control.setAttribute(
    "aria-label",
    [label, presentation.description, presentation.providerLabel].filter(Boolean).join(". "),
  );
}

/** One method's card, control and details, unattached. */
export function buildPaymentChoice(input: {
  id: string;
  presentation: GatewayPresentation;
  label: string;
  /** The only method: a row, not a radio. */
  single: boolean;
  /** The first method takes the radiogroup's tab stop. */
  first: boolean;
  style: StorefrontPaymentChoiceStyle;
}): PaymentChoiceParts {
  const { id, presentation, label, single, first, style } = input;
  const tiles = style === "tiles";
  const card = document.createElement("div");
  card.className = tiles
    ? "payment-method-card relative overflow-hidden rounded-xl border border-border bg-card transition-colors"
    : "payment-method-card overflow-hidden rounded-xl border border-border bg-card transition-colors";
  card.dataset.method = id;

  const control = single ? document.createElement("div") : document.createElement("button");
  control.className = single
    ? "flex min-h-16 w-full items-center gap-3 px-4 py-3 text-start"
    : tiles
      ? "payment-method-control flex h-full min-h-24 w-full appearance-none flex-col items-start gap-2 px-4 py-3 pe-10 text-start transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-wait"
      : "payment-method-control flex min-h-16 w-full appearance-none items-center gap-3 px-4 py-3 text-start transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-wait";
  if (control instanceof HTMLButtonElement) {
    control.type = "button";
    control.id = `payment-method-${id}`;
    control.setAttribute("role", "radio");
    control.setAttribute("aria-checked", "false");
    // A radio may not carry aria-expanded; aria-controls names the revealed details.
    control.setAttribute("aria-controls", `payment-details-${id}`);
    control.tabIndex = first ? 0 : -1;
  }
  appendPaymentChoiceContent(control, presentation, label, !single, style);
  card.appendChild(control);

  const details = document.createElement("div");
  details.id = `payment-details-${id}`;
  details.className = tiles
    ? "payment-method-details hidden space-y-3 rounded-xl border border-border bg-card px-4 py-4"
    : "payment-method-details hidden space-y-3 border-t border-border px-4 py-4";
  if (!single) details.setAttribute("aria-labelledby", `payment-method-${id}`);
  return { card, control, details };
}

/** A method's parts into the page: its details in its card (list), or under the tiles. */
export function placePaymentChoice(container: HTMLElement, parts: PaymentChoiceParts, style: StorefrontPaymentChoiceStyle): void {
  const host = style === "tiles" ? document.getElementById(PAYMENT_CHOICE_DETAILS_ID) : null;
  if (host) host.appendChild(parts.details);
  else parts.card.appendChild(parts.details);
  container.appendChild(parts.card);
}

/** Every method and its details out of the page. */
export function clearPaymentChoices(container: HTMLElement | null): void {
  container?.replaceChildren();
  document.getElementById(PAYMENT_CHOICE_DETAILS_ID)?.replaceChildren();
}

/** The details of one method, wherever the style put them. */
export function paymentChoiceDetails(methodId: string): HTMLElement | null {
  return document.getElementById(`payment-details-${methodId}`);
}

/** The chosen method marked (its radio, border and details), every other one not. */
export function applySelectedPaymentChoice(methodId: string | null): void {
  document.querySelectorAll(".payment-method-card").forEach((card) => {
    const el = card as HTMLElement;
    const isSelected = el.dataset.method === methodId;
    const control = el.querySelector<HTMLButtonElement>(".payment-method-control");
    const details = el.dataset.method ? paymentChoiceDetails(el.dataset.method) : null;
    if (control) {
      control.setAttribute("aria-checked", String(isSelected));
      if (methodId !== null) control.tabIndex = isSelected ? 0 : -1;
    }
    el.classList.toggle("border-primary", isSelected);
    el.classList.toggle("border-border", !isSelected);
    el.classList.toggle("shadow-sm", isSelected);
    el.querySelector(".check-dot")?.classList.toggle("hidden", !isSelected);
    details?.classList.toggle("hidden", !isSelected);
  });
}

/** How many tiles share a row of the grid as it is laid out now (1 for the list, and on a phone). */
function tilesPerRow(controls: readonly HTMLElement[]): number {
  const top = (control: HTMLElement) => control.getBoundingClientRect().top;
  const first = controls[0];
  if (!first) return 1;
  return Math.max(1, controls.filter((control) => Math.abs(top(control) - top(first)) < 1).length);
}

/**
 * Arrow keys, Home and End move the choice, as a radiogroup does, along what
 * the buyer sees: in the list Down and Up step through the rows; in tiles
 * Down and Up move a row (and stay put on the top or bottom row), the start and end arrows one tile; and the start
 * and end arrows follow the page's direction (in right-to-left, Left is next).
 */
export function handlePaymentChoiceKeyDown(
  event: KeyboardEvent,
  /** Chooses the method a key moved to: the page's own choose (a click by default). */
  choose: (control: HTMLButtonElement) => void = (control) => control.click(),
): void {
  const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
  if (!keys.includes(event.key)) return;

  const cards = Array.from(document.querySelectorAll<HTMLButtonElement>(".payment-method-control"));
  const current = event.currentTarget as HTMLButtonElement;
  const currentIndex = cards.indexOf(current);
  if (currentIndex === -1 || cards.length === 0) return;

  event.preventDefault();
  const tiles = current.closest<HTMLElement>("[data-payment-choices]")?.dataset.paymentChoices === "tiles";
  const columns = tiles ? tilesPerRow(cards) : 1;
  const rtl = current.closest("[dir]")?.getAttribute("dir") === "rtl";
  const forward = rtl ? "ArrowLeft" : "ArrowRight";
  const wrap = (index: number) => (index + cards.length) % cards.length;
  let nextIndex: number;
  if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = cards.length - 1;
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    // The list wraps, as a radiogroup does. Tiles move straight up or down, and at the top
    // or bottom row (no tile above or below) the choice stays where it is.
    const step = event.key === "ArrowDown" ? 1 : -1;
    if (columns === 1) nextIndex = wrap(currentIndex + step);
    else {
      nextIndex = currentIndex + step * columns;
      if (nextIndex < 0 || nextIndex >= cards.length) return;
    }
  } else {
    nextIndex = wrap(currentIndex + (event.key === forward ? 1 : -1));
  }

  // A key that lands where it is (Home on the first) chooses nothing anew.
  if (nextIndex === currentIndex) return;
  const next = cards[nextIndex];
  if (!next) return;
  next.focus();
  choose(next);
}
