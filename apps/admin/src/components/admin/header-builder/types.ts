// src/components/admin/header-builder/types.ts

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
 * Top bar / announcement bar configuration
 */
export interface TopBarConfig {
  text: string;
  isEnabled: boolean;
}

/**
 * Logo configuration
 */
export interface LogoConfig {
  src: string;
  alt: string;
}

/**
 * Favicon configuration
 */
export interface FaviconConfig {
  src: string;
  alt: string;
}

/**
 * Contact information configuration
 */
export interface ContactConfig {
  phone: string;
  text: string;
  isEnabled: boolean;
}

/**
 * Navigation item structure (reusing from navigation module)
 */
export interface NavigationItem {
  id: string;
  title: string;
  href?: string;
  subMenu?: NavigationItem[];
}

/**
 * Complete header configuration
 */
export interface HeaderConfig {
  topBar: TopBarConfig;
  logo: LogoConfig;
  favicon: FaviconConfig;
  contact: ContactConfig;
  social: SocialLink[];
  navigation: NavigationItem[];
}

/**
 * Props for the main HeaderBuilder component
 */
export interface HeaderBuilderProps {
  initialConfig?: HeaderConfig | null;
  onSave?: string | ((config: HeaderConfig) => Promise<void>);
}

/**
 * Default configuration for new sites
 */
export const defaultHeaderConfig: HeaderConfig = {
  topBar: {
    text: "",
    isEnabled: false,
  },
  logo: {
    src: "",
    alt: "",
  },
  favicon: {
    src: "",
    alt: "",
  },
  contact: {
    phone: "",
    text: "",
    isEnabled: false,
  },
  social: [],
  navigation: [],
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
