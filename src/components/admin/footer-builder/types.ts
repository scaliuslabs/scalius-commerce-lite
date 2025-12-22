// src/components/admin/footer-builder/types.ts

/**
 * Social link item - fully custom, user-defined label and optional icon
 */
export interface SocialLink {
  id: string;
  label: string; // User-defined label (e.g., "Twitter/X", "WhatsApp Business")
  url: string; // Link URL
  iconUrl?: string; // Optional uploaded icon URL
}

/**
 * Logo configuration
 */
export interface LogoConfig {
  src: string;
  alt: string;
}

/**
 * Navigation item structure
 */
export interface NavigationItem {
  id: string;
  title: string;
  href?: string;
  subMenu?: NavigationItem[];
}

/**
 * Footer menu column
 */
export interface FooterMenu {
  id: string;
  title: string;
  links: NavigationItem[];
}

/**
 * Complete footer configuration
 */
export interface FooterConfig {
  logo: LogoConfig;
  tagline: string;
  description: string;
  copyrightText: string;
  menus: FooterMenu[];
  social: SocialLink[];
}

/**
 * Props for the main FooterBuilder component
 */
export interface FooterBuilderProps {
  initialConfig?: FooterConfig | null;
  onSave?: string | ((config: FooterConfig) => Promise<void>);
}

/**
 * Default configuration for new sites
 */
export const defaultFooterConfig: FooterConfig = {
  logo: {
    src: "",
    alt: "",
  },
  tagline: "",
  description: "",
  copyrightText: `© ${new Date().getFullYear()} Your Company Name. All Rights Reserved.`,
  menus: [],
  social: [],
};

/**
 * Media file interface for MediaManager
 */
export interface MediaFile {
  id: string;
  url: string;
  filename: string;
  size: number;
  createdAt: Date;
}
