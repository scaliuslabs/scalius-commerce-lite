import { cloneElement, createContext, isValidElement, useContext, useState, type ComponentPropsWithoutRef, type ReactElement, type ReactNode } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { SaveErrorBanner, SaveScope, useServerFieldError } from "../shared/SaveBar";
import { useMessages } from "~/i18n";
import { settingsMessages, settingsNavMessages } from "~/i18n/settings";
import { cn } from "@scalius/shared/utils";
import { SETTINGS_NAV, type SettingsNavKey } from "./settings-nav";
import type { SettingsCardId } from "./settings-search";

type SettingsNavTo = (typeof SETTINGS_NAV)[number]["to"];

/** The card a settings-search result pointed at (the URL hash), outlined on arrival. */
const TargetCardContext = createContext("");

/** One settings page: title with icon, the save-error banner, then one column of cards. */
export function SettingsPage({
  page,
  title,
  back,
  actions,
  readOnly = false,
  children,
}: {
  page: SettingsNavKey;
  /** A sub-page of `page` (e.g. delivery areas under shipping). */
  title?: ReactNode;
  back?: { to: SettingsNavTo; label: string };
  actions?: ReactNode;
  /** Shows the one-line "view only" notice for roles that can't edit. */
  readOnly?: boolean;
  children: ReactNode;
}) {
  const t = useMessages(settingsNavMessages);
  const common = useMessages(settingsMessages);
  const Icon = SETTINGS_NAV.find((item) => item.key === page)!.icon;
  const hash = useLocation({ select: (location) => location.hash });
  return (
    <TargetCardContext.Provider value={hash}>
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="flex min-h-11 flex-wrap items-center gap-2 pr-10 lg:min-h-9">
          <Link
            to={back?.to ?? "/admin/settings"}
            aria-label={back?.label ?? t("settings")}
            className={cn(
              "-ml-2 grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground lg:size-9",
              !back && "lg:hidden",
            )}
          >
            <ArrowLeft className="size-5" aria-hidden="true" />
          </Link>
          {back ? null : <Icon className="hidden size-5 text-muted-foreground lg:block" aria-hidden="true" />}
          <h1 className="mr-auto text-heading-lg">{title ?? t(page)}</h1>
          {actions}
        </div>
        <SaveErrorBanner />
        {readOnly ? <p className="text-body text-muted-foreground">{common("readOnly")}</p> : null}
        {children}
      </div>
    </TargetCardContext.Provider>
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
        <div className="flex flex-wrap items-start justify-between gap-3 p-4">
          {header ?? (
            <div className="min-w-0 flex-1 space-y-1">
              <h2 className="text-heading-sm">{title}</h2>
              {description ? <p className="text-body text-muted-foreground">{description}</p> : null}
            </div>
          )}
          {action}
        </div>
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
 * Label, control and one line of help or error. Give the control
 * `aria-describedby={`${id}-note`}` so the note is read with it.
 */
export function SettingsField({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  // Inline errors appear once the merchant leaves the field (or presses Save),
  // never while typing. A rejected save marks the field until it's edited.
  const [left, setLeft] = useState(false);
  const server = useServerFieldError(id);
  const clientShown = error && (left || server.revealed) ? error : null;
  const shown = clientShown ?? server.error;
  const isControl = isValidElement<{ id?: string }>(children) && children.props.id === id;
  const control = !isControl
    ? children
    : shown
      ? cloneElement(children as ReactElement<Record<string, unknown>>, { "aria-invalid": true, "aria-describedby": `${id}-note` })
      : error
        ? cloneElement(children as ReactElement<Record<string, unknown>>, { "aria-invalid": false })
        : children;
  return (
    <div
      className="space-y-1.5"
      onBlur={() => setLeft(true)}
      onInput={server.error ? server.clear : undefined}
      onChange={server.error ? server.clear : undefined}
    >
      <Label htmlFor={id}>{label}</Label>
      {control}
      {shown ? (
        <p id={`${id}-note`} role="alert" className="text-body text-destructive">{shown}</p>
      ) : help ? (
        <p id={`${id}-note`} className="text-body text-muted-foreground">{help}</p>
      ) : null}
    </div>
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
      className="flex min-h-14 w-full items-center gap-3 border-t border-border px-4 py-3 text-left first:border-t-0 hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium">{label}</span>
        {value ? <span className="block truncate text-body text-muted-foreground">{value}</span> : null}
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </button>
  );
}

/**
 * A multi-field edit in a dialog. Editors inside register with its save scope
 * (`useSaveBar` / `useSettingsForm`); Save saves them and closes, Cancel or
 * closing discards. A failed save keeps the dialog open with the problems listed.
 */
export function SettingsDialog({
  title,
  description,
  trigger,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  trigger: ReactElement;
  children: ReactNode;
}) {
  const t = useMessages(settingsMessages);
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <SaveScope
          render={(state) => (
            // Long forms scroll; the actions stay in reach, separated by a border.
            <div className="sticky -bottom-5 -mx-5 -mb-5 border-t border-border bg-card px-5 py-4">
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={state.busy}
                  onClick={() => {
                    state.discardAll();
                    setOpen(false);
                  }}
                >
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
              </DialogFooter>
            </div>
          )}
        >
          <div className="space-y-4">
            <SaveErrorBanner />
            {children}
          </div>
        </SaveScope>
      </DialogContent>
    </Dialog>
  );
}
