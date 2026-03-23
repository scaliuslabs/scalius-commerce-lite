// src/components/admin/header-builder/types.ts

import type { SocialLink, LogoConfig } from "~/components/admin/shared/builder-types";
import type { NavigationItem } from "~/components/admin/navigation/types";
import type { MediaFile } from "~/components/admin/media-manager/types";

export type { SocialLink, LogoConfig, NavigationItem, MediaFile };

/**
 * Top bar / announcement bar configuration
 */
export interface TopBarConfig {
  text: string;
  isEnabled: boolean;
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
