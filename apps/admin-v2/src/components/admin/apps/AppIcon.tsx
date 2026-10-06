import { Blocks } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { withDashboardBasePath } from "~/lib/dashboard-base-path";

const SIZE = { sm: "size-8", md: "size-10", lg: "size-12" } as const;

/**
 * An app's icon (Shopify's app tile): the app's own image on a white rounded
 * square, so a logo drawn for light backgrounds reads in both themes, or a
 * neutral blocks glyph. Decorative: the app's name is always beside it.
 */
export function AppIcon({ src, size = "md", className }: { src: string | null | undefined; size?: keyof typeof SIZE; className?: string }) {
  if (!src) {
    return (
      <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center rounded-lg bg-secondary text-muted-foreground", SIZE[size], className)}>
        <Blocks className="size-1/2" />
      </span>
    );
  }
  return (
    <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center overflow-clip rounded-lg bg-white p-1 shadow-card", SIZE[size], className)}>
      <img src={withDashboardBasePath(src)} alt="" loading="lazy" decoding="async" className="size-full object-contain" />
    </span>
  );
}
