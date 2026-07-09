import {
  Bot,
  GripHorizontal,
  Minimize2,
  PanelLeft,
  PanelRight,
  PanelsTopLeft,
} from "lucide-react";
import type {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import { cn } from "@scalius/shared/utils";

import { Button } from "../../ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../ui/tooltip";
import type { AdminAssistantMode } from "./assistant-layout";

interface AdminAssistantPanelHeaderProps {
  contextLabel: string;
  mode: AdminAssistantMode;
  onModeChange: (mode: AdminAssistantMode) => void;
  onMinimize: () => void;
  onMoveKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onMovePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

const MODE_CONTROLS = [
  { mode: "dock-left", label: "Dock assistant left", icon: PanelLeft },
  { mode: "floating", label: "Use floating assistant", icon: PanelsTopLeft },
  { mode: "dock-right", label: "Dock assistant right", icon: PanelRight },
] as const;

export function AdminAssistantPanelHeader({
  contextLabel,
  mode,
  onModeChange,
  onMinimize,
  onMoveKeyDown,
  onMovePointerDown,
}: AdminAssistantPanelHeaderProps) {
  return (
    <header className="relative border-b border-border/80 bg-background/95 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
            <Bot className="h-[18px] w-[18px]" aria-hidden="true" />
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-emerald-500" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold tracking-tight">
                Admin assistant
              </h2>
              <span className="rounded-full border border-border bg-muted/70 px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Live context
              </span>
            </div>
            <p id="admin-assistant-context" className="mt-0.5 truncate text-xs text-muted-foreground">
              {contextLabel}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {mode === "floating" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 touch-none cursor-move"
                  aria-label="Move assistant"
                  aria-describedby="admin-assistant-move-help"
                  onKeyDown={onMoveKeyDown}
                  onPointerDown={onMovePointerDown}
                >
                  <GripHorizontal className="h-4 w-4" aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Drag window</TooltipContent>
            </Tooltip>
          ) : null}
          <span id="admin-assistant-move-help" className="sr-only">
            Drag to move, or use the arrow keys. Hold Shift for larger steps.
          </span>

          <div
            role="group"
            aria-label="Assistant layout"
            className="flex items-center rounded-md border border-border bg-muted/40 p-0.5"
          >
            {MODE_CONTROLS.map((control) => {
              const Icon = control.icon;
              const active = mode === control.mode;
              return (
                <Tooltip key={control.mode}>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn(
                        "h-7 w-7 rounded-[4px]",
                        active && "bg-background text-foreground shadow-sm hover:bg-background",
                      )}
                      aria-label={control.label}
                      aria-pressed={active}
                      onClick={() => onModeChange(control.mode)}
                    >
                      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">{control.label}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="Minimize admin assistant"
                onClick={onMinimize}
              >
                <Minimize2 className="h-4 w-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Minimize</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </header>
  );
}
