import type { MouseEventHandler, ReactNode } from "react";
import { cn } from "@scalius/shared/utils";
import { Button } from "../button";
import { Tooltip, TooltipTrigger, TooltipContent } from "../tooltip";

interface ToolbarButtonProps {
  onClick: MouseEventHandler<HTMLButtonElement>;
  isActive?: boolean;
  disabled?: boolean;
  tooltip: string;
  buttonSize: string;
  children: ReactNode;
}

export function ToolbarButton({
  onClick,
  isActive,
  disabled,
  tooltip,
  buttonSize,
  children,
}: ToolbarButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClick}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          disabled={disabled}
          aria-label={tooltip}
          aria-pressed={isActive || undefined}
          className={cn(buttonSize, isActive && "bg-accent")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={5}>
        <p className="text-xs">{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}
