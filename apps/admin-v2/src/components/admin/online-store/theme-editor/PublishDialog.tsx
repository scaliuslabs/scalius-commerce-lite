/**
 * Publishing, WordPress's save summary (research §3.8): what goes live,
 * grouped as the pages it touches and the store-wide settings (marked as
 * site-wide), a warning for AI-drafted sections no one has opened yet, and
 * a note for the version history. This one dialog is also the review point
 * for AI drafts: it warns, it never forces a tick.
 */
import { useEffect, useState } from "react";
import { Sparkles, TriangleAlert } from "lucide-react";
import { compareThemeDocuments, type StorefrontSection, type StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { useChangeText } from "./ThemeHistory";
import { Field } from "~/components/ui/field";

export function PublishDialog({ open, onOpenChange, live, draft, unopenedAi, sectionName, publishing, onOpenSection, onPublish }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  live: StorefrontThemeDocument;
  /** What goes live: the editor's saved (or about to be saved) document. */
  draft: StorefrontThemeDocument;
  unopenedAi: readonly StorefrontSection[];
  sectionName: (section: StorefrontSection) => string;
  publishing: boolean;
  onOpenSection: (id: string) => void;
  onPublish: (note: string) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!open) setNote("");
  }, [open]);
  const changes = open ? compareThemeDocuments(live, draft) : [];
  const text = useChangeText([draft, live], sectionName);
  const pages = changes.filter((change) => change.kind !== "settings-changed");
  const settings = changes.filter((change) => change.kind === "settings-changed");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-publish-dialog>
        <DialogHeader>
          <DialogTitle>{t("publishTitle")}</DialogTitle>
          <DialogDescription>{t("publishHelp")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {unopenedAi.length > 0 ? (
            <Alert variant="warning">
              <Sparkles aria-hidden="true" />
              <AlertDescription>
                <p>{unopenedAi.length === 1 ? t("publishAiWarningOne") : t("publishAiWarning", { count: unopenedAi.length })}</p>
                <ul className="mt-1 space-y-0.5">
                  {unopenedAi.map((section) => (
                    <li key={section.id}>
                      <Button type="button" variant="link" size="sm" onClick={() => onOpenSection(section.id)}>{sectionName(section)}</Button>
                    </li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          ) : null}
          {changes.length === 0 ? <p className="text-body text-muted-foreground">{t("noChanges")}</p> : null}
          {pages.length > 0 ? (
            <section className="space-y-1">
              <h3 className="text-heading-sm">{t("publishPages")}</h3>
              <ul className="list-disc space-y-1 ps-5 text-body">
                {pages.map((change, index) => <li key={index}>{text(change)}</li>)}
              </ul>
            </section>
          ) : null}
          {settings.length > 0 ? (
            <section className="space-y-1">
              <h3 className="flex items-center gap-1.5 text-heading-sm">
                <TriangleAlert className="size-4 text-warning" aria-hidden="true" />
                {t("publishSiteWide")}
              </h3>
              <p className="text-body text-muted-foreground">{t("publishSiteWideHelp")}</p>
              <ul className="list-disc space-y-1 ps-5 text-body">
                {settings.map((change, index) => <li key={index}>{text(change)}</li>)}
              </ul>
            </section>
          ) : null}
          <Field id="theme-publish-note" label={t("publishNote")} help={t("publishNoteHelp")}>
            <Textarea id="theme-publish-note" maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} aria-describedby="theme-publish-note-help" />
          </Field>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button type="button" loading={publishing} disabled={changes.length === 0} onClick={() => onPublish(note.trim())}>{t("publish")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
