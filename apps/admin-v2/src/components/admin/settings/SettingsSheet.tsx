import { SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import type { SettingsDialogParts } from "./SettingsPage";

/**
 * `SettingsDialog`'s sheet layout (DESIGN O4): a right-hand sheet with a
 * header, a scrolling body and a bordered footer, for a settings form longer
 * than a dialog's five fields (O2). Pass it as `layout={settingsSheet}`.
 * The header's close button asks the dialog root to close, so unsaved edits
 * still confirm first.
 */
export function settingsSheet(parts: SettingsDialogParts) {
  return <SettingsSheetContent {...parts} />;
}

function SettingsSheetContent({ title, description, body, actions, busy }: SettingsDialogParts) {
  return (
    <SheetContent className="flex flex-col" {...(description ? {} : { "aria-describedby": undefined })}>
      <SheetHeader closeDisabled={busy}>
        <SheetTitle>{title}</SheetTitle>
        {description ? <SheetDescription>{description}</SheetDescription> : null}
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">{body}</div>
      <SheetFooter>{actions}</SheetFooter>
    </SheetContent>
  );
}
