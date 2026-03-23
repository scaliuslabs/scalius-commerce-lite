// src/components/admin/header-builder/SocialLinksSection.tsx
// Delegates to the shared SocialLinksSection with header-specific defaults.
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
      droppableId="header-social-links"
      description="Add links to your social media profiles. Customize each with a label and optional icon."
      cardClassName="border border-border shadow-sm"
    />
  );
}
