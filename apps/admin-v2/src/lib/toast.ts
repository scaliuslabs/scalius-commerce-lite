// The dashboard's toasts. sonner (its store and the Toaster, which
// DeferredToaster mounts after the first render) is never part of a page's
// first download: it starts loading as soon as a screen that can toast has
// loaded, and a toast raised before it arrives shows once it has.
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
