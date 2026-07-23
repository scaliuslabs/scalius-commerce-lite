let previousFocus: HTMLElement | null = null;
let previousBodyOverflow = "";

function getOverlay(): HTMLElement | null {
  return document.getElementById("loadingOverlay");
}

export function showCheckoutLoadingOverlay(options: {
  title: string;
  message: string;
}): void {
  const overlay = getOverlay();
  if (!overlay) return;

  if (overlay.classList.contains("hidden")) {
    previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    previousBodyOverflow = document.body.style.overflow;
  }

  const title = document.getElementById("loadingTitle");
  const message = document.getElementById("loadingMsg");
  if (title) title.textContent = options.title;
  if (message) message.textContent = options.message;

  overlay.classList.remove("hidden");
  overlay.classList.add("flex");
  overlay.setAttribute("aria-hidden", "false");
  document.querySelector("main")?.setAttribute("aria-busy", "true");
  document.body.style.overflow = "hidden";
  overlay.focus({ preventScroll: true });
}

export function hideCheckoutLoadingOverlay(options: {
  restoreFocus?: boolean;
} = {}): void {
  const overlay = getOverlay();
  if (!overlay) return;

  overlay.classList.add("hidden");
  overlay.classList.remove("flex");
  overlay.setAttribute("aria-hidden", "true");
  document.querySelector("main")?.removeAttribute("aria-busy");
  document.body.style.overflow = previousBodyOverflow;

  if (options.restoreFocus !== false && previousFocus?.isConnected) {
    previousFocus.focus({ preventScroll: true });
  }
  previousFocus = null;
  previousBodyOverflow = "";
}
