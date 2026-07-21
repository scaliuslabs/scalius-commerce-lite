// src/components/admin/header-builder/types.ts

import type { SocialLink, LogoConfig } from "~/components/admin/shared/builder-types";
import type { NavigationItem } from "~/components/admin/navigation/types";
import type { MediaFile } from "~/components/admin/media-manager/types";
import type { NavigationConfigSectionReadiness } from "~/lib/api-functions/settings";
import { HEADER_LOGO_WIDTH_DEFAULT } from "@scalius/shared/brand-presentation";

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

export type HeaderPresentationConfig = Omit<HeaderConfig, "navigation">;

export const HEADER_BUILDER_PANELS = [
  "branding",
  "announcement",
  "contact-social",
  "navigation",
] as const;

export type HeaderBuilderPanel = (typeof HEADER_BUILDER_PANELS)[number];

/**
 * Props for the main HeaderBuilder component
 */
export interface HeaderBuilderProps {
  activePanel?: HeaderBuilderPanel;
  initialConfig?: HeaderConfig | null;
  initialRevision?: number;
  readiness?: NavigationConfigSectionReadiness;
  onPanelChange?: (panel: HeaderBuilderPanel) => void;
  onSave?: (
    config: HeaderPresentationConfig,
    expectedRevision: number,
  ) => Promise<{ revision: number }>;
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
    width: HEADER_LOGO_WIDTH_DEFAULT,
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
