import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { MoreHorizontal } from "lucide-react";
import type { DataTableRowActionsMenuProps } from "./DataTableRowActionsMenu";

export interface ExtraAction {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  destructive?: boolean;
}

interface DataTableRowActionsProps {
  showTrashed?: boolean;
  onView?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onRestore?: () => void;
  onPermanentDelete?: () => void;
  extraActions?: ExtraAction[];
  isLoading?: boolean;
  children?: ReactNode;
}

const LazyDataTableRowActionsMenu = lazy(async () => {
  const module = await import("./DataTableRowActionsMenu");
  return {
    default: module.DataTableRowActionsMenu as ComponentType<
      DataTableRowActionsMenuProps
    >,
  };
});

function isMenuOpenKey(key: string) {
  return key === "Enter" || key === " " || key === "ArrowDown";
}

export const DataTableRowActions = memo(function DataTableRowActions({
  showTrashed = false,
  onView,
  onEdit,
  onDelete,
  onRestore,
  onPermanentDelete,
  extraActions,
  isLoading = false,
  children,
}: DataTableRowActionsProps) {
  const [isMenuRequested, setIsMenuRequested] = useState(false);
  const [open, setOpen] = useState(false);

  const requestMenuOpen = useCallback(() => {
    setIsMenuRequested(true);
    setOpen(true);
  }, []);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      setIsMenuRequested(true);
    }
    setOpen(nextOpen);
  }, []);

  const handleTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (!isMenuOpenKey(event.key)) {
        return;
      }

      event.preventDefault();
      requestMenuOpen();
    },
    [requestMenuOpen],
  );

  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 w-8 p-0"
      data-state={open ? "open" : undefined}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={isLoading}
      onClick={isMenuRequested ? undefined : requestMenuOpen}
      onKeyDown={isMenuRequested ? undefined : handleTriggerKeyDown}
    >
      <span className="sr-only">Open menu</span>
      <MoreHorizontal className="h-4 w-4" />
    </Button>
  );

  return (
    <>
      {isMenuRequested ? (
        <Suspense fallback={trigger}>
          <LazyDataTableRowActionsMenu
            open={open}
            onOpenChange={handleOpenChange}
            trigger={trigger}
            showTrashed={showTrashed}
            onView={onView}
            onEdit={onEdit}
            onDelete={onDelete}
            onRestore={onRestore}
            onPermanentDelete={onPermanentDelete}
            extraActions={extraActions}
          >
            {children}
          </LazyDataTableRowActionsMenu>
        </Suspense>
      ) : (
        trigger
      )}
    </>
  );
});
