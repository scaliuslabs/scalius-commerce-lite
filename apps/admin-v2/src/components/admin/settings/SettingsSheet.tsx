import { X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import type { SettingsDialogParts } from "./SettingsPage";

/**
 * `SettingsDialog`'s sheet layout (DESIGN O4): a right-hand sheet with a
 * header, a scrolling body and a bordered footer, for a settings form longer
 * than a dialog's five fields (O2). Pass it as `layout={settingsSheet}`.
 */
export function settingsSheet(parts: SettingsDialogParts) {
  return <SettingsSheetContent {...parts} />;
}

function SettingsSheetContent({ title, description, body, actions, busy, onClose }: SettingsDialogParts) {
  const t = useMessages(settingsMessages);
  return (
    <SheetContent className="flex flex-col" {...(description ? {} : { "aria-describedby": undefined })}>
      <div className="flex shrink-0 items-start gap-2 border-b px-6 py-4">
        <SheetHeader className="min-w-0 flex-1">
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <Button type="button" variant="ghost" size="icon" className="-me-2 shrink-0" aria-label={t("closePanel")} disabled={busy} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-6 py-4">{body}</div>
      <SheetFooter>{actions}</SheetFooter>
    </SheetContent>
  );
}
