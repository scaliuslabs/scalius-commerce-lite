import { ErrorBoundary } from "../ErrorBoundary";
import { MediaWorkspace } from "./MediaWorkspace";
import { useMediaManager } from "./hooks/useMediaManager";

export function MediaManagerPage() {
  const manager = useMediaManager({ autoLoad: true, capability: "both" });
  return (
    <ErrorBoundary fallback={<div className="rounded-lg border p-8 text-center text-sm text-muted-foreground">Media could not be opened. <button type="button" className="underline" onClick={() => window.location.reload()}>Reload the page</button>.</div>}>
      <div className="h-[calc(100svh-7.5rem)] min-h-[28rem] overflow-hidden rounded-lg border bg-card shadow-sm sm:h-[calc(100svh-8.5rem)] sm:min-h-[34rem]">
        <MediaWorkspace manager={manager} capability="both" />
      </div>
    </ErrorBoundary>
  );
}
