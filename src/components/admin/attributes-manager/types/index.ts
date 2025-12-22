// src/components/admin/attributes-manager/types/index.ts
import type { ProductAttribute } from "@/db/schema";

export interface Attribute extends ProductAttribute {
  valueCount?: number;
}

export interface AttributesManagerProps {
  showTrashed?: boolean;
}

export interface AttributeRowProps {
  attribute: Attribute;
  onUpdate: (
    id: string,
    data: Partial<Pick<Attribute, "name" | "slug" | "filterable">>,
  ) => void;
  onDelete: () => void;
  onRestore: () => void;
  onToggleSelection: () => void;
  onPermanentDelete: () => void;
  onViewValues: () => void;
  onEditValues: () => void;
  isSelected: boolean;
  isSaving: boolean;
  isActionLoading: boolean;
  showTrashed: boolean;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export type SortField = "name" | "slug" | "filterable" | "updatedAt";
export type SortOrder = "asc" | "desc";

export interface AttributeFilters {
  searchQuery: string;
  sortField: SortField;
  sortOrder: SortOrder;
}

export interface NewAttribute {
  name: string;
  slug: string;
  filterable: boolean;
  options?: string[];
}

export interface AttributeValue {
  value: string;
  productCount: number;
  productNames: string[];
  isPreset?: boolean;
}

export interface AttributeValuesViewerProps {
  attributeId: string | null;
  attributeName: string | null;
  onClose: () => void;
}

export interface DeleteDialogState {
  id: string;
  name: string;
}

export type BulkAction = "trash" | "delete" | "restore" | null;

export interface AttributeStatisticsProps {
  total: number;
  filterableCount: number;
  totalValueCount: number;
}

export interface AttributeToolbarProps {
  searchQuery: string;
  selectedCount: number;
  showTrashed: boolean;
  isActionLoading: boolean;
  onSearchChange: (query: string) => void;
  onBulkTrash: () => void;
  onBulkDelete: () => void;
  onBulkRestore: () => void;
  onCreateClick: () => void;
}

export interface AttributeTableProps {
  attributes: Attribute[];
  selectedIds: Set<string>;
  savingStates: Record<string, boolean>;
  isActionLoading: boolean;
  isLoading: boolean;
  showTrashed: boolean;
  searchQuery: string;
  sortField: SortField;
  sortOrder: SortOrder;
  onSort: (field: SortField) => void;
  onUpdate: (id: string, data: Partial<Attribute>) => void;
  onDelete: (id: string, name: string) => void;
  onRestore: (id: string) => void;
  onViewValues: (id: string, name: string) => void;
  onEditValues: (id: string, name: string) => void;
  onToggleSelection: (id: string) => void;
  onToggleSelectAll: () => void;
  onCreateClick: () => void;
}

export interface AttributePaginationProps {
  pagination: Pagination;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export interface AttributeCreateDialogProps {
  open: boolean;
  newAttribute: NewAttribute;
  isCreating: boolean;
  onOpenChange: (open: boolean) => void;
  onNameChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSlugChange: (slug: string) => void;
  onFilterableChange: (checked: boolean) => void;
  onOptionsChange?: (options: string[]) => void;
  onCreate: () => void;
}

export interface AttributeDeleteDialogProps {
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
