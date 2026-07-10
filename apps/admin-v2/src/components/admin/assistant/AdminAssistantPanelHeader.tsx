import {
  Bot,
  Check,
  GripHorizontal,
  History,
  Minimize2,
  PanelLeft,
  PanelRight,
  PanelsTopLeft,
  Plus,
} from "lucide-react";
import type {
  KeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import { cn } from "@scalius/shared/utils";

import { Button } from "../../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../../ui/tooltip";
import type { AdminAssistantMode } from "./assistant-layout";

interface AdminAssistantPanelHeaderProps {
  canStartNewConversation: boolean;
  conversationHistoryIds: string[];
  contextLabel: string;
  mode: AdminAssistantMode;
  threadId: string;
  onConversationChange: (threadId: string) => void;
  onModeChange: (mode: AdminAssistantMode) => void;
  onMinimize: () => void;
  onMoveKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onMovePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onNewConversation: () => void;
}

const MODE_CONTROLS = [
  { mode: "dock-left", label: "Dock assistant left", icon: PanelLeft },
  { mode: "floating", label: "Use floating assistant", icon: PanelsTopLeft },
  { mode: "dock-right", label: "Dock assistant right", icon: PanelRight },
] as const;

export function AdminAssistantPanelHeader({
  canStartNewConversation,
  conversationHistoryIds,
  contextLabel,
  mode,
  threadId,
  onConversationChange,
  onModeChange,
  onMinimize,
  onMoveKeyDown,
  onMovePointerDown,
  onNewConversation,
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="Open assistant conversation history"
                disabled={conversationHistoryIds.length < 2}
              >
                <History className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Durable conversations</DropdownMenuLabel>
              {[...conversationHistoryIds]
                .reverse()
                .slice(0, 8)
                .map((conversationId, index) => {
                  const current = conversationId === threadId;
                  return (
                    <DropdownMenuItem
                      key={conversationId}
                      disabled={current || !canStartNewConversation}
                      onSelect={() => onConversationChange(conversationId)}
                    >
                      {current ? (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <History
                          className="h-3.5 w-3.5"
                          aria-hidden="true"
                        />
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {current
                          ? "Current conversation"
                          : `Earlier conversation ${index}`}
                      </span>
                      <span className="font-mono text-[9px] text-muted-foreground">
                        …{conversationId.slice(-6)}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 gap-1 px-2 text-[11px]"
            aria-label="New assistant conversation"
            disabled={!canStartNewConversation}
            onClick={onNewConversation}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            New
          </Button>

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
