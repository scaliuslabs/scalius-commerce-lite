/**
 * What an editor shows once someone else is on it or has saved (loaded only
 * then, by `PresenceNotices` in lib/realtime/store.tsx). Calm by design, as in
 * Figma, Google Docs and Linear:
 *
 * - a one-line banner while someone else edits ("Rahim is editing this
 *   product…"), dismissible, back when someone new starts editing (W2);
 * - a ring in the person's colour, with their first name, on the field they
 *   are in (W3);
 * - one notice when they save: merged into a dirty draft at once when their
 *   fields and this draft's do not overlap, else "reload to see the changes";
 *   the field names link to the fields (W4).
 *
 * Everything floats (notices fixed at the bottom of the view; absolutely
 * placed rings), so nothing here moves the page.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Info, X } from "lucide-react";
import { formatList } from "@scalius/shared/locale-words";
import type { RealtimePresence } from "@scalius/shared/realtime";
import { cn } from "@scalius/shared/utils";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { getLocale, useMessages } from "~/i18n";
import { realtimeMessages } from "~/i18n/realtime";
import { presencePrefixOf, presenceRoot, realtimeUserId, type EditorPresenceValue, type RemoteSave } from "~/lib/realtime/store";
import { PersonAvatar } from "./PresenceAvatars";
import { PRESENCE_FILL, PRESENCE_RING, firstNameOf, presenceColour } from "./presence-style";

const EDITING_KEY = {
  order: "editingOrder",
  product: "editingProduct",
  category: "editingCategory",
  collection: "editingCollection",
  page: "editingPage",
  theme: "editingTheme",
  settings: "editingSettings",
} as const;

/** The element that holds field `field` inside `root`, by form name or `data-field`. */
export function fieldElement(root: Element | null, field: string): HTMLElement | null {
  if (!root) return null;
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(field) : field.replace(/"/g, "");
  return root.querySelector<HTMLElement>(`[name="${escaped}"]`) ?? root.querySelector<HTMLElement>(`[data-field="${escaped}"]`);
}

/** The visible box for a field: the control itself, or its field wrapper when the named input is hidden. */
function visibleBox(element: HTMLElement): HTMLElement | null {
  const visible = (node: HTMLElement) => node.getClientRects().length > 0 && node.offsetWidth > 0 && node.offsetHeight > 0;
  if (visible(element) && (element as HTMLInputElement).type !== "hidden") return element;
  const holder = element.closest<HTMLElement>("[data-field], [data-slot=field], [data-slot=form-item]");
  const control = holder?.querySelector<HTMLElement>("button[role=combobox], [role=combobox], input:not([type=hidden]), textarea, [contenteditable=true]");
  if (control && visible(control)) return control;
  return holder && visible(holder) ? holder : null;
}

/** The label a field shows (its `<label>`, else its accessible name), or null. */
export function fieldLabel(root: Element | null, field: string): string | null {
  const element = fieldElement(root, field);
  if (!element) return null;
  const own = (element as HTMLInputElement).labels?.[0]?.textContent;
  const holder = element.closest("[data-field], [data-slot=field], [data-slot=form-item]");
  const text = own || holder?.querySelector("label")?.textContent || element.getAttribute("aria-label");
  const label = text?.replace(/\s+/g, " ").trim();
  return label ? label : null;
}

function goToField(root: Element | null, field: string): void {
  const element = fieldElement(root, field);
  const box = element ? visibleBox(element) : null;
  if (!box) return;
  box.scrollIntoView({ block: "center" });
  const focusable = box.matches("input, textarea, button, [tabindex], [contenteditable=true]")
    ? box
    : box.querySelector<HTMLElement>("input:not([type=hidden]), textarea, button, [contenteditable=true]");
  focusable?.focus({ preventScroll: true });
}

/** Overlap of two sets of form names, counting a parent and its nested fields as one. */
export function fieldsOverlap(theirs: readonly string[], mine: readonly string[]): boolean {
  return theirs.some((a) => mine.some((b) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`)));
}

/** What to say about a save by someone else, given this draft. */
export function saveOutcome(save: RemoteSave, dirty: boolean, mine: readonly string[], canMerge: boolean): "merged" | "reload" | "both" {
  if (!dirty) return "reload";
  if (canMerge && save.fields.length > 0 && !fieldsOverlap(save.fields, mine)) return "merged";
  return "both";
}

// ── The banner ───────────────────────────────────────────────────────────

function EditingBanner({ editors, presenceKey }: { editors: RealtimePresence[]; presenceKey: string }) {
  const t = useMessages(realtimeMessages);
  // Dismissed for these people; someone new editing brings it back.
  const [dismissedFor, setDismissedFor] = useState<ReadonlySet<string>>(() => new Set());
  if (editors.length === 0 || editors.every((person) => dismissedFor.has(person.id))) return null;
  const names = editors.length > 3
    ? t("andOthers", { name: editors[0]!.name || "?", count: editors.length - 1 })
    : formatList(editors.map((person) => person.name || "?"), getLocale());
  return (
    <div
      data-slot="presence-banner"
      role="status"
      className="pointer-events-auto flex w-full items-center gap-3 rounded-xl bg-card px-3 py-2 text-body shadow-popover"
    >
      <PersonAvatar person={editors[0]!} />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{t(EDITING_KEY[presencePrefixOf(presenceKey)], { names, count: editors.length })}</span>{" "}
        <span className="text-muted-foreground">{t("mergeHint")}</span>
      </p>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("dismiss")}
        onClick={() => setDismissedFor(new Set(editors.map((person) => person.id)))}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

// ── The save notice ──────────────────────────────────────────────────────

/** "price and stock", with each field a link that scrolls to it and focuses it. */
function FieldLinks({ root, fields }: { root: Element | null; fields: readonly { field: string; label: string }[] }): ReactNode {
  // formatList places the connectors for the language; the markers become links.
  const text = formatList(fields.map((_, index) => `\u0001${index}\u0001`), getLocale());
  return text.split(/\u0001(\d+)\u0001/).map((part, index) =>
    index % 2 === 1 ? (
      <button
        key={part}
        type="button"
        className="font-medium text-link hover:underline"
        onClick={() => goToField(root, fields[Number(part)]!.field)}
      >
        {fields[Number(part)]!.label}
      </button>
    ) : (
      part
    ));
}

function SaveNotice({ presence }: { presence: EditorPresenceValue }) {
  const t = useMessages(realtimeMessages);
  const save = presence.remoteSave!;
  const [outcome, setOutcome] = useState<"merged" | "reload" | "both" | null>(null);
  const handled = useRef<number | null>(null);
  // Decide once per save: merge a dirty draft at once when the fields do not overlap.
  useEffect(() => {
    if (handled.current === save.at) return;
    handled.current = save.at;
    const next = saveOutcome(save, presence.dirty, presence.changedFields?.() ?? [], Boolean(presence.onLoadLatest && presence.changedFields));
    if (next === "merged") presence.onLoadLatest?.();
    setOutcome(next);
  }, [presence, save]);
  if (!outcome) return null;
  const root = presenceRoot(presence.presenceKey);
  const byYou = save.by.id === realtimeUserId();
  const name = save.by.name || "?";
  const labelled = save.fields
    .map((field) => ({ field, label: fieldLabel(root, field) }))
    .filter((entry): entry is { field: string; label: string } => entry.label !== null)
    .filter((entry, index, all) => all.findIndex((other) => other.label === entry.label) === index);
  const fields = labelled.length > 0 ? <FieldLinks root={root} fields={labelled} /> : null;
  // The sentence with the field links put where the catalog puts {fields}.
  const sentence = (key: "savedMerged" | "savedReloadFields" | "savedBoth") => {
    const [before, after] = t(key, { name, fields: "\u0002" }).split("\u0002");
    return <>{before}{fields}{after}</>;
  };
  const title = byYou
    ? t("savedByYou")
    : outcome === "merged"
      ? (fields ? sentence("savedMerged") : t("savedChanges", { name }))
      : outcome === "reload"
        ? (fields ? sentence("savedReloadFields") : t("savedReload", { name }))
        : (fields ? sentence("savedBoth") : t("savedChanges", { name }));
  return (
    <Alert variant="info" className="pointer-events-auto">
      <Info />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {outcome === "both" ? <p>{t("savedBothHint")}</p> : null}
        <div className="mt-2 flex flex-wrap gap-2">
          {outcome !== "merged" && presence.onLoadLatest ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                presence.dismissRemoteSave();
                presence.onLoadLatest?.();
              }}
            >
              {outcome === "reload" ? t("reload") : t("loadLatest")}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={presence.dismissRemoteSave}>{t("dismiss")}</Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

// ── Field rings ──────────────────────────────────────────────────────────

interface Ring {
  person: RealtimePresence;
  x: number;
  y: number;
  width: number;
  height: number;
}

const RING_GAP = 3;

/**
 * A ring around each field someone else is in. The layer is an absolutely
 * placed point inside the page's scroller, so rings scroll with the fields;
 * positions are measured again when the editor or the window resizes.
 */
function FieldRings({ presenceKey, people }: { presenceKey: string; people: RealtimePresence[] }) {
  const origin = useRef<HTMLDivElement>(null);
  const [rings, setRings] = useState<Ring[]>([]);
  const focused = people.filter((person) => person.field);
  const signature = focused.map((person) => `${person.id}=${person.field}`).join("|");
  useLayoutEffect(() => {
    const root = presenceRoot(presenceKey);
    if (!origin.current || !root || focused.length === 0) {
      setRings([]);
      return;
    }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const base = origin.current?.getBoundingClientRect();
      if (!base) return;
      const rtl = document.documentElement.dir === "rtl";
      const next: Ring[] = [];
      for (const person of focused) {
        const element = fieldElement(root, person.field!);
        const box = element ? visibleBox(element) : null;
        if (!box) continue;
        const rect = box.getBoundingClientRect();
        next.push({
          person,
          x: (rtl ? base.left - rect.right : rect.left - base.left) - RING_GAP,
          y: rect.top - base.top - RING_GAP,
          width: rect.width + RING_GAP * 2,
          height: rect.height + RING_GAP * 2,
        });
      }
      setRings(next);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(root);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", schedule);
    };
    // `signature` names exactly who is in which field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenceKey, signature]);
  return (
    <div ref={origin} aria-hidden="true" className="absolute z-10 size-0">
      {rings.map((ring) => {
        const colour = presenceColour(ring.person.id);
        return (
          <div
            key={ring.person.id}
            className={cn("absolute inset-s-(--ring-x) top-(--ring-y) h-(--ring-h) w-(--ring-w) rounded-lg ring-2", PRESENCE_RING[colour])}
            style={{
              "--ring-x": `${ring.x}px`,
              "--ring-y": `${ring.y}px`,
              "--ring-w": `${ring.width}px`,
              "--ring-h": `${ring.height}px`,
            } as CSSProperties}
          >
            <span
              className={cn(
                "absolute -top-5 end-0 max-w-40 truncate rounded-md px-1.5 text-caption font-medium text-presence-foreground",
                PRESENCE_FILL[colour],
              )}
            >
              {firstNameOf(ring.person.name)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function PresenceLayer({ presence }: { presence: EditorPresenceValue }) {
  const editors = presence.others.filter((person) => person.editing);
  // One zero-size, absolutely placed box: it is no flex item and takes no gap or margin
  // wherever an editor puts it. The rings measure from it; the notices are fixed to the view.
  return (
    <div data-slot="presence-layer" className="pointer-events-none absolute size-0">
      <FieldRings presenceKey={presence.presenceKey} people={presence.others} />
      <div className="fixed inset-x-0 bottom-4 z-40 mx-auto flex w-full max-w-xl flex-col gap-2 px-3">
        {presence.remoteSave ? <SaveNotice key={presence.remoteSave.at} presence={presence} /> : null}
        <EditingBanner editors={editors} presenceKey={presence.presenceKey} />
      </div>
    </div>
  );
}
