import {
  CircleAlert,
  CircleCheck,
  Gauge,
  Power,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { AnalyticsScriptReadiness } from "~/types/api-responses";

export const ANALYTICS_PROVIDER_LABELS: Record<string, string> = {
  google_analytics: "Google Analytics 4",
  google_tag_manager: "Google Tag Manager",
  facebook_pixel: "Meta Pixel",
  tiktok_pixel: "TikTok Pixel",
  cloudflare_web_analytics: "Cloudflare Web Analytics",
  custom: "Custom code",
};

export const ANALYTICS_LOCATION_LABELS: Record<string, string> = {
  head: "Document head",
  body_start: "Body start",
  body_end: "Body end",
};

interface AnalyticsReadinessPresentation {
  label: string;
  icon: LucideIcon;
  className: string;
}

const READINESS_PRESENTATION: Record<
  AnalyticsScriptReadiness,
  AnalyticsReadinessPresentation
> = {
  ready: {
    label: "Live",
    icon: CircleCheck,
    className: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
  ready_to_activate: {
    label: "Ready to activate",
    icon: Power,
    className: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300",
  },
  blocked: {
    label: "Needs attention",
    icon: CircleAlert,
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  trashed: {
    label: "In trash",
    icon: Trash2,
    className: "border-border bg-muted text-muted-foreground",
  },
  draft: {
    label: "Draft",
    icon: Gauge,
    className: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  },
};

export function analyticsReadinessPresentation(
  readiness: AnalyticsScriptReadiness,
): AnalyticsReadinessPresentation {
  return READINESS_PRESENTATION[readiness];
}
