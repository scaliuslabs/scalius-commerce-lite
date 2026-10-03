let previousFocus: HTMLElement | null = null;
let previousBodyOverflow = "";
let previousMainInert = false;
let slowTimer: ReturnType<typeof setTimeout> | null = null;

/** How long a redirect may take before the buyer is told it is still on its way. */
export const SLOW_REDIRECT_AFTER_MS = 8_000;

function getOverlay(): HTMLElement | null {
  return document.getElementById("loadingOverlay");
}

function clearSlowTimer(): void {
  if (slowTimer !== null) clearTimeout(slowTimer);
  slowTimer = null;
}

/**
 * Shows the overlay. With `slowMessage`, the message changes to it once
 * `slowAfterMs` pass with the overlay still up (a hosted payment page that is
 * slow to open on a phone network), so the buyer keeps waiting instead of
 * paying twice. The overlay is a polite live region: the change is announced.
 */
export function showCheckoutLoadingOverlay(options: {
  title: string;
  message: string;
  slowMessage?: string;
  slowAfterMs?: number;
}): void {
  const overlay = getOverlay();
  if (!overlay) return;

  if (overlay.classList.contains("hidden")) {
    previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    previousBodyOverflow = document.body.style.overflow;
    previousMainInert = document.querySelector<HTMLElement>("main")?.inert ?? false;
  }

  const title = document.getElementById("loadingTitle");
  const message = document.getElementById("loadingMsg");
  if (title) title.textContent = options.title;
  if (message) message.textContent = options.message;

  clearSlowTimer();
  const { slowMessage } = options;
  if (slowMessage && message) {
    slowTimer = setTimeout(() => {
      slowTimer = null;
      if (!overlay.classList.contains("hidden")) message.textContent = slowMessage;
    }, options.slowAfterMs ?? SLOW_REDIRECT_AFTER_MS);
  }

  overlay.classList.remove("hidden");
  overlay.classList.add("flex");
  overlay.setAttribute("aria-hidden", "false");
  const main = document.querySelector<HTMLElement>("main");
  main?.setAttribute("aria-busy", "true");
  if (main) main.inert = true;
  document.body.style.overflow = "hidden";
  overlay.focus({ preventScroll: true });
}

export function hideCheckoutLoadingOverlay(options: {
  restoreFocus?: boolean;
} = {}): void {
  clearSlowTimer();
  const overlay = getOverlay();
  if (!overlay) return;

  overlay.classList.add("hidden");
  overlay.classList.remove("flex");
  overlay.setAttribute("aria-hidden", "true");
  const main = document.querySelector<HTMLElement>("main");
  main?.removeAttribute("aria-busy");
  if (main) main.inert = previousMainInert;
  document.body.style.overflow = previousBodyOverflow;

  if (options.restoreFocus !== false && previousFocus?.isConnected) {
    previousFocus.focus({ preventScroll: true });
  }
  previousFocus = null;
  previousBodyOverflow = "";
  previousMainInert = false;
}
