import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Globe } from "lucide-react";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { storefrontUrlQueryOptions } from "~/lib/api-query-options/storefront-url";

export function StorefrontFooterLink({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const { data } = useQuery(storefrontUrlQueryOptions());
  const storefrontUrl =
    (data as Record<string, string> | undefined)?.storefrontUrl || "/";

  return (
    <SidebarMenuButton asChild tooltip="Visit Storefront">
      <a
        href={storefrontUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onNavigate}
      >
        <Globe className="shrink-0" strokeWidth={1.8} />
        <span className="flex-1 truncate">Visit Storefront</span>
        <ExternalLink className="!size-3.5 text-sidebar-foreground/50" />
      </a>
    </SidebarMenuButton>
  );
}
