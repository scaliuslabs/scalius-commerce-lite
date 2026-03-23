// Media Manager Types

export interface MediaFile {
  id: string;
  url: string;
  filename: string;
  size: number;
  mimeType?: string; // Optional for backward compatibility
  folderId?: string | null;
  createdAt: Date;
  updatedAt?: Date;
}

export interface MediaFolder {
  id: string;
  name: string;
  parentId?: string | null;
  createdAt: Date;
  updatedAt?: Date;
}

export interface MediaPagination {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface MediaApiResponse {
  files: MediaFile[];
  pagination: MediaPagination;
}

export interface MediaFoldersApiResponse {
  folders: MediaFolder[];
}

export interface UploadProgress {
  fileIndex: number;
  fileName: string;
  progress: number;
  total: number;
}

export interface MediaManagerProps {
  onSelect?: (file: MediaFile) => void;
  onSelectMultiple?: (files: MediaFile[]) => void;
  selectedFiles?: MediaFile[];
  triggerLabel?: string;
  acceptedFileTypes?: string;
  maxFileSize?: number; // in MB
  dialogClassName?: string; // Custom className for DialogContent (e.g., for z-index)
  trigger?: React.ReactNode;
}

export interface MediaGalleryProps {
  files: MediaFile[];
  selectedFileIds: string[];
  selectionMode: boolean;
  onFileSelect: (file: MediaFile) => void;
  onFileDelete: (fileId: string) => void;
  onFilePreview: (file: MediaFile, e: React.MouseEvent) => void;
  toggleFileSelection: (fileId: string) => void;
  isLoading?: boolean;
}

export interface MediaUploadZoneProps {
  onUpload: (files: FileList | null) => Promise<void>;
  isUploading: boolean;
  uploadProgress?: UploadProgress[];
  acceptedFileTypes?: string;
  maxFileSize?: number;
}

export interface MediaPreviewDialogProps {
  open: boolean;
  file: MediaFile | null;
  files: MediaFile[];
  onOpenChange: (open: boolean) => void;
  onNavigateNext: () => void;
  onNavigatePrev: () => void;
  onSelect?: (file: MediaFile) => void;
}

export interface MediaFilterOptions {
  search: string;
  folderId?: string | null;
  sortBy?: "createdAt" | "filename" | "size";
  sortOrder?: "asc" | "desc";
  fileType?: string;
  dateFrom?: Date;
  dateTo?: Date;
}

export interface MediaStats {
  totalFiles: number;
  totalSize: number;
  filesByType: Record<string, number>;
}

export const DEFAULT_MAX_FILE_SIZE = 10; // MB
export const MAX_FILES_PER_UPLOAD = 20; // Maximum files per upload
export const DEFAULT_ACCEPTED_TYPES = "image/*";
export const ITEMS_PER_PAGE = 20;
