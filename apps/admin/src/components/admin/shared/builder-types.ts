/**
 * Shared types used by both header-builder and footer-builder.
 */

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
