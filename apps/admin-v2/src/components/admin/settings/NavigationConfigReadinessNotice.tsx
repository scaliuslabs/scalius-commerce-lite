import { AlertTriangle, ShieldAlert } from "lucide-react";

import type { NavigationConfigSectionReadiness } from "~/lib/api-functions/settings";

interface NavigationConfigReadinessNoticeProps {
  section: "header" | "footer";
  readiness?: NavigationConfigSectionReadiness;
}

export function NavigationConfigReadinessNotice({
  section,
  readiness,
}: NavigationConfigReadinessNoticeProps) {
  if (!readiness || readiness.state === "ready") return null;

  const sectionLabel = section === "header" ? "Header" : "Footer";
  const isInvalid = readiness.state === "invalid";
  const Icon = isInvalid ? ShieldAlert : AlertTriangle;

  return (
    <div
      role={isInvalid ? "alert" : "status"}
      className={
        isInvalid
          ? "flex items-start gap-2.5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm"
          : "flex items-start gap-2.5 rounded-md border border-amber-500/35 bg-amber-500/5 px-3 py-2.5 text-sm"
      }
    >
      <Icon
        aria-hidden="true"
        className={
          isInvalid
            ? "mt-0.5 size-4 shrink-0 text-destructive"
            : "mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        }
      />
      <div className="min-w-0">
        <p className="font-medium">
          {isInvalid ? `${sectionLabel} editing locked` : "Save navigation update"}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {isInvalid
            ? `The saved ${section} could not be read. Editing is locked to prevent an overwrite; other settings remain available.`
            : `Existing ${section} links were safely converted. Review them, then save this section once.`}
        </p>
      </div>
    </div>
  );
}
