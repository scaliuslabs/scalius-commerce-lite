// src/components/admin/widget-list/types/index.ts
import type { WidgetPlacementRule } from "@/db/schema";

export interface WidgetItem {
  id: string;
  name: string;
  htmlContent?: string;
  cssContent?: string | null;
  isActive: boolean;
  displayTarget: string;
  placementRule: WidgetPlacementRule;
  referenceCollectionId: string | null;
  sortOrder: number;
  createdAt: string | null;
  updatedAt: string | null;
  deletedAt?: string | null;
}

export interface CollectionOption {
  id: string;
  name: string;
  type: string;
  sortOrder: number;
}

export interface WidgetStatistics {
  total: number;
  active: number;
  inactive: number;
}

export interface WidgetsManagerProps {
  showTrashed?: boolean;
}

export interface WidgetToolbarProps {
  searchQuery: string;
  selectedCount: number;
  showTrashed: boolean;
  isActionLoading: boolean;
  onSearchChange: (value: string) => void;
  onBulkTrash: () => void;
  onBulkDelete: () => void;
  onBulkRestore: () => void;
  onBulkActivate: () => void;
  onBulkDeactivate: () => void;
  onOpenSettings: () => void;
}

export interface WidgetTableProps {
  widgets: WidgetItem[];
  collections: CollectionOption[];
  selectedIds: Set<string>;
  savingStates: Record<string, boolean>;
  isActionLoading: boolean;
  isLoading: boolean;
  showTrashed: boolean;
  searchQuery: string;
  onUpdate: (widgetId: string, data: Partial<WidgetItem>) => Promise<void>;
  onDelete: (widgetId: string, widgetName: string) => void;
  onRestore: (widgetId: string) => Promise<void>;
  onToggleSelection: (widgetId: string) => void;
  onToggleSelectAll: () => void;
  onCreateClick: () => void;
  onCopyShortcode: (widgetId: string) => void;
}

export interface WidgetRowProps {
  widget: WidgetItem;
  collections: CollectionOption[];
  onUpdate: (widgetId: string, data: Partial<WidgetItem>) => Promise<void>;
  onDelete: () => void;
  onRestore: () => void;
  onPermanentDelete: () => void;
  onToggleSelection: () => void;
  onCopyShortcode: () => void;
  isSelected: boolean;
  isSaving: boolean;
  isActionLoading: boolean;
  showTrashed: boolean;
}

export interface WidgetDeleteDialogProps {
  open: boolean;
  deleteDialog: DeleteDialogState | null;
  showTrashed: boolean;
  isActionLoading: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export interface BulkActionDialogProps {
  open: boolean;
  bulkAction: BulkAction | null;
  selectedCount: number;
  isActionLoading: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export interface WidgetStatisticsProps {
  total: number;
  activeCount: number;
  inactiveCount: number;
}

export interface DeleteDialogState {
  id: string;
  name: string;
}

export type BulkAction =
  | "trash"
  | "delete"
  | "restore"
  | "activate"
  | "deactivate";
