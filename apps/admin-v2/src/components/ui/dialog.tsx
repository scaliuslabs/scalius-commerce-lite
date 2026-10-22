import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";

import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { ModalInertBackground } from "./overlay";

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

const DialogClose = DialogPrimitive.Close;

/** Overlay and panel classes shared with AlertDialog. State never depends on animation. */
export const overlayClassName =
  "fixed inset-0 z-50 bg-overlay data-[state=closed]:pointer-events-none data-[state=closed]:invisible";
/**
 * Centred from `sm` up; a bottom sheet on phones, within thumb reach. From
 * `sm` the panel opens centred, then `useModalTopAnchor` pins its top edge
 * (`data-anchored`, `--dialog-top`): it grows and shrinks downward and never
 * re-centres. `--dialog-top` is unset on phones, so the height cap there is
 * the whole screen less 1rem. The cap is one unprefixed class so a dialog that
 * sets its own `max-h` replaces it.
 */
export const modalClassName =
  "fixed inset-x-0 bottom-0 z-50 grid max-h-[calc(100dvh-var(--dialog-top,3.5rem)-1rem)] w-full gap-4 overflow-y-auto rounded-t-2xl bg-card p-5 max-sm:pb-safe text-card-foreground shadow-modal data-[state=closed]:pointer-events-none data-[state=closed]:invisible sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:data-anchored:top-(--dialog-top) sm:data-anchored:translate-y-0";

/** Tailwind's `sm` breakpoint: from here a modal is centred, below it a bottom sheet. */
const CENTRED_MODAL = "(min-width: 40rem)";

/**
 * Keeps a centred modal's top edge where it opens. Radix mounts the panel on
 * each open, so this layout effect runs once per open, before the first paint:
 * it measures the panel (centred, as the stylesheet draws it) and pins its top
 * at the height that centres that first content, never higher than 4rem from the
 * screen's top, so it never covers the 56px top bar (overlays keep clear of it,
 * `OVERLAY_COLLISION_PADDING`). After that the panel only grows and shrinks downward; the
 * height cap (`modalClassName`) keeps its bottom 1rem above the screen's, and
 * the panel scrolls inside. Content that changes height (a filtered list, a
 * chip row, an error line) therefore never moves the dialog or the buttons in
 * it. One exception: content that outgrows the room below the pinned top (a
 * dialog that opened on a spinner, then loaded a list) lifts the panel just
 * enough to show it, never lowers it, so it never scrolls with room to spare
 * above and never jitters. A new open measures again; a window resize
 * re-anchors, because the old position may no longer fit. Nothing animates,
 * so reduced motion has nothing to switch off. A phone's bottom sheet is left
 * alone.
 *
 * Returns the ref for the Radix content, which also forwards the caller's ref.
 */
export function useModalTopAnchor<T extends HTMLElement>(forwardedRef: React.ForwardedRef<T>, enabled = true) {
  const panelRef = React.useRef<T | null>(null);
  React.useImperativeHandle(forwardedRef, () => panelRef.current as T, []);
  React.useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !enabled) return;
    let pinnedTop: number | null = null;
    const pin = (top: number) => {
      pinnedTop = Math.round(top);
      panel.style.setProperty("--dialog-top", `max(4rem, ${pinnedTop}px)`);
    };
    const anchor = () => {
      pinnedTop = null;
      panel.removeAttribute("data-anchored");
      panel.style.removeProperty("--dialog-top");
      if (!window.matchMedia(CENTRED_MODAL).matches) return;
      pin((window.innerHeight - panel.getBoundingClientRect().height) / 2);
      panel.setAttribute("data-anchored", "");
    };
    // Up only: a lifted panel has more room, so it never comes back down.
    const makeRoom = () => {
      if (pinnedTop === null || panel.scrollHeight <= panel.clientHeight) return;
      const centred = (window.innerHeight - panel.scrollHeight) / 2;
      if (centred < pinnedTop) pin(centred);
    };
    // The panel's own box stops growing at the cap, so watch what is inside it.
    const sizes = typeof ResizeObserver === "function" ? new ResizeObserver(makeRoom) : null;
    const watchChildren = () => {
      for (const child of Array.from(panel.children)) sizes?.observe(child);
    };
    const children = typeof MutationObserver === "function"
      ? new MutationObserver(() => {
        watchChildren();
        makeRoom();
      })
      : null;
    anchor();
    watchChildren();
    children?.observe(panel, { childList: true });
    window.addEventListener("resize", anchor);
    return () => {
      window.removeEventListener("resize", anchor);
      sizes?.disconnect();
      children?.disconnect();
    };
  }, [enabled]);
  return panelRef;
}

