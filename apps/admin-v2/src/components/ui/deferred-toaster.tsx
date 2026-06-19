import { lazy, Suspense, useEffect, useState } from "react";

const Toaster = lazy(() =>
  import("./sonner").then((module) => ({ default: module.Toaster })),
);

export function DeferredToaster() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return (
    <Suspense fallback={null}>
      <Toaster richColors closeButton position="top-right" />
    </Suspense>
  );
}
