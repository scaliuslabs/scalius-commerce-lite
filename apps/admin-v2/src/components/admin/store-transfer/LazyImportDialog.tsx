import { lazy, Suspense, type ComponentProps } from "react";
import type { ImportDialog as ImportDialogComponent } from "./ImportDialog";

const ImportDialogImpl = lazy(() => import("./ImportDialog").then((module) => ({ default: module.ImportDialog })));

/** CSV mapping and phone validation load only when the merchant opens import. */
export function ImportDialog(props: ComponentProps<typeof ImportDialogComponent>) {
  return props.open ? <Suspense fallback={null}><ImportDialogImpl {...props} /></Suspense> : null;
}