/**
 * Command palette (global search): drops from under the top bar, 640px wide,
 * 12px radius; on phones it pins to the top because the keyboard owns the bottom.
 */
const paletteClassName =
  "fixed inset-x-0 top-0 z-50 grid max-h-[calc(100dvh-1rem)] w-full overflow-hidden rounded-b-2xl bg-card text-card-foreground shadow-modal data-[state=closed]:pointer-events-none data-[state=closed]:invisible sm:inset-x-auto sm:left-1/2 sm:top-2.5 sm:max-w-160 sm:-translate-x-1/2 sm:rounded-xl";

/** The close button's name in the dashboard language (also the sheet header's). */
export function CloseLabel() {
  const t = useMessages(resourceMessages);
  return <span className="sr-only">{t("close")}</span>;
}

interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  showCloseButton?: boolean;
  /** "palette" is the top-anchored command palette shape (no close button). */
  variant?: "modal" | "palette";
}

/**
 * Where focus goes back when an overlay closes: what was focused when it
 * opened, or, when that was an item of a menu (More actions → Cancel order),
 * the button that opened the menu, since the item is gone by then. Radix
 * would otherwise drop focus on <body> (WCAG 2.4.3).
 */
export function overlayOpener(active: Element | null = typeof document === "undefined" ? null : document.activeElement): HTMLElement | null {
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const menu = active.closest<HTMLElement>('[role="menu"]');
  const triggerId = menu?.getAttribute("aria-labelledby");
  const trigger = triggerId ? document.getElementById(triggerId) : null;
  return trigger ?? active;
}

/** Open/close focus handlers that return focus to `overlayOpener()` (caller handlers run first). */
export function useReturnFocus(
  onOpenAutoFocus?: (event: Event) => void,
  onCloseAutoFocus?: (event: Event) => void,
): { onOpenAutoFocus: (event: Event) => void; onCloseAutoFocus: (event: Event) => void } {
  const opener = React.useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (event) => {
      opener.current = overlayOpener();
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus: (event) => {
      onCloseAutoFocus?.(event);
      if (!event.defaultPrevented && opener.current?.isConnected) {
        event.preventDefault();
        opener.current.focus();
      }
    },
  };
}

/** Mounted by Radix for each open (the portal keeps nothing while closed), so it anchors once per open. */
const DialogPanel = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  ({ className, children, showCloseButton = true, variant = "modal", onOpenAutoFocus, onCloseAutoFocus, ...props }, ref) => {
    const panelRef = useModalTopAnchor(ref, variant === "modal");
    const focus = useReturnFocus(onOpenAutoFocus, onCloseAutoFocus);
    return (
      <DialogPrimitive.Content ref={panelRef} data-slot="dialog-content" className={cn(variant === "palette" ? paletteClassName : modalClassName, className)} {...props}
        onOpenAutoFocus={focus.onOpenAutoFocus}
        onCloseAutoFocus={focus.onCloseAutoFocus}
      >
        <ModalInertBackground />
        {children}
        {showCloseButton && variant === "modal" ? (
          <DialogPrimitive.Close className="absolute inset-e-2 top-2 flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground active:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:inset-e-3 sm:top-3 sm:size-8">
            <X className="size-4" />
            <CloseLabel />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    );
  },
);
DialogPanel.displayName = "DialogPanel";

const DialogContent = React.forwardRef<React.ComponentRef<typeof DialogPrimitive.Content>, DialogContentProps>((props, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay data-slot="dialog-overlay" className={overlayClassName} />
    <DialogPanel ref={ref} {...props} />
  </DialogPrimitive.Portal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1 pe-8 text-start", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

/**
 * A modal scrolls as a whole when its content is taller than the screen; the
 * footer is a bordered bar pinned to its bottom edge so the actions never
 * scroll away. It bleeds over the panel's padding (`p-5`, `pb-safe` on
 * phones): the negative margin and sticky offset both equal that padding,
 * because sticky insets are measured inside the scroll container's padding.
 */
export const dialogFooterClassName =
  "sticky -bottom-5 z-10 -mx-5 -mb-5 flex flex-col-reverse gap-2 border-t bg-card px-5 pb-5 pt-4 max-sm:bottom-[calc(-1*max(1.25rem,env(safe-area-inset-bottom)))] max-sm:mb-[calc(-1*max(1.25rem,env(safe-area-inset-bottom)))] max-sm:pb-safe sm:flex-row sm:justify-end";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div data-slot="dialog-footer" className={cn(dialogFooterClassName, className)} {...props} />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn("text-heading-md", className)} {...props} />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-body text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription };
// The sheet reuses the modal's pieces through this module only, so both stay in one chunk.
export { ModalInertBackground };
