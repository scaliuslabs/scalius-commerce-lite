import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  BookOpenText,
  Grip,
  MessageCircle,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";

import {
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
  STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL,
  type StorefrontAssistantPageContextSnapshot,
} from "@/lib/assistant-page-context";
import { cn } from "@scalius/shared/utils";

type StorefrontAssistantBridge = {
  getContext?: () => StorefrontAssistantPageContextSnapshot | null;
};

const LAUNCHER_SIZE = 56;
const EDGE_GAP = 16;
const DRAG_THRESHOLD = 6;
const PANEL_ID = "storefront-assistant-panel";
const SENSITIVE_PAGE_KINDS = new Set(["account", "checkout"]);

type LauncherPosition = {
  x: number;
  y: number;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  moved: boolean;
};

function readPublishedContext(): StorefrontAssistantPageContextSnapshot | null {
  if (typeof window === "undefined") return null;

  const assistantWindow = window as Window & {
    __SCALIUS_STOREFRONT_ASSISTANT__?: StorefrontAssistantBridge;
  };
  const bridgeContext =
    assistantWindow.__SCALIUS_STOREFRONT_ASSISTANT__?.getContext?.() ?? null;
  if (bridgeContext) return bridgeContext;

  return window[STOREFRONT_ASSISTANT_PAGE_CONTEXT_GLOBAL] ?? null;
}

function clampLauncherPosition(position: LauncherPosition): LauncherPosition {
  if (typeof window === "undefined") return position;

  return {
    x: Math.min(
      Math.max(position.x, EDGE_GAP),
      Math.max(EDGE_GAP, window.innerWidth - LAUNCHER_SIZE - EDGE_GAP),
    ),
    y: Math.min(
      Math.max(position.y, EDGE_GAP),
      Math.max(EDGE_GAP, window.innerHeight - LAUNCHER_SIZE - EDGE_GAP),
    ),
  };
}

function formatPageKind(
  context: StorefrontAssistantPageContextSnapshot | null,
): string {
  if (!context) return "Waiting for page context";
  return `${context.page.kind.charAt(0).toUpperCase()}${context.page.kind.slice(
    1,
  )} page`;
}

function formatPublicPageLabel(
  context: StorefrontAssistantPageContextSnapshot | null,
): string {
  if (!context) return "No public page snapshot is published yet.";
  if (SENSITIVE_PAGE_KINDS.has(context.page.kind)) {
    return "This is a sensitive storefront flow, so only the page type is shown here.";
  }

  const title = context.page.title || "Untitled page";
  return `${title} (${context.page.path})`;
}

function formatCanonicalPath(
  context: StorefrontAssistantPageContextSnapshot | null,
): string | null {
  const canonicalUrl = context?.page.canonicalUrl;
  if (!canonicalUrl) return null;

  try {
    return new URL(canonicalUrl).pathname;
  } catch {
    return null;
  }
}

function formatCartSummary(
  context: StorefrontAssistantPageContextSnapshot | null,
): string {
  if (!context) return "Cart summary unavailable.";

  const { totalItems, lineCount, truncated, hasDiscount } = context.cart;
  const itemLabel = totalItems === 1 ? "item" : "items";
  const lineLabel = lineCount === 1 ? "line" : "lines";
  const discountLabel = hasDiscount ? "Discount present." : "No discount code visible.";
  const truncatedLabel = truncated ? " Summary is bounded." : "";

  return `${totalItems} ${itemLabel} across ${lineCount} ${lineLabel}. ${discountLabel}${truncatedLabel}`;
}

