import {
  createContext,
  useEffect,
  useContext,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

export type AssistantDockMode = "closed" | "collapsed" | "floating" | "docked";
export type AssistantDockSide = "start" | "end";
export type AssistantDockStatus =
  | "idle"
  | "working"
  | "success"
  | "warning"
  | "error"
  | "offline";

const DEFAULT_DOCK_WIDTH = 392;
const MIN_DOCK_WIDTH = 320;
const MAX_DOCK_WIDTH = 520;
const KEYBOARD_RESIZE_STEP = 24;
const MOBILE_MEDIA_QUERY = "(max-width: 767px)";

const AssistantDockEnvironment = createContext<{
  mobile: boolean | undefined;
}>({ mobile: undefined });

function classNames(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function clamp(value: number, minimum: number, maximum: number) {
  const lower = Math.min(minimum, maximum);
  const upper = Math.max(minimum, maximum);
  return Math.min(
    upper,
    Math.max(lower, Number.isFinite(value) ? value : lower),
  );
}

type AssistantDockCssProperties = CSSProperties & {
  "--sc-assistant-dock-width"?: string;
};

export interface AssistantDockLayoutProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  children: ReactNode;
  dock: ReactNode;
  mode: AssistantDockMode;
  side?: AssistantDockSide;
  width?: number;
  minimumWidth?: number;
  maximumWidth?: number;
  /** Override automatic responsive detection, primarily for embedded hosts and tests. */
  mobile?: boolean;
}

/**
 * Mount this once above the application router so route changes replace only
 * `children`. Floating position and launcher drag persistence stay host-owned.
 */
export function AssistantDockLayout({
  children,
  dock,
  mode,
  side = "end",
  width = DEFAULT_DOCK_WIDTH,
  minimumWidth = MIN_DOCK_WIDTH,
  maximumWidth = MAX_DOCK_WIDTH,
  mobile,
  className,
  style,
  ...props
}: AssistantDockLayoutProps) {
  const resolvedMobile = useAssistantMobilePresentation(mobile);
  const safeWidth = clamp(width, minimumWidth, maximumWidth);
  const mobileModal =
    resolvedMobile && (mode === "docked" || mode === "floating");
  const layoutStyle: AssistantDockCssProperties = {
    ...style,
    "--sc-assistant-dock-width": `${safeWidth}px`,
  };

  return (
    <AssistantDockEnvironment.Provider value={{ mobile: resolvedMobile }}>
      <div
        {...props}
        className={classNames("sc-assistant-layout", className)}
        data-assistant-dock-layout=""
        data-mode={mode}
        data-side={side}
        data-mobile={resolvedMobile ? "true" : "false"}
        style={layoutStyle}
      >
        <div
          className="sc-assistant-layout__page"
          data-assistant-page-slot=""
          aria-hidden={mobileModal || undefined}
          inert={mobileModal || undefined}
        >
          {children}
        </div>
        <div
          className="sc-assistant-layout__dock"
          data-assistant-dock-slot=""
          hidden={mode === "closed"}
        >
          {dock}
        </div>
      </div>
    </AssistantDockEnvironment.Provider>
  );
}

export interface AssistantDockProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "title"
> {
  id: string;
  mode: AssistantDockMode;
  side?: AssistantDockSide;
  eyebrow?: string;
  heading: string;
  description?: string;
  status?: AssistantDockStatus;
  statusLabel?: string;
  icon?: ReactNode;
  context?: ReactNode;
  contextLabel?: string;
  conversation: ReactNode;
  emptyConversation?: ReactNode;
  composer: ReactNode;
  headerActions?: ReactNode;
  width?: number;
  minimumWidth?: number;
  maximumWidth?: number;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onModeChange: (mode: AssistantDockMode) => void;
  onSideChange?: (side: AssistantDockSide) => void;
  onWidthChange?: (width: number) => void;
  onRequestClose?: () => void;
  /** Override layout-provided responsive detection when rendered standalone. */
  mobile?: boolean;
}

export function AssistantDock({
  id,
  mode,
  side = "end",
  eyebrow = "Scalius assistant",
  heading,
  description,
  status = "idle",
  statusLabel = "Ready",
  icon,
  context,
  contextLabel = "Current page",
  conversation,
  emptyConversation,
  composer,
  headerActions,
  width = DEFAULT_DOCK_WIDTH,
  minimumWidth = MIN_DOCK_WIDTH,
  maximumWidth = MAX_DOCK_WIDTH,
  initialFocusRef,
  returnFocusRef,
  onModeChange,
  onSideChange,
  onWidthChange,
  onRequestClose,
  mobile,
  className,
  onKeyDown,
  ...props
}: AssistantDockProps) {
  const environment = useContext(AssistantDockEnvironment);
  const resolvedMobile = useAssistantMobilePresentation(
    mobile ?? environment.mobile,
  );
  const shellRef = useRef<HTMLElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const previousMode = useRef<AssistantDockMode>(mode);
  const focusBeforeOpen = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const prior = previousMode.current;
    const shell = shellRef.current;
    const mobileNeedsFocus =
      resolvedMobile &&
      mode !== "closed" &&
      mode !== "collapsed" &&
      shell !== null &&
      !shell.contains(document.activeElement);
    const opening =
      ((prior === "closed" || prior === "collapsed") &&
        mode !== "closed" &&
        mode !== "collapsed") ||
      mobileNeedsFocus;
    const closing =
      prior !== "closed" &&
      prior !== "collapsed" &&
      (mode === "closed" || mode === "collapsed");

    if (opening) {
      focusBeforeOpen.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      const target = initialFocusRef?.current ?? shellRef.current;
      target?.focus({ preventScroll: true });
    } else if (closing) {
      const target =
        mode === "collapsed"
          ? launcherRef.current
          : (returnFocusRef?.current ?? focusBeforeOpen.current);
      target?.focus({ preventScroll: true });
    }

    previousMode.current = mode;
  }, [initialFocusRef, mode, resolvedMobile, returnFocusRef]);

  useEffect(() => {
    if (!resolvedMobile || mode === "closed" || mode === "collapsed") {
      return undefined;
    }

    const bodyOverflow = document.body.style.overflow;
    const documentOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = documentOverflow;
    };
  }, [mode, resolvedMobile]);

  if (mode === "closed") return null;

  if (mode === "collapsed") {
    return (
      <button
        ref={launcherRef}
        className={classNames("sc-assistant-launcher", className)}
        type="button"
        aria-controls={id}
        aria-expanded="false"
        aria-label={`Open ${heading}`}
        data-status={status}
        onClick={() => onModeChange("floating")}
      >
        <span className="sc-assistant-launcher__icon" aria-hidden="true">
          {icon ?? <AssistantGlyph />}
        </span>
        <span className="sc-assistant-launcher__status" aria-hidden="true" />
      </button>
    );
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onModeChange("collapsed");
      return;
    }
    if (resolvedMobile && event.key === "Tab") {
      containTabFocus(event, shellRef);
    }
  }

  return (
    <aside
      {...props}
      ref={shellRef}
      id={id}
      className={classNames("sc-assistant-dock", className)}
      aria-label={heading}
      aria-modal={resolvedMobile || undefined}
      data-assistant-dock=""
      data-mobile={resolvedMobile ? "true" : "false"}
      data-mode={mode}
      data-side={side}
      data-status={status}
      onKeyDown={handleKeyDown}
      role={resolvedMobile ? "dialog" : undefined}
      tabIndex={-1}
    >
      <header className="sc-assistant-dock__header">
        <span className="sc-assistant-dock__mark" aria-hidden="true">
          {icon ?? <AssistantGlyph />}
        </span>
        <span className="sc-assistant-dock__identity">
          <span className="sc-assistant-dock__eyebrow">{eyebrow}</span>
          <strong className="sc-assistant-dock__heading">{heading}</strong>
          {description ? (
            <span className="sc-assistant-dock__description">
              {description}
            </span>
          ) : null}
        </span>
        <span className="sc-assistant-dock__actions">
          {headerActions}
          {onSideChange ? (
            <IconButton
              label={
                side === "start" ? "Dock on the right" : "Dock on the left"
              }
              className="sc-assistant-dock__desktop-control"
              onClick={() => onSideChange(side === "start" ? "end" : "start")}
            >
              <DockSideGlyph side={side === "start" ? "end" : "start"} />
            </IconButton>
          ) : null}
          <IconButton
            label={
              mode === "docked"
                ? "Float assistant"
                : `Dock on the ${side === "start" ? "left" : "right"}`
            }
            className="sc-assistant-dock__desktop-control"
            onClick={() =>
              onModeChange(mode === "docked" ? "floating" : "docked")
            }
          >
            {mode === "docked" ? <FloatGlyph /> : <DockSideGlyph side={side} />}
          </IconButton>
          <IconButton
            label="Collapse assistant"
            onClick={() => onModeChange("collapsed")}
          >
            <CollapseGlyph />
          </IconButton>
          {onRequestClose ? (
            <IconButton label="Close assistant" onClick={onRequestClose}>
              <CloseGlyph />
            </IconButton>
          ) : null}
        </span>
      </header>

      <div className="sc-assistant-dock__status" aria-live="polite">
        <span className="sc-assistant-dock__status-dot" aria-hidden="true" />
        <span>{statusLabel}</span>
      </div>

      {context ? (
        <section
          className="sc-assistant-dock__context"
          aria-label={contextLabel}
          data-assistant-context=""
        >
          <span className="sc-assistant-dock__context-label">
            {contextLabel}
          </span>
          <div className="sc-assistant-dock__context-content">{context}</div>
        </section>
      ) : null}

      <section
        className="sc-assistant-dock__conversation"
        aria-label="Conversation"
        data-assistant-conversation=""
        tabIndex={0}
      >
        {conversation ?? emptyConversation}
      </section>

      <section
        className="sc-assistant-dock__composer"
        aria-label="Message composer"
        data-assistant-composer=""
      >
        {composer}
      </section>

      {onWidthChange ? (
        <AssistantDockResizeHandle
          side={side}
          width={width}
          minimumWidth={minimumWidth}
          maximumWidth={maximumWidth}
          onWidthChange={onWidthChange}
        />
      ) : null}
    </aside>
  );
}

