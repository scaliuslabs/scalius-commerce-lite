import {
  Bot,
  Move,
} from "lucide-react";
import {
  useRef,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { Button } from "../../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../ui/tooltip";
import {
  clampAdminAssistantPosition,
  getAdminAssistantViewport,
  ADMIN_ASSISTANT_BUBBLE_SIZE,
  type AdminAssistantPosition,
} from "./assistant-layout";
import { usePointerGesture } from "./usePointerGesture";

interface AdminAssistantBubbleProps {
  open: boolean;
  position: AdminAssistantPosition;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
  onPositionChange: (position: AdminAssistantPosition) => void;
}

const KEYBOARD_MOVE_STEP = 12;

export function AdminAssistantBubble({
  open,
  position,
  triggerRef,
  onOpen,
  onPositionChange,
}: AdminAssistantBubbleProps) {
  const suppressClickRef = useRef(false);
  const startPointerGesture = usePointerGesture();

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const multiplier = event.shiftKey ? 3 : 1;
    const step = KEYBOARD_MOVE_STEP * multiplier;
    const delta = getKeyboardMoveDelta(event.key, step);
    if (!delta) return;
    event.preventDefault();
    onPositionChange(
      clampAdminAssistantPosition(
        { x: position.x + delta.x, y: position.y + delta.y },
        {
          width: ADMIN_ASSISTANT_BUBBLE_SIZE,
          height: ADMIN_ASSISTANT_BUBBLE_SIZE,
        },
        getAdminAssistantViewport(),
      ),
    );
  }

  return (
    <>
      <p id="admin-assistant-bubble-help" className="sr-only">
        Press Enter to open. Use the arrow keys to move the assistant button;
        hold Shift for larger steps.
      </p>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            size="icon"
            className="group fixed z-[70] h-14 w-14 touch-none rounded-full border border-primary-foreground/15 bg-primary text-primary-foreground shadow-2xl shadow-primary/30 transition-[transform,box-shadow] motion-reduce:transition-none hover:-translate-y-0.5 hover:shadow-primary/40 active:translate-y-0"
            style={{ left: position.x, top: position.y }}
            aria-label="Open admin assistant"
            aria-describedby="admin-assistant-bubble-help"
            aria-expanded={open}
            aria-controls="admin-assistant-panel"
            hidden={open}
            onKeyDown={handleKeyDown}
            onPointerDown={(event) => {
              const startPosition = position;
              startPointerGesture(event, {
                onMove: (deltaX, deltaY) => {
                  onPositionChange({
                    x: startPosition.x + deltaX,
                    y: startPosition.y + deltaY,
                  });
                },
                onEnd: (moved) => {
                  suppressClickRef.current = moved;
                },
              });
            }}
            onClick={(event) => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                event.preventDefault();
                return;
              }
              onOpen();
            }}
          >
            <Bot className="h-5 w-5 transition-transform group-hover:scale-105 motion-reduce:transition-none" aria-hidden="true" />
            <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-background bg-emerald-500">
              <Move className="h-2.5 w-2.5 text-white" aria-hidden="true" />
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="left">Admin assistant · drag to move</TooltipContent>
      </Tooltip>
    </>
  );
}

function getKeyboardMoveDelta(
  key: string,
  step: number,
): AdminAssistantPosition | null {
  if (key === "ArrowLeft") return { x: -step, y: 0 };
  if (key === "ArrowRight") return { x: step, y: 0 };
  if (key === "ArrowUp") return { x: 0, y: -step };
  if (key === "ArrowDown") return { x: 0, y: step };
  return null;
}