export default function StorefrontAssistantBubble() {
  const [isOpen, setIsOpen] = useState(false);
  const [context, setContext] =
    useState<StorefrontAssistantPageContextSnapshot | null>(null);
  const [position, setPosition] = useState<LauncherPosition | null>(null);
  const [panelSide, setPanelSide] = useState<"left" | "right">("right");
  const shellRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);

  const refreshContext = useCallback(() => {
    setContext(readPublishedContext());
  }, []);

  useEffect(() => {
    refreshContext();

    const handleContextChange = (
      event: CustomEvent<StorefrontAssistantPageContextSnapshot>,
    ) => {
      setContext(event.detail);
    };

    window.addEventListener(
      STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
      handleContextChange as EventListener,
    );

    return () => {
      window.removeEventListener(
        STOREFRONT_ASSISTANT_PAGE_CONTEXT_EVENT,
        handleContextChange as EventListener,
      );
    };
  }, [refreshContext]);

  useEffect(() => {
    if (!isOpen) return;
    refreshContext();
  }, [isOpen, refreshContext]);

  useEffect(() => {
    if (!position) return;

    const handleResize = () => {
      setPosition((current) =>
        current ? clampLauncherPosition(current) : current,
      );
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [position]);

  useEffect(() => {
    const rect = shellRef.current?.getBoundingClientRect();
    if (!rect || typeof window === "undefined") return;
    setPanelSide(rect.left < window.innerWidth / 2 ? "left" : "right");
  }, [isOpen, position]);

  const contextFacts = useMemo(() => {
    const facts = [
      {
        icon: BookOpenText,
        label: "Page",
        value: formatPublicPageLabel(context),
      },
      {
        icon: Search,
        label: "Route",
        value: formatPageKind(context),
      },
      {
        icon: ShieldCheck,
        label: "Cart",
        value: formatCartSummary(context),
      },
    ];

    const canonicalPath = formatCanonicalPath(context);
    if (canonicalPath && !SENSITIVE_PAGE_KINDS.has(context?.page.kind ?? "")) {
      facts.splice(2, 0, {
        icon: Search,
        label: "Canonical",
        value: canonicalPath,
      });
    }

    return facts;
  }, [context]);

  const beginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const rect = shellRef.current?.getBoundingClientRect();
    if (!rect || (event.pointerType === "mouse" && event.button !== 0)) {
      return;
    }

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false,
    };
    setPosition({ x: rect.left, y: rect.top });
    shellRef.current?.setPointerCapture(event.pointerId);
  };

  const continueDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    if (
      Math.abs(event.clientX - dragState.startX) > DRAG_THRESHOLD ||
      Math.abs(event.clientY - dragState.startY) > DRAG_THRESHOLD
    ) {
      dragState.moved = true;
    }

    const next = clampLauncherPosition({
      x: event.clientX - dragState.offsetX,
      y: event.clientY - dragState.offsetY,
    });

    setPosition(next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    suppressClickRef.current = dragState.moved;
    dragStateRef.current = null;
    shellRef.current?.releasePointerCapture(event.pointerId);
  };

  const togglePanel = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }

    setIsOpen((value) => !value);
  };

  return (
    <div
      ref={shellRef}
      className={cn(
        "fixed z-[80] flex touch-none select-none flex-col items-end gap-3",
        position ? "" : "bottom-4 right-4 sm:bottom-6 sm:right-6",
      )}
      style={
        position
          ? {
              left: `${position.x}px`,
              top: `${position.y}px`,
            }
          : undefined
      }
      onPointerMove={continueDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {isOpen && (
        <section
          id={PANEL_ID}
          aria-labelledby="storefront-assistant-title"
          className={cn(
            "absolute bottom-[calc(100%+0.75rem)] w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-2xl shadow-foreground/15",
            panelSide === "left" ? "left-0 items-start" : "right-0 items-end",
          )}
        >
          <div className="border-b border-border bg-gradient-to-r from-primary/12 via-background to-background px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase text-primary">
                  Read-only shell
                </p>
                <h2
                  id="storefront-assistant-title"
                  className="mt-1 text-sm font-semibold text-foreground"
                >
                  Catalog assistant is not ready
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close storefront assistant"
                className="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setIsOpen(false)}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div className="space-y-3 px-4 py-4">
            <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2.5 text-sm leading-6 text-foreground">
              Chat is not connected to a model or backend yet. This shell can
              only summarize the public page context already published by the
              storefront.
            </div>

            <div className="space-y-2">
              {contextFacts.map(({ icon: Icon, label, value }) => (
                <div
                  key={label}
                  className="grid grid-cols-[1rem_minmax(0,1fr)] gap-2 rounded-md border border-border/70 bg-background/70 px-3 py-2"
                >
                  <Icon
                    className="mt-0.5 h-4 w-4 text-primary"
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium uppercase text-muted-foreground">
                      {label}
                    </p>
                    <p className="break-words text-sm leading-5 text-foreground">
                      {value}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <p className="text-xs leading-5 text-muted-foreground">
              It cannot complete checkout, orders, account changes, payments,
              recovery, support requests, or cart edits.
            </p>

            <div className="flex items-center justify-between gap-3 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              <span>No conversation is sent anywhere.</span>
              <span aria-hidden="true">Catalog only</span>
            </div>
          </div>
        </section>
      )}

      <button
        type="button"
        aria-label={isOpen ? "Close storefront assistant" : "Open storefront assistant"}
        aria-controls={PANEL_ID}
        aria-expanded={isOpen}
        className="group relative flex h-14 w-14 items-center justify-center rounded-full border border-primary/30 bg-primary text-primary-foreground shadow-xl shadow-foreground/20 transition hover:-translate-y-0.5 hover:shadow-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:translate-y-0"
        onPointerDown={beginDrag}
        onClick={togglePanel}
      >
        <span className="absolute inset-1 rounded-full border border-primary-foreground/20" />
        <Grip
          className="absolute -left-1 -top-1 h-5 w-5 rounded-full bg-background p-1 text-muted-foreground opacity-85 shadow-sm"
          aria-hidden="true"
        />
        <MessageCircle
          className={cn(
            "h-6 w-6 transition-transform duration-200",
            isOpen ? "scale-90" : "group-hover:scale-105",
          )}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
