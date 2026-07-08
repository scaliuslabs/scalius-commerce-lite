import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { MessageSquareText } from "lucide-react";

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

export function AdminAssistantLauncher() {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setHasOpened(true);
      return;
    }
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-9 text-muted-foreground hover:text-foreground"
            aria-label="Open admin assistant"
            aria-expanded={open}
            onClick={() => handleOpenChange(true)}
          >
            <MessageSquareText className="h-4 w-4" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Admin assistant</TooltipContent>
      </Tooltip>

      {hasOpened ? (
        <Suspense fallback={null}>
          <AdminAssistantPanel open={open} onOpenChange={handleOpenChange} />
        </Suspense>
      ) : null}
    </>
  );
}
