import {
  AlertCircle,
  CheckCircle2,
  ShieldAlert,
} from "lucide-react";

import { cn } from "@scalius/shared/utils";

import type { AdminAssistantStatus } from "./assistant-panel-types";

interface AdminAssistantStatusBannerProps {
  status: AdminAssistantStatus;
}

export function AdminAssistantStatusBanner({
  status,
}: AdminAssistantStatusBannerProps) {
  if (status.kind === "idle") return null;

  const Icon =
    status.kind === "success"
      ? CheckCircle2
      : status.kind === "disabled"
        ? ShieldAlert
        : AlertCircle;

  return (
    <div
      role={status.kind === "error" ? "alert" : "status"}
      data-assistant-status={status.kind}
      className={cn(
        "mx-3 mb-2.5 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs leading-5",
        status.kind === "disabled" &&
          "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200",
        status.kind === "success" &&
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
        status.kind === "error" &&
          "border-destructive/30 bg-destructive/10 text-destructive",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{status.message}</span>
    </div>
  );
}
