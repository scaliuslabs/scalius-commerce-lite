import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";

import {
  AssistantDockLayout,
  type AssistantDockMode,
  type AssistantDockSide,
} from "@scalius/ui/assistant";
import "@scalius/ui/assistant/styles.css";

import { TooltipProvider } from "../../ui/tooltip";
import { AdminAssistantBubble } from "./AdminAssistantBubble";
import { useAdminAssistantLayout } from "./useAdminAssistantLayout";

export type {
  AdminAssistantMode,
  AdminAssistantPosition,
  AdminAssistantSize,
} from "./assistant-layout";

const AdminAssistantPanel = lazy(() =>
  import("./AdminAssistantPanel").then((module) => ({
    default: module.AdminAssistantPanel,
  })),
);

type AdminAssistantLauncherProps = PropsWithChildren;

export function AdminAssistantLauncher({
  children,
}: AdminAssistantLauncherProps) {
  const layout = useAdminAssistantLayout();
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const layoutMode = layout.mode;
  const positionPanelFromBubble = layout.positionPanelFromBubble;

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setHasOpened(true);
      return;
    }
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  const openAssistant = useCallback(() => {
    if (layoutMode === "floating") positionPanelFromBubble();
    handleOpenChange(true);
  }, [handleOpenChange, layoutMode, positionPanelFromBubble]);

  useEffect(() => {
    if (!layout.mounted) return undefined;
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || !event.shiftKey || event.key.toLowerCase() !== "a") {
        return;
      }
      event.preventDefault();
      if (open) handleOpenChange(false);
      else openAssistant();
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [handleOpenChange, layout.mounted, open, openAssistant]);

  const structuralMode: AssistantDockMode = !open
    ? "closed"
    : layout.mode === "floating"
      ? "floating"
      : "docked";
  const structuralSide: AssistantDockSide =
    layout.mode === "dock-left" ? "start" : "end";

  const panel = hasOpened ? (
    <Suspense
      fallback={
        <div
          role="status"
          className="fixed bottom-4 right-4 z-[80] rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground shadow-lg"
        >
          Opening assistant…
        </div>
      }
    >
      <AdminAssistantPanel
        mode={layout.mode}
        open={open}
        position={layout.panelPosition}
        size={layout.panelSize}
        onModeChange={layout.setMode}
        onOpenChange={handleOpenChange}
        onPositionChange={layout.setPanelPosition}
        onSizeChange={layout.setPanelSize}
      />
    </Suspense>
  ) : null;

  return (
    <TooltipProvider delayDuration={0}>
      <AssistantDockLayout
        mode={structuralMode}
        side={structuralSide}
        width={layout.panelSize.width}
        dock={panel}
        className="min-w-0 flex-1"
        data-admin-assistant-workspace=""
      >
        {children}
        {layout.mounted ? (
          <AdminAssistantBubble
            open={open}
            position={layout.bubblePosition}
            triggerRef={triggerRef}
            onOpen={openAssistant}
            onPositionChange={layout.setBubblePosition}
          />
        ) : null}
      </AssistantDockLayout>
    </TooltipProvider>
  );
}
