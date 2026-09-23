import type { ReactNode } from "react";
import { Badge } from "~/components/ui/badge";

export type StatusTone = "success" | "neutral" | "attention";

/** One status pill for every list: success (live/active), neutral (draft), attention. */
export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <Badge variant={tone === "success" ? "default" : tone === "attention" ? "outline" : "secondary"}>{children}</Badge>
  );
}
