// src/components/admin/footer-builder/SocialLinksSection.tsx
// Delegates to the shared SocialLinksSection with footer-specific defaults.
import { SocialLinksSection as SharedSocialLinksSection } from "~/components/admin/shared/SocialLinksSection";
import type { SocialLink } from "./types";

interface SocialLinksSectionProps {
  social: SocialLink[];
  onChange: (social: SocialLink[]) => void;
}

export function SocialLinksSection({
  social,
  onChange,
}: SocialLinksSectionProps) {
  return (
    <SharedSocialLinksSection
      social={social}
      onChange={onChange}
      droppableId="footer-social-links"
      description="Add links to your social media. Each with a custom label and optional icon."
    />
  );
}
