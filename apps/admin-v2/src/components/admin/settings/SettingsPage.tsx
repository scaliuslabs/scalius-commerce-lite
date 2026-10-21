import { ReadOnlyNotice } from "~/components/admin/states/ReadOnlyNotice";
import { cloneElement, createContext, isValidElement, useContext, useState, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { ChevronRight, Loader2 } from "lucide-react";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { Button } from "~/components/ui/button";
import { Card, CardHeading } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { SaveErrorBanner, SaveScope, useSaveScope, useServerFieldError, type SaveScopeState } from "../shared/SaveBar";
import { useMessages } from "~/i18n";
import { saveBarMessages } from "~/i18n/save-bar";
import { settingsMessages, settingsNavMessages } from "~/i18n/settings";
import { cn } from "@scalius/shared/utils";
import { SETTINGS_NAV, type SettingsNavKey } from "./settings-nav";
import { useQueryClient } from "@tanstack/react-query";
import { PresenceScopeContext, PresenceSlot, presenceKey } from "~/lib/realtime/store";
import type { SettingsCardId } from "./settings-search";
import { Page } from "~/components/admin/resource/Page";

type SettingsNavTo = (typeof SETTINGS_NAV)[number]["to"];

/** The card a settings-search result pointed at (the URL hash), outlined on arrival. */
const TargetCardContext = createContext("");

/** One settings page: title with icon, the save-error banner, then one column of cards. */
export function SettingsPage({
  page,
  title,
  back,
  status,
  actions,
  readOnly = false,
  children,
}: {
  page: SettingsNavKey;
  /** A sub-page of `page` (e.g. delivery areas under shipping). */
  title?: ReactNode;
  back?: { to: SettingsNavTo; label: string };
  /** Status badges on the title line (P1). */
  status?: ReactNode;
  actions?: ReactNode;
  /** Shows the one-line "view only" notice for roles that can't edit. */
  readOnly?: boolean;
  children: ReactNode;
}) {
  const t = useMessages(settingsNavMessages);
  const hash = useLocation({ select: (location) => location.hash });
  const key = presenceKey("settings", page);
  return (
    <PresenceScopeContext.Provider value={key}>
    <TargetCardContext.Provider value={hash}>
      <Page width="settings" data-presence-root={key} className="space-y-4">
        <PageHeader
          title={title ?? t(page)}
          backTo={back?.to ?? "/admin/settings"}
          backLabel={back?.label ?? t("settings")}
          backOnlyWithoutPanel={!back}
          presence={<SettingsPresence presenceKey={key} />}
          status={status}
          actions={actions}
        />
        <SaveErrorBanner />
        {readOnly ? <ReadOnlyNotice /> : null}
        {children}
      </Page>
    </TargetCardContext.Provider>
    </PresenceScopeContext.Provider>
  );
}

/** Settings cards keep the fields they edited when the page reloads, so any save by someone else merges. */
const NO_FIELDS = () => [];

/**
 * Who else has this settings page open, and their saves. "Load latest"
 * refetches the page's documents; each card keeps the fields it has edited
 * (`useSettingsForm` merges unedited fields from the fresh read).
 */
function SettingsPresence({ presenceKey: key }: { presenceKey: string }) {
  const scope = useSaveScope();
  const queryClient = useQueryClient();
  return (
    <PresenceSlot
      presenceKey={key}
      dirty={Boolean(scope?.dirty)}
      changedFields={NO_FIELDS}
      onLoadLatest={() => void queryClient.invalidateQueries({ queryKey: ["settings"] })}
    />
  );
}

/**
 * One topic per card, Shopify style; never nested. `rows` renders summary rows
 * edge to edge; `header` replaces the title block (e.g. a segmented control)
 * when a card needs it. `id` is the card's entry in the settings search; a
 * search result links to it and outlines it.
 */
export function SettingsCard({
  id,
  title,
  description,
  header,
  action,
  rows,
  children,
}: {
  id?: SettingsCardId;
  title?: ReactNode;
  description?: ReactNode;
  header?: ReactNode;
  action?: ReactNode;
  rows?: ReactNode;
  children?: ReactNode;
}) {
  const targeted = useContext(TargetCardContext) === id && Boolean(id);
  return (
    <div id={id} className={cn("scroll-mt-4 rounded-xl", targeted && "outline-2 outline-offset-2 outline-ring")}>
      <Card className="overflow-hidden">
        <CardHeading
          action={action}
          heading={header ?? (
            <div className="space-y-1">
              <h2 className="text-heading-sm">{title}</h2>
              {description ? <p className="text-body text-muted-foreground">{description}</p> : null}
            </div>
          )}
        />
        {children ? <div className="space-y-4 px-4 pb-4">{children}</div> : null}
        {rows ? <div className="border-t border-border">{rows}</div> : null}
      </Card>
    </div>
  );
}

export function SettingsCardLoading() {
  return (
    <Card className="flex min-h-32 items-center justify-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
    </Card>
  );
}

/**
 * A settings `Field` that shows its error once the merchant leaves the field
 * (or presses Save), and the server's error for it after a rejected save. Its
 * help or error is `<id>-note`.
 */
export function SettingsField({
  id,
  label,
  help,
  error,
  optional,
  children,
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  /** Adds "(optional)" after the label. */
  optional?: boolean;
  children: ReactNode;
}) {
  // Inline errors appear once the merchant leaves the field (or presses Save),
  // never while typing. Passing through an empty field they never typed in
  // flags nothing (Baymard); Save still reveals it. A rejected save marks the
  // field until it's edited.
  const [left, setLeft] = useState(false);
  const [edited, setEdited] = useState(false);
  const server = useServerFieldError(id);
  const onEdit = () => {
    setEdited(true);
    if (server.error) server.clear();
  };
  const clientShown = error && (left || server.revealed) ? error : null;
  const shown = clientShown ?? server.error;
  // A control that does not read its `Field` (a plain button, a switch) still gets the state.
  const isControl = isValidElement<{ id?: string }>(children) && children.props.id === id;
  const control = !isControl
    ? children
    : shown
      ? cloneElement(children as ReactElement<Record<string, unknown>>, { "aria-invalid": true, "aria-describedby": `${id}-note` })
      : error
        ? cloneElement(children as ReactElement<Record<string, unknown>>, { "aria-invalid": false })
        : children;
  return (
    <Field
      id={id}
      label={label}
      help={help}
      optional={optional}
      error={shown}
      noteId={`${id}-note`}
      announceError
      onBlur={(event) => {
        const target = event.target as { value?: unknown };
        if (edited || (typeof target.value === "string" && target.value.trim())) setLeft(true);
      }}
      onInput={onEdit}
      onChange={onEdit}
    >
      {control}
    </Field>
  );
}

/** Shopify summary row: label, current value, chevron. Opens a dialog. */
export function SettingsRow({
  label,
  value,
  ...props
}: { label: ReactNode; value?: ReactNode } & ComponentPropsWithoutRef<"button">) {
  return (
    <button
      type="button"
      {...props}
      className="flex min-h-14 w-full items-center gap-3 border-t border-border px-4 py-3 text-start outline-none first:border-t-0 hover:bg-muted focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium">{label}</span>
        {value ? <span className="block truncate text-body text-muted-foreground" title={typeof value === "string" ? value : undefined}>{value}</span> : null}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

const CloseDialogContext = createContext<(() => void) | null>(null);

/** Closes the settings dialog around the caller, for an action that ends the edit (e.g. "Remove keys"). */
export function useCloseSettingsDialog(): (() => void) | null {
  return useContext(CloseDialogContext);
}

/** What a SettingsDialog layout draws: its own content element around these parts. */
export interface SettingsDialogParts {
  title: ReactNode;
  description?: ReactNode;
  body: ReactNode;
  actions: ReactNode;
  busy: boolean;
  onClose: () => void;
}

/**
 * A multi-field edit in a dialog, or, with `layout={settingsSheet}`
 * (`./SettingsSheet`), in a right-hand sheet for a form longer than a dialog's
 * five fields (DESIGN O2, O4). Editors inside register with its save scope
 * (`useSaveBar` / `useSettingsForm`); Save saves them and closes. Cancel, Esc,
 * ✕ or a click outside closes a clean one, and asks before discarding edits.
 * A failed save keeps it open with the problems listed.
 */
export function SettingsDialog({
  title,
  description,
  trigger,
  savedMessage,
  layout,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  trigger: ReactElement;
  /** The success toast instead of "Changes saved", e.g. "Invite sent". */
  savedMessage?: string;
  /** Draws the content instead of the centred dialog; the sheet lives in its own module so pages without one never load it. */
  layout?: (parts: SettingsDialogParts) => ReactNode;
  children: ReactNode;
}) {
  const t = useMessages(settingsMessages);
  const bar = useMessages(saveBarMessages);
  const [open, setOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const close = (state: SaveScopeState) => {
    state.discardAll();
    setConfirmDiscard(false);
    setOpen(false);
  };
  const requestClose = (state: SaveScopeState) => {
    if (state.busy) return;
    if (state.dirty) setConfirmDiscard(true);
    else close(state);
  };
  const body = (state: SaveScopeState) => (
    <>
      <SaveErrorBanner />
      <CloseDialogContext.Provider value={() => close(state)}>{children}</CloseDialogContext.Provider>
    </>
  );
  const actions = (state: SaveScopeState) => (
    <>
      <Button type="button" variant="outline" disabled={state.busy} onClick={() => requestClose(state)}>
        {t("cancel")}
      </Button>
      <Button
        type="button"
        loading={state.busy}
        disabled={!state.dirty}
        onClick={async () => {
          if (await state.saveAll()) setOpen(false);
        }}
      >
        {t("save")}
      </Button>
    </>
  );
  return (
    <SaveScope
      savedMessage={savedMessage}
      render={(state) => (
        <>
          {/* One mounted root (a sheet is a Radix dialog too); `layout` draws other content. */}
          <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : requestClose(state))}>
            <DialogTrigger asChild>{trigger}</DialogTrigger>
            {layout ? layout({ title, description, body: body(state), actions: actions(state), busy: state.busy, onClose: () => requestClose(state) }) : (
              <DialogContent className="sm:max-w-160">
                <DialogHeader>
                  <DialogTitle>{title}</DialogTitle>
                  {description ? <DialogDescription>{description}</DialogDescription> : null}
                </DialogHeader>
                <div className="space-y-4">{body(state)}</div>
                {/* Long forms scroll; the footer is a pinned, bordered bar (DialogFooter). */}
                <DialogFooter>{actions(state)}</DialogFooter>
              </DialogContent>
            )}
          </Dialog>
          <ConfirmDialog
            open={confirmDiscard && state.dirty}
            onOpenChange={setConfirmDiscard}
            title={bar("discardTitle")}
            description={bar("discardDescription")}
            cancelLabel={bar("continueEditing")}
            confirmLabel={bar("discardChanges")}
            onConfirm={() => close(state)}
          />
        </>
      )}
    >
      {null}
    </SaveScope>
  );
}
