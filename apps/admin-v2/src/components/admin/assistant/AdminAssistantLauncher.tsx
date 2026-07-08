import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Bot } from "lucide-react";

import { Button } from "../../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../ui/tooltip";

const AdminAssistantPanel = lazy(() =>
  import("./AdminAssistantPanel").then((module) => ({
    default: module.AdminAssistantPanel,
  })),
);

export type AdminAssistantMode = "floating" | "sidebar";

export interface AdminAssistantPosition {
  x: number;
  y: number;
}

const EDGE_GAP = 16;
const BUBBLE_SIZE = 56;
const PANEL_WIDTH = 384;
const PANEL_HEIGHT = 560;

export function AdminAssistantLauncher() {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<AdminAssistantMode>("floating");
  const [bubblePosition, setBubblePosition] = useState<AdminAssistantPosition>({
    x: EDGE_GAP,
    y: EDGE_GAP,
  });
  const [panelPosition, setPanelPosition] = useState<AdminAssistantPosition>({
    x: EDGE_GAP,
    y: EDGE_GAP,
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    setMounted(true);
    setBubblePosition(getDefaultBubblePosition());
    setPanelPosition(getDefaultPanelPosition());
  }, []);

  useEffect(() => {
    if (!mounted) return undefined;

    const handleResize = () => {
      setBubblePosition((current) =>
        clampViewportPosition(current, BUBBLE_SIZE, BUBBLE_SIZE),
      );
      setPanelPosition((current) =>
        clampViewportPosition(current, PANEL_WIDTH, PANEL_HEIGHT),
      );
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [mounted]);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setHasOpened(true);
      return;
    }
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  const openAssistant = useCallback(() => {
    setPanelPosition((current) =>
      mode === "floating"
        ? clampViewportPosition(
            panelPositionFromBubble(bubblePosition),
            PANEL_WIDTH,
            PANEL_HEIGHT,
          )
        : current,
    );
    handleOpenChange(true);
  }, [bubblePosition, handleOpenChange, mode]);

  const handleBubblePointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) return;

    const startX = event.clientX;
    const startY = event.clientY;
    const startPosition = bubblePosition;
    let moved = false;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (Math.abs(deltaX) + Math.abs(deltaY) > 4) moved = true;
      setBubblePosition(
        clampViewportPosition(
          {
            x: startPosition.x + deltaX,
            y: startPosition.y + deltaY,
          },
          BUBBLE_SIZE,
          BUBBLE_SIZE,
        ),
      );
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      suppressClickRef.current = moved;
      if (!moved) openAssistant();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
  };

  if (!mounted) return null;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="default"
            size="icon"
            className="fixed z-[70] h-14 w-14 rounded-full border border-border/60 shadow-xl transition-transform hover:scale-105 active:scale-95"
            style={{
              left: `${bubblePosition.x}px`,
              top: `${bubblePosition.y}px`,
            }}
            aria-label="Open admin assistant"
            aria-expanded={open}
            onPointerDown={handleBubblePointerDown}
            onClick={(event) => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                event.preventDefault();
                return;
              }
              openAssistant();
            }}
            hidden={open}
          >
            <Bot className="h-5 w-5" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">Admin assistant</TooltipContent>
      </Tooltip>

      {hasOpened ? (
        <Suspense fallback={null}>
          <AdminAssistantPanel
            mode={mode}
            open={open}
            position={panelPosition}
            onModeChange={setMode}
            onOpenChange={handleOpenChange}
            onPositionChange={setPanelPosition}
          />
        </Suspense>
      ) : null}
    </>
  );
}

function getDefaultBubblePosition(): AdminAssistantPosition {
  if (typeof window === "undefined") return { x: EDGE_GAP, y: EDGE_GAP };
  return clampViewportPosition(
    {
      x: window.innerWidth - BUBBLE_SIZE - EDGE_GAP,
      y: window.innerHeight - BUBBLE_SIZE - EDGE_GAP,
    },
    BUBBLE_SIZE,
    BUBBLE_SIZE,
  );
}

function getDefaultPanelPosition(): AdminAssistantPosition {
  if (typeof window === "undefined") return { x: EDGE_GAP, y: EDGE_GAP };
  return clampViewportPosition(
    {
      x: window.innerWidth - PANEL_WIDTH - EDGE_GAP,
      y: window.innerHeight - PANEL_HEIGHT - EDGE_GAP,
    },
    PANEL_WIDTH,
    PANEL_HEIGHT,
  );
}

function panelPositionFromBubble(
  bubblePosition: AdminAssistantPosition,
): AdminAssistantPosition {
  return {
    x: bubblePosition.x + BUBBLE_SIZE - PANEL_WIDTH,
    y: bubblePosition.y + BUBBLE_SIZE - PANEL_HEIGHT,
  };
}

function clampViewportPosition(
  position: AdminAssistantPosition,
  width: number,
  height: number,
): AdminAssistantPosition {
  if (typeof window === "undefined") return position;

  const maxX = Math.max(EDGE_GAP, window.innerWidth - width - EDGE_GAP);
  const maxY = Math.max(EDGE_GAP, window.innerHeight - height - EDGE_GAP);
  return {
    x: Math.min(maxX, Math.max(EDGE_GAP, position.x)),
    y: Math.min(maxY, Math.max(EDGE_GAP, position.y)),
  };
}
