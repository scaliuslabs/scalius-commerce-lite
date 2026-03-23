import React, { Suspense } from "react";
import { ErrorBoundary } from "../ErrorBoundary";

interface SafeIslandProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  suspenseFallback?: React.ReactNode;
  name?: string;
}

/**
 * Wraps children in an ErrorBoundary + Suspense boundary.
 * Use inside top-level React components that are hydrated via Astro's
 * client:idle / client:visible directives to prevent unhandled errors
 * from crashing the entire page.
 */
export function SafeIsland({ children, fallback, suspenseFallback, name }: SafeIslandProps) {
  return (
    <ErrorBoundary
      fallback={fallback || (
        <div className="p-4 text-center text-muted-foreground">
          <p>Something went wrong{name ? ` in ${name}` : ""}.</p>
          <button onClick={() => window.location.reload()} className="mt-2 text-sm underline">
            Reload page
          </button>
        </div>
      )}
    >
      <Suspense fallback={suspenseFallback || <div className="animate-pulse p-4">Loading...</div>}>
        {children}
      </Suspense>
    </ErrorBoundary>
  );
}
