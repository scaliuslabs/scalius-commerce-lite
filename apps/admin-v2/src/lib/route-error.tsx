/**
 * Shared error component for route-level error boundaries.
 *
 * Kept separate from list/search helpers so simple routes do not pull Zod into
 * their route module graph just to render an error boundary.
 */
export function RouteErrorComponent({
  error,
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <p className="text-4xl font-bold text-muted-foreground mb-2">Error</p>
      <p className="text-sm text-muted-foreground mb-4">
        {error instanceof Error
          ? error.message
          : "Something went wrong loading this page."}
      </p>
      <button
        onClick={reset}
        className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
      >
        Try Again
      </button>
    </div>
  );
}
