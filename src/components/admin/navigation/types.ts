// src/components/admin/navigation/types.ts

export interface NavigationItem {
  id: string;
  title: string;
  href?: string; // Optional - can have both href AND subMenu for dropdown links
  subMenu?: NavigationItem[];
}

export interface NavigationSource {
  id: string;
  name: string;
  slug: string;
  type: string;
  url: string;
}

export interface NavigationSources {
  categories: NavigationSource[];
  pages: NavigationSource[];
}

export interface NavigationBuilderProps {
  navigation: NavigationItem[];
  onChange: (navigation: NavigationItem[]) => void;
  getStorefrontPath: (path: string) => string;
}

export interface SortableNavItemProps {
  item: NavigationItem;
  index: number;
  depth: number;
  maxDepth?: number;
  onUpdate: (
    path: string,
    index: number,
    item: Partial<NavigationItem>,
  ) => void;
  onRemove: (path: string, index: number) => void;
  onAddSubItem: (path: string, index: number) => void;
  parentPath: string;
  getStorefrontPath: (path: string) => string;
}

export interface AddNavItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddItems: (items: NavigationItem[]) => void;
}

export const MAX_NAV_DEPTH = 10;

// Helper to get depth indicator color based on level
export function getDepthColor(depth: number): string {
  const colors = [
    "border-l-blue-500",
    "border-l-green-500",
    "border-l-purple-500",
    "border-l-orange-500",
    "border-l-pink-500",
    "border-l-cyan-500",
    "border-l-yellow-500",
    "border-l-red-500",
    "border-l-indigo-500",
    "border-l-teal-500",
  ];
  return colors[depth % colors.length];
}
