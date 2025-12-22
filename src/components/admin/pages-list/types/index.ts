// src/components/admin/pages-list/types/index.ts
import type { Page } from "@/db/schema";

export interface PageItem extends Page {
  // Add any additional computed properties if needed
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export type SortField = "title" | "createdAt" | "updatedAt" | "sortOrder";
export type SortOrder = "asc" | "desc";

export interface PagesListProps {
  showTrashed?: boolean;
}

export interface PageRowProps {
  page: PageItem;
  onDelete: (id: string, title: string) => void;
  onRestore: (id: string) => void;
  onToggleSelection: (id: string) => void;
  onPermanentDelete: (id: string, title: string) => void;
  isSelected: boolean;
  isActionLoading: boolean;
  showTrashed: boolean;
}

export interface PageStatisticsProps {
  total: number;
  publishedCount: number;
  draftCount: number;
}

export type BulkAction =
  | "trash"
  | "delete"
  | "restore"
  | "publish"
  | "unpublish"
  | null;
