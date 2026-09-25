import { Fragment, useState, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { putApiV1AdminAuthShortcuts } from "@scalius/api-client/sdk";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { readSettingsRevisionConflict } from "~/lib/admin-api-error";
import { apiData } from "~/lib/api";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { shortcutsMessages } from "~/i18n/shortcuts";
import { SETTINGS_ITEM, type VisibleNavItem } from "./AdminNav";
import { comboCaps, GO_DEFAULTS, goCaps, goKeys, goSequence, SHORTCUTS, type KeyCombo } from "./shortcuts";
import { staffShortcutsQueryOptions, useStaffShortcuts } from "./staff-shortcuts";

function Caps({ caps }: { caps: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {caps.map((cap, index) => (
        <kbd key={`${cap}-${index}`} className="text-caption">
          {cap}
        </kbd>
      ))}
    </span>
  );
}

/** A key the browser or the dashboard owns, as the merchant pressed it. */
function pressedCaps(event: KeyboardEvent): string {
  const parts = [event.metaKey ? "⌘" : null, event.ctrlKey ? "Ctrl" : null, event.altKey ? "Alt" : null, event.shiftKey ? "Shift" : null];
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [...parts.filter(Boolean), key].join("+");
}

/**
 * Shopify's `?` sheet: every shortcut from the registry, then the go-to
 * sequences for the pages this staff member can open, each of which they can
 * change for themselves (G then a letter or number, saved to their account).
 */
export function ShortcutsDialog({
  nav,
  canOpen,
  open,
  setOpen,
}: {
  nav: VisibleNavItem[];
  canOpen: (path: string) => boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const t = useMessages(shortcutsMessages);
  const shell = useMessages(shellMessages);
  const queryClient = useQueryClient();
  const stored = useStaffShortcuts();
  const overrides = stored.data?.shortcuts ?? {};
  const keys = goKeys(overrides);
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Every page in the menu once (a section without its own page shares its first sub-page's).
  const destinations = new Map<string, string>();
  for (const item of nav) {
    for (const entry of [{ to: item.to, key: item.key }, ...item.children]) {
      if (!destinations.has(entry.to)) destinations.set(entry.to, shell(entry.key));
    }
  }
  if (canOpen(SETTINGS_ITEM.to)) destinations.set(SETTINGS_ITEM.to, shell("settings"));
  const owner = new Map([...keys].filter(([to]) => destinations.has(to)).map(([to, key]) => [key, to]));

  async function save(next: Record<string, string>) {
    setSaving(true);
    try {
      const saved = await apiData(putApiV1AdminAuthShortcuts({ body: { expectedRevision: stored.data?.revision ?? 0, shortcuts: next } }));
      queryClient.setQueryData(staffShortcutsQueryOptions().queryKey, saved);
      toast.success(t("saved"));
      return true;
    } catch (failure) {
      if (readSettingsRevisionConflict(failure)) {
        await queryClient.invalidateQueries({ queryKey: staffShortcutsQueryOptions().queryKey });
        setError(t("errorConflict"));
      } else {
        setError(t("errorSave"));
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function record(to: string, event: KeyboardEvent<HTMLButtonElement>) {
    if (["Shift", "Meta", "Control", "Alt", "Tab"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(null);
      setError("");
      return;
    }
    const next = { ...overrides };
    if (event.key === "Backspace" || event.key === "Delete") {
      if (GO_DEFAULTS[to]) next[to] = "";
      else delete next[to];
    } else if (event.metaKey || event.ctrlKey || event.altKey) {
      setError(t("errorModifier", { keys: pressedCaps(event) }));
      return;
    } else {
      const key = event.key.toLowerCase();
      if (!/^[a-z0-9]$/.test(key)) {
        setError(t("errorKey"));
        return;
      }
      const taken = owner.get(key);
      if (taken && taken !== to) {
        setError(t("errorTaken", { key: key.toUpperCase(), page: destinations.get(taken) ?? taken }));
        return;
      }
      if (GO_DEFAULTS[to] === key) delete next[to];
      else next[to] = goSequence(key);
    }
    setError("");
    if (await save(next)) setRecording(null);
  }

  const groups = (["general", "editing"] as const).map((group) => ({
    group,
    rows: Object.values(SHORTCUTS).filter((shortcut) => shortcut.group === group),
  }));

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setRecording(null);
          setError("");
        }
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        onEscapeKeyDown={(event) => {
          // Esc while recording keeps the shortcut; otherwise it closes the dialog.
          if (recording) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        {groups.map(({ group, rows }) => (
          <section key={group} className="space-y-1">
            <h3 className="text-heading-sm">{t(group)}</h3>
            <dl className="divide-y text-body">
              {rows.map((shortcut) => (
                <div key={shortcut.label} className="flex items-center justify-between gap-4 py-2">
                  <dt>{t(shortcut.label)}</dt>
                  <dd className="flex shrink-0 items-center gap-1 text-muted-foreground">
                    {shortcut.combos.map((combo: KeyCombo, index) => (
                      <Fragment key={combo.key}>
                        {index > 0 ? <span>{t("or")}</span> : null}
                        <Caps caps={comboCaps(combo)} />
                      </Fragment>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <section className="space-y-1">
          <h3 className="text-heading-sm">{t("goTo")}</h3>
          <p className="text-body text-muted-foreground">{t("goNote")}</p>
          {error ? (
            <p role="alert" className="text-body text-destructive">
              {error}
            </p>
          ) : null}
          <dl className="divide-y text-body">
            {[...destinations].map(([to, label]) => {
              const key = keys.get(to);
              const active = recording === to;
              return (
                <div key={to} className="flex min-h-11 items-center justify-between gap-4 py-1">
                  <dt className="min-w-0 truncate">{label}</dt>
                  <dd className="flex shrink-0 items-center gap-2 text-muted-foreground">
                    {active ? (
                      <span aria-live="polite">{t("pressKey")}</span>
                    ) : key ? (
                      <span className="flex items-center gap-1">
                        <Caps caps={[goCaps(key)[0]!]} />
                        <span>{t("then")}</span>
                        <Caps caps={[goCaps(key)[1]!]} />
                      </span>
                    ) : (
                      <span>{t("none")}</span>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t("changeFor", { page: label })}
                      aria-pressed={active}
                      title={active ? t("recordHint") : undefined}
                      disabled={saving}
                      onClick={() => {
                        setError("");
                        setRecording(active ? null : to);
                      }}
                      onKeyDown={(event) => {
                        if (active) void record(to, event);
                      }}
                      onBlur={() => {
                        if (active) setRecording(null);
                      }}
                    >
                      {key ? t("change") : t("add")}
                    </Button>
                  </dd>
                </div>
              );
            })}
          </dl>
          {recording ? <p className="text-body text-muted-foreground">{t("recordHint")}</p> : null}
          {Object.keys(overrides).length > 0 ? (
            <div className="flex justify-end pt-2">
              <Button type="button" variant="outline" disabled={saving} onClick={() => void save({})}>
                {t("reset")}
              </Button>
            </div>
          ) : null}
        </section>
      </DialogContent>
    </Dialog>
  );
}
