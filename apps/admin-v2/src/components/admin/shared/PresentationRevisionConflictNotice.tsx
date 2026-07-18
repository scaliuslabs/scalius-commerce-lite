import { AlertTriangle } from "lucide-react";

import { Button } from "~/components/ui/button";

export function PresentationRevisionConflictNotice({
  revision,
  onMerge,
  onUseLatest,
}: {
  revision: number;
  onMerge: () => void;
  onUseLatest: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
        <div>
          <p className="font-medium">A newer version was saved elsewhere.</p>
          <p className="text-xs text-muted-foreground">
            Your draft is safe. Review revision {revision} before saving again.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onUseLatest}>
          Use latest
        </Button>
        <Button type="button" size="sm" onClick={onMerge}>
          Merge mine
        </Button>
      </div>
    </div>
  );
}
