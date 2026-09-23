// src/components/admin/attributes-manager/types/index.ts
import type { ProductAttribute } from "~/types/api-responses";

export interface Attribute extends ProductAttribute {
  valueCount?: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export type SortField = "name" | "slug" | "filterable" | "updatedAt";
export type SortOrder = "asc" | "desc";

export interface NewAttribute {
  name: string;
  slug: string;
  filterable: boolean;
  options?: string[];
}

export interface AttributeValue {
  value: string;
  productCount: number;
  sampleProducts: string[];
  isPreset?: boolean;
}

export interface AttributeValuesViewerProps {
  attributeId: string | null;
  attributeName: string | null;
  onClose: () => void;
  openerRef: React.RefObject<HTMLElement | null>;
}

export interface DeleteDialogState {
  id: string;
  name: string;
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
  fallbackFocusRef: React.RefObject<HTMLElement | null>;
  openerRef: React.RefObject<HTMLElement | null>;
}

export interface AttributeDeleteDialogProps {
  open: boolean;
  deleteDialog: DeleteDialogState | null;
  showTrashed: boolean;
  isActionLoading: boolean;
  onOpenChange: () => void;
  onConfirm: () => void;
}
