const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function setupCatalogFilterDialog(): void {
  const toggle = document.getElementById("mobile-filter-toggle");
  const close = document.getElementById("mobile-filter-close");
  const dialog = document.getElementById("filter-section");
  if (!(toggle instanceof HTMLButtonElement) || !(close instanceof HTMLButtonElement) || !dialog) return;
  if (dialog.dataset.dialogBound === "true") return;
  dialog.dataset.dialogBound = "true";

  const mobile = window.matchMedia("(max-width: 1023px)");

  const isOpen = () => mobile.matches && !dialog.classList.contains("hidden");
  const focusable = () => [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");

  const syncSemantics = () => {
    if (mobile.matches) {
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-hidden", String(!isOpen()));
      toggle.setAttribute("aria-expanded", String(isOpen()));
    } else {
      dialog.removeAttribute("role");
      dialog.removeAttribute("aria-modal");
      dialog.removeAttribute("aria-hidden");
      toggle.setAttribute("aria-expanded", "false");
      document.body.style.overflow = "";
    }
  };

  const openDialog = () => {
    if (!mobile.matches) return;
    dialog.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    syncSemantics();
    close.focus();
  };

  const closeDialog = (restoreFocus = true) => {
    if (!mobile.matches) return;
    dialog.classList.add("hidden");
    document.body.style.overflow = "";
    syncSemantics();
    if (restoreFocus) toggle.focus();
  };

  toggle.addEventListener("click", openDialog);
  close.addEventListener("click", () => closeDialog());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });
  dialog.addEventListener("keydown", (event) => {
    if (!isOpen()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const candidates = focusable();
    const first = candidates[0];
    const last = candidates.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  mobile.addEventListener("change", syncSemantics);
  syncSemantics();
}
