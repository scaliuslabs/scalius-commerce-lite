// src/components/admin/footer-builder/types.ts

import type { SocialLink, LogoConfig } from "~/components/admin/shared/builder-types";
import type { NavigationItem } from "~/components/admin/navigation/types";
import type { MediaFile } from "~/components/admin/media-manager/types";
import type { NavigationConfigSectionReadiness } from "~/lib/api-functions/settings";

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

export const FOOTER_BUILDER_PANELS = [
  "branding",
  "navigation",
  "social",
] as const;

export type FooterBuilderPanel = (typeof FOOTER_BUILDER_PANELS)[number];

/**
 * Props for the main FooterBuilder component
 */
export interface FooterBuilderProps {
  activePanel?: FooterBuilderPanel;
  initialConfig?: FooterConfig | null;
  initialRevision?: number;
  readiness?: NavigationConfigSectionReadiness;
  onPanelChange?: (panel: FooterBuilderPanel) => void;
  onSave?: (
    config: FooterConfig,
    expectedRevision: number,
  ) => Promise<{ revision: number }>;
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
  copyrightText: "Your store",
  menus: [],
  social: [],
};
