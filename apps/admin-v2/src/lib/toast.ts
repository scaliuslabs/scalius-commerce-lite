// The dashboard's toasts. sonner (its store and the Toaster, which
// DeferredToaster mounts after the first render) is never part of a page's
// first download: it starts loading as soon as a screen that can toast has
// loaded, and a toast raised before it arrives shows once it has.
import { useLayoutEffect, type RefObject } from "react";
import type { toast as sonnerToast } from "sonner";

type Sonner = typeof sonnerToast;
type Args = Parameters<Sonner["success"]>;

let sonner: Sonner | null = null;
const waiting: Array<(toast: Sonner) => void> = [];

import("sonner").then(
  (module) => {
    sonner = module.toast;
    for (const show of waiting.splice(0)) show(module.toast);
  },
  // The dashboard was updated meanwhile: its Toaster can't load either.
  () => undefined,
);

function show(run: (toast: Sonner) => void): void {
  if (sonner) run(sonner);
  else waiting.push(run);
}

export const toast = Object.assign((...args: Args) => show((toast) => toast(...args)), {
  success: (...args: Args) => show((toast) => toast.success(...args)),
  error: (...args: Args) => show((toast) => toast.error(...args)),
  info: (...args: Args) => show((toast) => toast.info(...args)),
  warning: (...args: Args) => show((toast) => toast.warning(...args)),
});

// ── Toasts above fixed bottom bars ──
// The Toaster sits `--toast-lift` above the bottom (`ui/sonner.tsx`). Every
// bar pinned to the bottom of the screen (phone selection and action bars)
// registers here; the lift is the tallest one showing, so a toast never
// covers the controls the merchant reaches for next. A bar hidden at this
// width (`md:hidden` on a desktop) measures 0 and lifts nothing.
const bottomBars = new Map<Element, number>();

function applyToastLift(): void {
  const lift = Math.max(0, ...bottomBars.values());
  const root = document.documentElement;
  if (lift > 0) root.style.setProperty("--toast-lift", `${lift}px`);
  else root.style.removeProperty("--toast-lift");
}

/** Keeps toasts above this fixed bottom bar while it is mounted. */
export function useToastsAboveBar(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const measure = () => {
      bottomBars.set(bar, bar.offsetHeight);
      applyToastLift();
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      bottomBars.delete(bar);
      applyToastLift();
    };
  }, [ref]);
}
