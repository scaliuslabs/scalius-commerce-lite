import { memo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreHorizontal, Eye, Pencil, Trash2, Undo, AlertTriangle } from "lucide-react";

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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" disabled={isLoading}>
          <span className="sr-only">Open menu</span>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {children}
        {onView && (
          <DropdownMenuItem onClick={onView}>
            <Eye className="mr-2 h-3.5 w-3.5" />
            View
          </DropdownMenuItem>
        )}
        {onEdit && !showTrashed && (
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="mr-2 h-3.5 w-3.5" />
            Edit
          </DropdownMenuItem>
        )}
        {extraActions?.map((action) => (
          <DropdownMenuItem
            key={action.label}
            onClick={action.onClick}
            className={action.destructive ? "text-destructive" : ""}
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
                Restore
              </DropdownMenuItem>
            )}
            {onPermanentDelete && (
              <DropdownMenuItem
                onClick={onPermanentDelete}
                className="text-destructive"
              >
                <AlertTriangle className="mr-2 h-3.5 w-3.5" />
                Delete Permanently
              </DropdownMenuItem>
            )}
          </>
        ) : (
          onDelete && (
            <DropdownMenuItem onClick={onDelete} className="text-destructive">
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Move to Trash
            </DropdownMenuItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
