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

export function ToolbarButton({ onClick, isActive, disabled, tooltip, children }: ToolbarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0 sm:h-8 sm:w-8 pointer-coarse:h-11 pointer-coarse:w-11"
          onClick={onClick}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          disabled={disabled}
          aria-label={tooltip}
          aria-pressed={isActive || undefined}
        >
          <span className={isActive ? "inline-flex text-foreground" : "inline-flex text-muted-foreground"}>{children}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