function useAssistantMobilePresentation(override: boolean | undefined) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (override !== undefined) return undefined;
    const query = window.matchMedia(MOBILE_MEDIA_QUERY);
    const update = () => setMatches(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [override]);

  return override ?? matches;
}

function containTabFocus(
  event: KeyboardEvent<HTMLElement>,
  shellRef: RefObject<HTMLElement | null>,
) {
  const shell = shellRef.current;
  if (!shell) return;
  const focusable = Array.from(
    shell.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), details > summary, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getAttribute("aria-hidden") !== "true");

  if (focusable.length === 0) {
    event.preventDefault();
    shell.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === shell)) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

interface AssistantDockResizeHandleProps {
  side: AssistantDockSide;
  width: number;
  minimumWidth?: number;
  maximumWidth?: number;
  onWidthChange: (width: number) => void;
}

export function AssistantDockResizeHandle({
  side,
  width,
  minimumWidth = MIN_DOCK_WIDTH,
  maximumWidth = MAX_DOCK_WIDTH,
  onWidthChange,
}: AssistantDockResizeHandleProps) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(
    null,
  );

  function resize(nextWidth: number) {
    onWidthChange(clamp(nextWidth, minimumWidth, maximumWidth));
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    drag.current = { pointerId: event.pointerId, x: event.clientX, width };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    const direction = side === "start" ? 1 : -1;
    resize(drag.current.width + (event.clientX - drag.current.x) * direction);
  }

  function endPointerResize(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleResizeKey(event: KeyboardEvent<HTMLDivElement>) {
    let nextWidth: number | null = null;
    if (event.key === "Home") nextWidth = minimumWidth;
    if (event.key === "End") nextWidth = maximumWidth;
    if (event.key === "ArrowLeft") {
      nextWidth =
        width + (side === "end" ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP);
    }
    if (event.key === "ArrowRight") {
      nextWidth =
        width +
        (side === "start" ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP);
    }
    if (nextWidth === null) return;
    event.preventDefault();
    resize(nextWidth);
  }

  return (
    <div
      className="sc-assistant-dock__resize"
      role="separator"
      aria-label="Resize assistant"
      aria-orientation="vertical"
      aria-valuemin={minimumWidth}
      aria-valuemax={maximumWidth}
      aria-valuenow={clamp(width, minimumWidth, maximumWidth)}
      data-side={side}
      tabIndex={0}
      onKeyDown={handleResizeKey}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endPointerResize}
      onPointerCancel={endPointerResize}
    />
  );
}

interface IconButtonProps {
  children: ReactNode;
  label: string;
  className?: string;
  onClick: () => void;
}

function IconButton({ children, label, className, onClick }: IconButtonProps) {
  return (
    <button
      className={classNames("sc-assistant-icon-button", className)}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function AssistantGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.75 13.8 8.2 19.25 10l-5.45 1.8L12 17.25l-1.8-5.45L4.75 10l5.45-1.8L12 2.75Z" />
      <path d="m18.25 15.5.75 2.25 2.25.75-2.25.75-.75 2.25-.75-2.25-2.25-.75 2.25-.75.75-2.25Z" />
    </svg>
  );
}

function DockSideGlyph({ side }: { side: AssistantDockSide }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d={side === "start" ? "M9 4v16" : "M15 4v16"} />
    </svg>
  );
}

function FloatGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="6" width="14" height="13" rx="2" />
      <path d="M9 6V4h12v12h-2" />
    </svg>
  );
}

function CollapseGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}
