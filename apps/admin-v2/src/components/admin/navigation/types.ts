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

// Public desktop/mobile menus are intentionally capped at three visible levels.
// Deeper trees are difficult to scan, operate by keyboard, and render on mobile.
export const MAX_NAV_DEPTH = 3;

// Helper to get depth indicator color based on level
export function getDepthColor(depth: number): string {
  const colors = [
    "border-l-foreground/50",
    "border-l-muted-foreground/40",
    "border-l-muted-foreground/20",
  ];
  return colors[depth % colors.length];
}
