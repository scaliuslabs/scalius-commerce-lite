import type { MouseEventHandler, ReactNode } from "react";
import { Button } from "../button";
import { Tooltip, TooltipTrigger, TooltipContent } from "../tooltip";

interface ToolbarButtonProps {
  onClick: MouseEventHandler<HTMLButtonElement>;
  isActive?: boolean;
  disabled?: boolean;
  tooltip: string;
  compact?: boolean;
  children: ReactNode;
}

export function ToolbarButton({ onClick, isActive, disabled, tooltip, compact = false, children }: ToolbarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={compact ? "icon-sm" : "icon"}
          onClick={onClick}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          disabled={disabled}
          aria-label={tooltip}
          aria-pressed={isActive || undefined}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
