// src/components/admin/collections-list/types/index.ts
import type { Collection } from "@/db/schema";

export interface CollectionItem extends Collection {
  productCount?: number;
}

export interface CollectionsManagerProps {
  showTrashed?: boolean;
}

export interface CollectionConfig {
  categoryIds: string[];
  productIds: string[];
  featuredProductId?: string;
  maxProducts: number;
  title?: string;
  subtitle?: string;
}

export interface CollectionRowProps {
  collection: CollectionItem;
  onUpdate: (id: string, data: Partial<CollectionItem>) => void;
  onDelete: () => void;
  onRestore: () => void;
  onToggleSelection: () => void;
  onPermanentDelete: () => void;
  isSelected: boolean;
  isSaving: boolean;
  isActionLoading: boolean;
  showTrashed: boolean;
  dragHandleProps?: any;
  isDragging?: boolean;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export type SortField =
  | "name"
  | "type"
  | "sortOrder"
  | "isActive"
  | "updatedAt";
export type SortOrder = "asc" | "desc";

export interface CollectionFilters {
  searchQuery: string;
  sortField: SortField;
  sortOrder: SortOrder;
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
  | "deactivate"
  | null;

export interface CollectionStatisticsProps {
  total: number;
  activeCount: number;
  inactiveCount: number;
}

export interface CollectionToolbarProps {
  searchQuery: string;
  selectedCount: number;
  showTrashed: boolean;
  isActionLoading: boolean;
  onSearchChange: (query: string) => void;
  onBulkTrash: () => void;
  onBulkDelete: () => void;
  onBulkRestore: () => void;
  onBulkActivate: () => void;
  onBulkDeactivate: () => void;
}

export interface CollectionTableProps {
  collections: CollectionItem[];
  selectedIds: Set<string>;
  savingStates: Record<string, boolean>;
  isActionLoading: boolean;
  isLoading: boolean;
  showTrashed: boolean;
  searchQuery: string;
  sortField: SortField;
  sortOrder: SortOrder;
  isDragging: boolean;
  onSort: (field: SortField) => void;
  onUpdate: (id: string, data: Partial<CollectionItem>) => void;
  onDelete: (id: string, name: string) => void;
  onRestore: (id: string) => void;
  onToggleSelection: (id: string) => void;
  onToggleSelectAll: () => void;
  onCreateClick: () => void;
  onDragEnd: (result: any) => void;
  onDragStart: () => void;
}

export interface CollectionPaginationProps {
  pagination: Pagination;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export interface CollectionDeleteDialogProps {
  open: boolean;
  deleteDialog: DeleteDialogState | null;
  showTrashed: boolean;
  isActionLoading: boolean;
  onOpenChange: () => void;
  onConfirm: () => void;
}

export interface BulkActionDialogProps {
  open: boolean;
  bulkAction: BulkAction;
  selectedCount: number;
  isActionLoading: boolean;
  onOpenChange: () => void;
  onConfirm: () => void;
}
