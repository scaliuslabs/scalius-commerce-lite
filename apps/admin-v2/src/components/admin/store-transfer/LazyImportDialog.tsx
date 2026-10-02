import { lazy, Suspense, useEffect, useState } from "react";
import type { ImportKind } from "./import-plan";

// The import dialog carries the CSV parser, the Shopify and WooCommerce mappers
// and phone validation: lists load it on the first Import, never with the page.
const ImportDialog = lazy(() => import("./ImportDialog").then((module) => ({ default: module.ImportDialog })));

/** The import dialog for a list's Import button: downloaded when first opened, then kept mounted. */
export function LazyImportDialog({ kind, open, onOpenChange }: {
  kind: ImportKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [requested, setRequested] = useState(open);
  useEffect(() => {
    if (open) setRequested(true);
  }, [open]);
  if (!requested) return null;
  return (
    <Suspense fallback={null}>
      <ImportDialog kind={kind} open={open} onOpenChange={onOpenChange} />
    </Suspense>
  );
}
