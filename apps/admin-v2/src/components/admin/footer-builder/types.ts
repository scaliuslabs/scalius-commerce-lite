// src/components/admin/footer-builder/types.ts

import type { SocialLink, LogoConfig } from "~/components/admin/shared/builder-types";
import type { NavigationItem } from "~/components/admin/navigation/types";
import type { MediaFile } from "~/components/admin/media-manager/types";

export type { SocialLink, LogoConfig, NavigationItem, MediaFile };

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
