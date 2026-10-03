import type { ReactNode } from "react";
import { Badge, type BadgeVariant } from "~/components/ui/badge";

/**
 * A catalogue or content record's state, the same words on every list and
 * editor (products, categories, brands, collections, pages, blog posts,
 * discounts, purchase documents, digital files).
 */
export type ResourceStatus = "active" | "draft" | "scheduled" | "expired" | "error" | "archived" | "hidden" | "inactive";

/**
 * The one colour for each state (DESIGN.md "Status → badge variant"): live is
 * green, a draft is the attention tone, scheduled is info, expired or failed
 * is critical, and records that are off on purpose (archived, hidden,
 * inactive) are neutral. The badge always carries the word.
 */
export const RESOURCE_STATUS_VARIANT: Readonly<Record<ResourceStatus, BadgeVariant>> = {
  active: "success",
  draft: "attention",
  scheduled: "info",
  expired: "destructive",
  error: "destructive",
  archived: "secondary",
  hidden: "secondary",
  inactive: "secondary",
};

export function statusBadgeVariant(status: ResourceStatus): BadgeVariant {
  return RESOURCE_STATUS_VARIANT[status];
}

/** A record's status pill: the caller's word in the state's one colour. */
export function StatusBadge({ status, className, children }: { status: ResourceStatus; className?: string; children: ReactNode }) {
  return <Badge variant={statusBadgeVariant(status)} className={className}>{children}</Badge>;
}
