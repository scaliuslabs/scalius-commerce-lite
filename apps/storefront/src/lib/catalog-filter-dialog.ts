const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export const CATALOG_FILTER_HISTORY_KEY = "__scaliusCatalogFilter";

type CatalogFilterRuntimeWindow = Window & {
  __scaliusCatalogFilterCleanup?: () => void;
};

function historyState(): Record<string, unknown> {
  return history.state && typeof history.state === "object" ? history.state : {};
}

function clearFilterHistoryMarker(): void {
  if (historyState()[CATALOG_FILTER_HISTORY_KEY] !== true) return;
  const nextState = { ...historyState() };
  delete nextState[CATALOG_FILTER_HISTORY_KEY];
  history.replaceState(nextState, "", window.location.href);
}

export function navigateToCatalogFilterSearch(params: URLSearchParams): void {
  const search = params.toString();
  if (historyState()[CATALOG_FILTER_HISTORY_KEY] === true) {
    clearFilterHistoryMarker();
    window.location.replace(
      `${window.location.pathname}${search ? `?${search}` : ""}`,
    );
    return;
  }
  window.location.search = search;
}

export function setupCatalogFilterDialog({
  toggleId = "mobile-filter-toggle",
  closeId = "mobile-filter-close",
  dialogId = "filter-section",
}: {
  toggleId?: string;
  closeId?: string;
  dialogId?: string;
} = {}): void {
  const toggle = document.getElementById(toggleId);
  const close = document.getElementById(closeId);
  const dialog = document.getElementById(dialogId);
  if (
    !(toggle instanceof HTMLButtonElement) ||
    !(close instanceof HTMLButtonElement) ||
    !dialog
  )
    return;
  if (dialog.dataset.dialogBound === "true") return;

  const runtimeWindow = window as CatalogFilterRuntimeWindow;
  runtimeWindow.__scaliusCatalogFilterCleanup?.();
  dialog.dataset.dialogBound = "true";

  const mobile = window.matchMedia("(max-width: 1023px)");
  let previousBodyOverflow = document.body.style.overflow;

  const isOpen = () => mobile.matches && !dialog.classList.contains("hidden");
  const focusable = () =>
    [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
      (element) =>
        !element.hasAttribute("disabled") &&
        element.getAttribute("aria-hidden") !== "true",
    );

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
      document.body.style.overflow = previousBodyOverflow;
    }
  };

  const openDialog = () => {
    if (!mobile.matches) return;
    dialog.classList.remove("hidden");
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (historyState()[CATALOG_FILTER_HISTORY_KEY] !== true) {
      history.pushState(
        { ...historyState(), [CATALOG_FILTER_HISTORY_KEY]: true },
        "",
        window.location.href,
      );
    }
    syncSemantics();
    close.focus();
  };

  const closeDialog = ({
    restoreFocus = true,
    syncHistory = true,
  }: {
    restoreFocus?: boolean;
    syncHistory?: boolean;
  } = {}) => {
    if (!mobile.matches) return;
    dialog.classList.add("hidden");
    document.body.style.overflow = previousBodyOverflow;
    syncSemantics();
    if (restoreFocus) toggle.focus();
    if (
      syncHistory &&
      historyState()[CATALOG_FILTER_HISTORY_KEY] === true
    ) {
      history.back();
    }
  };

  const handleClose = () => closeDialog();
  const handleDialogClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const link = target.closest<HTMLAnchorElement>("a[href]");
    if (
      link &&
      mobile.matches &&
      historyState()[CATALOG_FILTER_HISTORY_KEY] === true
    ) {
      event.preventDefault();
      clearFilterHistoryMarker();
      window.location.replace(link.href);
      return;
    }
    if (target === dialog) closeDialog();
  };
  const handleDialogKeydown = (event: KeyboardEvent) => {
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
  };
  const handlePopState = () => {
    if (isOpen()) closeDialog({ syncHistory: false });
  };
  const handleBreakpointChange = () => {
    if (!mobile.matches) {
      dialog.classList.add("hidden");
      document.body.style.overflow = previousBodyOverflow;
      clearFilterHistoryMarker();
    }
    syncSemantics();
  };

  toggle.addEventListener("click", openDialog);
  close.addEventListener("click", handleClose);
  dialog.addEventListener("click", handleDialogClick);
  dialog.addEventListener("keydown", handleDialogKeydown);
  mobile.addEventListener("change", handleBreakpointChange);
  window.addEventListener("popstate", handlePopState);
  syncSemantics();

  runtimeWindow.__scaliusCatalogFilterCleanup = () => {
    toggle.removeEventListener("click", openDialog);
    close.removeEventListener("click", handleClose);
    dialog.removeEventListener("click", handleDialogClick);
    dialog.removeEventListener("keydown", handleDialogKeydown);
    mobile.removeEventListener("change", handleBreakpointChange);
    window.removeEventListener("popstate", handlePopState);
    document.body.style.overflow = previousBodyOverflow;
    dialog.removeAttribute("data-dialog-bound");
    delete runtimeWindow.__scaliusCatalogFilterCleanup;
  };
}
