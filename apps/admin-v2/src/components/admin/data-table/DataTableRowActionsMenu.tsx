import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AlertTriangle, Eye, Pencil, Trash2, Undo } from "lucide-react";
import type { ExtraAction } from "./DataTableRowActions";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

export interface DataTableRowActionsMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  showTrashed?: boolean;
  onView?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onRestore?: () => void;
  onPermanentDelete?: () => void;
  extraActions?: ExtraAction[];
  children?: ReactNode;
}

export function DataTableRowActionsMenu({
  open,
  onOpenChange,
  trigger,
  showTrashed = false,
  onView,
  onEdit,
  onDelete,
  onRestore,
  onPermanentDelete,
  extraActions,
  children,
}: DataTableRowActionsMenuProps) {
  const t = useMessages(resourceMessages);
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {children}
        {onView && (
          <DropdownMenuItem onClick={onView}>
            <Eye className="mr-2 h-3.5 w-3.5" />
            {t("view")}
          </DropdownMenuItem>
        )}
        {onEdit && !showTrashed && (
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 h-3.5 w-3.5" />
            {t("edit")}
          </DropdownMenuItem>
        )}
        {extraActions?.map((action) => (
          <DropdownMenuItem
            key={action.label}
            onClick={() => action.onClick()}
            variant={action.destructive ? "destructive" : "default"}
          >
            {action.icon && <action.icon className="mr-2 h-3.5 w-3.5" />}
            {action.label}
          </DropdownMenuItem>
        ))}
        {(onDelete || onRestore || onPermanentDelete) && (
          <DropdownMenuSeparator />
        )}
        {showTrashed ? (
          <>
            {onRestore && (
              <DropdownMenuItem onClick={onRestore}>
                <Undo className="mr-2 h-3.5 w-3.5" />
                {t("restore")}
              </DropdownMenuItem>
            )}
            {onPermanentDelete && (
              <DropdownMenuItem onClick={onPermanentDelete} variant="destructive">
                <AlertTriangle className="mr-2 h-3.5 w-3.5" />
                {t("deletePermanently")}
              </DropdownMenuItem>
            )}
          </>
        ) : (
          onDelete && (
            <DropdownMenuItem onClick={onDelete} variant="destructive">
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              {t("moveToTrash")}
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
