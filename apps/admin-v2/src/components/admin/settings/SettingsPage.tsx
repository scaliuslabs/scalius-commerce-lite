import { ReadOnlyNotice } from "~/components/admin/states/ReadOnlyNotice";
import { cloneElement, createContext, isValidElement, useContext, useEffect, useState, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
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
import { settingsSubPageMessages } from "~/i18n/settings-sub-pages";
import { cn } from "@scalius/shared/utils";
import { SETTINGS_NAV, type SettingsNavKey } from "./settings-nav";
import { useQueryClient } from "@tanstack/react-query";
import { PresenceScopeContext, PresenceSlot, presenceKey } from "~/lib/realtime/store";
import type { SettingsCardId } from "./settings-cards";
import { SETTINGS_SUB_PAGES, subPageForHash, type SettingsSubPageKey } from "./settings-cards";
import { Page } from "~/components/admin/resource/Page";

type SettingsNavTo = (typeof SETTINGS_NAV)[number]["to"] | (typeof SETTINGS_SUB_PAGES)[number]["to"];

/** The card a settings-search result pointed at (the URL hash), outlined on arrival. */
const TargetCardContext = createContext("");

/**
 * One settings page: title, the save-error banner, then one column of cards.
 * `subPage` is one part of a split page (`SETTINGS_SUB_PAGES`): its own title,
 * a back link to the page, and only its own cards, so the save bar saves
 * that part and leaving it with edits goes through the leave-page guard.
 */
export function SettingsPage({
  page,
  subPage,
  title,
  back,
  status,
  actions,
  readOnly = false,
  children,
}: {
  page: SettingsNavKey;
  subPage?: SettingsSubPageKey;
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
  const parts = useMessages(settingsSubPageMessages);
  const hash = useLocation({ select: (location) => location.hash });
  const key = presenceKey("settings", subPage ? `${page}.${subPage}` : page);
  const backTo = back ?? (subPage ? { to: SETTINGS_NAV.find((item) => item.key === page)!.to, label: t(page) } : undefined);
  return (
    <PresenceScopeContext.Provider value={key}>
    <TargetCardContext.Provider value={hash}>
      <Page width="settings" data-presence-root={key} className="space-y-4">
        <PageHeader
          title={title ?? (subPage ? parts(subPage) : t(page))}
          backTo={backTo?.to ?? "/admin/settings"}
          backLabel={backTo?.label ?? t("settings")}
          backOnlyWithoutPanel={!backTo}
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
        {/* A card the page heading already names draws no second heading. */}
        {header || title || description || action ? (
          <CardHeading
            action={action}
            heading={header ?? (
              <div className="space-y-1">
                {title ? <h2 className="text-heading-sm">{title}</h2> : null}
                {description ? <p className="text-body text-muted-foreground">{description}</p> : null}
              </div>
            )}
          />
        ) : null}
        {children ? <div className={cn("space-y-4 px-4 pb-4", !(header || title || description || action) && "pt-4")}>{children}</div> : null}
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
  id,
  title,
  description,
  trigger,
  savedMessage,
  savingLabel,
  layout,
  children,
}: {
  /**
   * A link to the page with this hash opens the dialog: a hint elsewhere that
   * says what to set up lands on the fields themselves (e.g. `sending-email`).
   * Leave it out where the trigger is disabled.
   */
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  trigger: ReactElement;
  /** The Save button's words while it works, e.g. "Sending invite…", for saves that take a few seconds. */
  savingLabel?: string;
  /** The success toast instead of "Changes saved", e.g. "Invite sent". */
  savedMessage?: string;
  /** Draws the content instead of the centred dialog; the sheet lives in its own module so pages without one never load it. */
  layout?: (parts: SettingsDialogParts) => ReactNode;
  children: ReactNode;
}) {
  const t = useMessages(settingsMessages);
  const bar = useMessages(saveBarMessages);
  const target = useContext(TargetCardContext);
  const linked = Boolean(id) && target === id;
  const [open, setOpen] = useState(linked);
  // A link followed while the page is already open (the hash changes, the page stays).
  useEffect(() => {
    if (linked) setOpen(true);
  }, [linked]);
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
        {state.busy && savingLabel ? savingLabel : t("save")}
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

/**
 * A split settings page: one row per part (`?part=`), each with what it holds now ("Google:
 * Browser and server · …"), opening the part's own page (Shopify's
 * Notifications). A link written before the split (`#sending-sms`,
 * `#facebook`) is sent on to the part that holds it, replacing this entry so
 * Back still leaves the page.
 */
export function SettingsSubPages({ page, states }: {
  page: SettingsNavKey;
  /** Each part's state in one line; leave a part out while its state is unknown. */
  states: Partial<Record<SettingsSubPageKey, ReactNode>>;
}) {
  const t = useMessages(settingsSubPageMessages);
  const hash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
  const target = subPageForHash(page, hash);
  useEffect(() => {
    if (target) void navigate({ to: target.to, search: target.search, hash, replace: true });
  }, [target, hash, navigate]);
  return (
    <Card className="overflow-hidden" data-sub-pages={page}>
      <ul className="divide-y divide-border">
        {SETTINGS_SUB_PAGES.filter((entry) => entry.page === page).map((entry) => (
          <li key={entry.key}>
            <Link
              to={entry.to}
              search={entry.search}
              className="flex min-h-14 items-center gap-3 px-4 py-3 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium">{t(entry.key)}</span>
                {states[entry.key] ? <span className="block text-body text-muted-foreground">{states[entry.key]}</span> : null}
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
