// Where focus goes when the page changed under a dialog (signing in shows the
// account, the order, the saved state): the page's main heading, so keyboard
// and screen-reader users land on what the page now is, never on <body>.

function isShown(element: HTMLElement): boolean {
  if (element.closest("[hidden], .hidden")) return false;
  const check = (element as HTMLElement & { checkVisibility?: () => boolean }).checkVisibility;
  return typeof check === "function" ? check.call(element) : true;
}

/** The first shown h1, preferring the page content over the header. */
export function findMainHeading(root: ParentNode = document): HTMLElement | null {
  const inMain = [...root.querySelectorAll<HTMLElement>("main h1")];
  const anywhere = [...root.querySelectorAll<HTMLElement>("h1")];
  return [...inMain, ...anywhere].find(isShown) ?? null;
}

/** Focuses the main heading (made focusable without joining the Tab order); true when it took focus. */
export function focusMainHeading(root: ParentNode = document): boolean {
  const heading = findMainHeading(root);
  if (!heading) return false;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.classList.add("focus:outline-none");
  heading.focus();
  return document.activeElement === heading;
}

/** Only when focus was lost (on <body>, or on something now hidden): the main heading. */
export function focusMainHeadingIfLost(): boolean {
  const active = document.activeElement;
  const lost = !active || active === document.body || (active instanceof HTMLElement && !isShown(active));
  return lost ? focusMainHeading() : false;
}
