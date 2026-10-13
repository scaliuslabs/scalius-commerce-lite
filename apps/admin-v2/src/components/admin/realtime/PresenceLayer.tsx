/**
 * What an editor shows once someone else is on it or has saved (loaded only
 * then, by EditorPresenceView.tsx). Calm by design, as in
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
 * Nothing here moves the page: notices are fixed at the bottom of the view,
 * and a ring is an outline on the field itself.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Users } from "lucide-react";
import { formatList } from "@scalius/shared/locale-words";
import type { RealtimePresence } from "@scalius/shared/realtime";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { getLocale, useMessages } from "~/i18n";
import { realtimeMessages } from "~/i18n/realtime";
import { realtimeUserId, type PresencePrefix } from "~/lib/realtime/store";
import type { EditorPresenceValue, RemoteSave } from "~/lib/realtime/editor-presence";
import { presenceRoot } from "~/lib/realtime/presence-dom";
import { PersonAvatar } from "./PresenceAvatars";
import { firstNameOf, presenceVar } from "./presence-style";

/** The record a key names (`product` of `product:prd_1`), for "editing this product". */
function presencePrefixOf(key: string): PresencePrefix {
  return key.slice(0, key.indexOf(":")) as PresencePrefix;
}

const EDITING_KEY = {
  order: "editingOrder",
  product: "editingProduct",
  category: "editingCategory",
  collection: "editingCollection",
  page: "editingPage",
  theme: "editingTheme",
  settings: "editingSettings",
  customer: "editingCustomer",
  discount: "editingDiscount",
  "gift-card": "editingGiftCard",
  "purchase-order": "editingPurchaseOrder",
  transfer: "editingTransfer",
  supplier: "editingSupplier",
  brand: "editingBrand",
  conversation: "editingConversation",
  "price-list": "editingPriceList",
  media: "editingMedia",
  attribute: "editingAttribute",
  menu: "editingMenu",
} as const satisfies Record<PresencePrefix, string>;

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

function EditingBanner({ editors, presenceKey, canMerge, readOnly, dismissedFor, setDismissedFor }: {
  editors: RealtimePresence[];
  presenceKey: string;
  canMerge: boolean;
  readOnly?: boolean;
  /** Dismissed for these people; someone new editing brings it back. */
  dismissedFor: ReadonlySet<string>;
  setDismissedFor(people: ReadonlySet<string>): void;
}) {
  const t = useMessages(realtimeMessages);
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
        {!readOnly ? <span className="text-muted-foreground">{t(canMerge ? "mergeHint" : "reviewHint")}</span> : null}
      </p>
      <Button
        type="button"
        variant="ghost"
        onClick={() => setDismissedFor(new Set(editors.map((person) => person.id)))}
      >
        {t("dismiss")}
      </Button>
    </div>
  );
}

// ── The save notice ──────────────────────────────────────────────────────

/** "price and stock", with each field a link that scrolls to it and focuses it. */
function FieldLinks({ root, fields }: { root: Element | null; fields: readonly { field: string; label: string }[] }): ReactNode {
  // formatList places the connectors for the language; the markers become links.
  const text = formatList(fields.map((_, index) => `\uE000${index}\uE000`), getLocale());
  return text.split(/\uE000(\d+)\uE000/).map((part, index) =>
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
  const canMerge = Boolean(presence.onLoadLatest && presence.changedFields);
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
    const [before, after] = t(key, { name, fields: "\uE001" }).split("\uE001");
    return <>{before}{fields}{after}</>;
  };
  const title = byYou
    ? t("savedByYou")
    : outcome === "merged"
      ? (fields ? sentence("savedMerged") : t("savedChanges", { name }))
      : outcome === "reload"
        ? (fields ? sentence("savedReloadFields") : t("savedReload", { name }))
        : (fields && fieldsOverlap(save.fields, presence.changedFields?.() ?? []) ? sentence("savedBoth") : t("savedChanges", { name }));
  return (
    <Alert variant="info" className="pointer-events-auto">
      <Users />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {outcome === "both" ? <p>{t(canMerge ? "savedBothHint" : "savedReviewHint")}</p> : null}
        {outcome === "reload" && !presence.onLoadLatest ? <p>{t("savedReloadManual")}</p> : null}
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

/**
 * A ring in the person's colour on each field someone else is in, and their
 * first name on a tag at the field's top end (DESIGN.md W3). The field itself
 * carries it (`data-presence-ring` on the control, `data-presence-name` on its
 * field wrapper; styles/global.css), so it moves with the field and costs no
 * measuring. The marks come off when they leave the field.
 */
function FieldRings({ presenceKey, people }: { presenceKey: string; people: RealtimePresence[] }) {
  const focused = people.filter((person) => person.field);
  const signature = focused.map((person) => `${person.id}=${person.field}`).join("|");
  useEffect(() => {
    const root = presenceRoot(presenceKey);
    if (!root || focused.length === 0) return;
    const marked: HTMLElement[] = [];
    const mark = (element: HTMLElement, colour: string) => {
      element.style.setProperty("--presence", colour);
      marked.push(element);
    };
    for (const person of focused) {
      const element = fieldElement(root, person.field!);
      const box = element ? visibleBox(element) : null;
      if (!box) continue;
      const colour = presenceVar(person.id);
      box.dataset.presenceRing = "";
      mark(box, colour);
      const holder = box.closest<HTMLElement>("[data-slot=field], [data-slot=form-item], [data-field]") ?? box.parentElement;
      if (holder) {
        holder.dataset.presenceName = firstNameOf(person.name);
        mark(holder, colour);
      }
    }
    return () => {
      for (const element of marked) {
        delete element.dataset.presenceRing;
        delete element.dataset.presenceName;
        element.style.removeProperty("--presence");
      }
    };
    // `signature` names exactly who is in which field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenceKey, signature]);
  return null;
}

export default function PresenceLayer({ presence }: { presence: EditorPresenceValue }) {
  const editors = presence.others.filter((person) => person.editing);
  const [dismissedFor, setDismissedFor] = useState<ReadonlySet<string>>(() => new Set());
  // The notices are fixed to the view: they take no space wherever an editor puts this.
  return (
    <>
      <FieldRings presenceKey={presence.presenceKey} people={presence.others} />
      <div data-slot="presence-layer" className="pointer-events-none fixed inset-x-0 bottom-3 z-40 mx-auto flex w-full max-w-xl flex-col gap-2 px-3">
        {/* One notice at a time: a save notice already names who is working here. */}
        {presence.remoteSave
          ? <SaveNotice key={presence.remoteSave.at} presence={presence} />
          : <EditingBanner editors={editors} presenceKey={presence.presenceKey} canMerge={Boolean(presence.onLoadLatest && presence.changedFields)} readOnly={presence.readOnly} dismissedFor={dismissedFor} setDismissedFor={setDismissedFor} />}
      </div>
    </>
  );
}
