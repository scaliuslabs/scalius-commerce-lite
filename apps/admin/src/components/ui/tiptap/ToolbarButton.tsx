import { cn } from "@scalius/shared/utils";
import { Button } from "../button";
import { Tooltip, TooltipTrigger, TooltipContent } from "../tooltip";

interface ToolbarButtonProps {
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
  tooltip: string;
  buttonSize: string;
  children: React.ReactNode;
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
          disabled={disabled}
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
