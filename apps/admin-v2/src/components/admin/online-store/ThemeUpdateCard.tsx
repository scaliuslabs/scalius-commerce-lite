/**
 * Themes → "Theme update": what an app's new release of the draft's template
 * brings (`GET /theme/template-update`, a three-way merge with the release
 * the store applied). Improvements (parts the merchant never changed) are
 * ticked; each conflict ("the theme now suggests X; you have Y") stays the
 * merchant's unless they tick it. "Put in draft" takes the choice into the
 * draft (the draft it replaces kept in the history), where Preview and
 * Publish on the current theme card take over; "Keep my theme as it is"
 * takes nothing and the same update is not offered again. A store with no
 * record of the release it applied can compare with the installed release,
 * every difference its own choice.
 */
import { useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import {
  getApiV1AdminSettingsThemeTemplateUpdate,
  postApiV1AdminSettingsThemeTemplateUpdate,
} from "@scalius/api-client/sdk";
import type { StorefrontSection } from "@scalius/shared/storefront-theme";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { ChoiceField } from "~/components/ui/field";
import { getLocale, useMessages } from "~/i18n";
import { formatList } from "@scalius/shared/locale-words";
import { onlineStoreMessages } from "~/i18n/online-store";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { apiData, type ApiResult } from "~/lib/api";
import { SectionCard, actionErrorText } from "./shared";

type Update = NonNullable<ApiResult<typeof getApiV1AdminSettingsThemeTemplateUpdate>["update"]>;
type Item = Update["items"][number];
const useCopy = () => useMessages(onlineStoreMessages);
type Messages = ReturnType<typeof useCopy>;

export const themeTemplateUpdateKey = (compare: boolean) => ["theme-template-update", compare] as const;

const HEX = /^#[0-9a-f]{6}$/i;

/** A value as the merchant reads it: a colour with its swatch, short words as they are, anything larger as "changed". */
function Value({ value, t }: { value: unknown; t: Messages }) {
  if (value === undefined || value === null) return <>{t("themeUpdateNone")}</>;
  if (typeof value === "string" && HEX.test(value)) {
    return (
      <span className="inline-flex items-center gap-1">
        <span aria-hidden className="inline-block size-3 rounded-xs border border-border bg-(--swatch)" style={{ "--swatch": value } as CSSProperties} />
        <code>{value}</code>
      </span>
    );
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return <>{String(value)}</>;
  return <>{t("themeUpdateChanged")}</>;
}

/** What names a list member for the merchant: its id, label, name, kind or part; a word as itself. */
function memberName(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["id", "label", "name", "kind", "part", "type"]) if (typeof record[key] === "string") return record[key] as string;
  }
  return JSON.stringify(value);
}

/**
 * A structured value's difference in the merchant's words: for a list, the
 * members the theme adds, removes and changes (by id or label); for an
 * object, the fields that differ. Null for single values.
 */
function difference(mine: unknown, theirs: unknown, t: Messages): string | null {
  const locale = getLocale();
  if (Array.isArray(mine) || Array.isArray(theirs)) {
    const [before, after] = [Array.isArray(mine) ? mine : [], Array.isArray(theirs) ? theirs : []];
    const names = (list: unknown[]) => new Map(list.map((member) => [memberName(member), JSON.stringify(member)]));
    const [old, next] = [names(before), names(after)];
    const added = [...next.keys()].filter((name) => !old.has(name));
    const removed = [...old.keys()].filter((name) => !next.has(name));
    const changed = [...next.keys()].filter((name) => old.has(name) && old.get(name) !== next.get(name));
    const parts = [
      added.length > 0 ? t("themeUpdateListAdded", { items: formatList(added, locale) }) : null,
      removed.length > 0 ? t("themeUpdateListRemoved", { items: formatList(removed, locale) }) : null,
      changed.length > 0 ? t("themeUpdateListChanged", { items: formatList(changed, locale) }) : null,
    ].filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(" ") : t("themeUpdateListOrder");
  }
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
  if (!isObject(mine) && !isObject(theirs)) return null;
  const [before, after] = [isObject(mine) ? mine : {}, isObject(theirs) ? theirs : {}];
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  return t("themeUpdateFields", { fields: formatList(fields, locale) });
}

const AREA = {
  tokens: "themeUpdateAreaTokens",
  blocks: "themeUpdateAreaBlocks",
  skins: "themeUpdateAreaSkins",
  privatePages: "themeUpdateAreaPrivatePages",
  home: "themeUpdateAreaHome",
} as const;

/** Where an item sits, in the merchant's words: its area, then the place (a section by its name). */
function itemLabel(item: Item, sections: readonly StorefrontSection[], sectionName: (section: StorefrontSection) => string, t: Messages): string {
  const area = t(AREA[item.area]);
  if (item.area === "home") {
    if (item.change === "order") return `${area}: ${t("themeUpdateOrder")}`;
    const id = item.path[1]!;
    const section = sections.find((each) => each.id === id) ?? (item.theirs as StorefrontSection | undefined) ?? (item.mine as StorefrontSection | undefined);
    const name = section ? sectionName(section) : id;
    if (item.change === "add") return `${area}: ${t("themeUpdateNewSection", { name })}`;
    if (item.change === "remove") return `${area}: ${t("themeUpdateRemoveSection", { name })}`;
    return [`${area}: ${name}`, ...item.path.slice(2).filter((part) => part !== "settings")].join(" › ");
  }
  const place = item.area === "tokens" ? item.path.slice(1) : item.path.slice(1).filter((part) => part !== "tokens");
  return [area, ...place].join(" › ").replace(" › ", ": ");
}

export function ThemeUpdateCard({ draft, templateName, sections, sectionName, canEdit, onTaken }: {
  draft: { revision: number; basePublishedRevision: number; template: string | null };
  templateName: (key: string) => string;
  sections: readonly StorefrontSection[];
  sectionName: (section: StorefrontSection) => string;
  canEdit: boolean;
  onTaken: () => Promise<void>;
}) {
  const t = useCopy();
  const queryClient = useQueryClient();
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState<"take" | "keep" | null>(null);
  /** Ids whose default the merchant flipped: an improvement left out, or a conflict taken. */
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const query = useQuery({
    queryKey: [...themeTemplateUpdateKey(compare), draft.revision],
    // Every page: the merchant takes only what they were shown, so they are shown all of it.
    queryFn: async () => {
      const first = await apiData(getApiV1AdminSettingsThemeTemplateUpdate({ query: compare ? { compare: "true" } : {} }));
      if (!first.update) return null;
      const items = [...first.update.items];
      for (let more = first.update.moreItems; more > 0;) {
        const page = (await apiData(getApiV1AdminSettingsThemeTemplateUpdate({ query: { ...(compare ? { compare: "true" as const } : {}), offset: items.length } }))).update;
        if (!page || page.digest !== first.update.digest || page.items.length === 0) throw new Error("The theme update changed while it loaded.");
        items.push(...page.items);
        more = page.moreItems;
      }
      return { ...first.update, items, moreItems: 0 };
    },
    enabled: draft.template !== null && draft.template.includes("/"),
  });
  const update = query.data ?? null;
  const taking = (item: Item) => (item.kind === "improvement") !== flipped.has(item.id);
  const take = update ? update.items.filter(taking).map((item) => item.id) : [];
  // The save check for the merchant's own choice: re-run whenever a tick flips, so a warning is never stale.
  const check = useQuery({
    queryKey: ["theme-template-update-check", update?.digest, draft.revision, take.join("\n")],
    queryFn: async () => (await apiData(postApiV1AdminSettingsThemeTemplateUpdate({
      body: { expectedDraftRevision: draft.revision, basePublishedRevision: draft.basePublishedRevision, digest: update!.digest, take, compare, dryRun: true },
    }))).issues,
    enabled: update !== null && flipped.size > 0,
  });

  if (!update) {
    // A store on an app template that kept no record of its release may still compare with the installed one.
    if (!canEdit || !draft.template?.includes("/") || query.isPending || compare) return null;
    return (
      <div>
        <Button type="button" variant="link" onClick={() => setCompare(true)}>{t("themeUpdateCompare")}</Button>
      </div>
    );
  }

  const issues = flipped.size > 0 ? check.data ?? [] : update.issues;
  const flip = (id: string) => setFlipped((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const submit = async (keepAll: boolean) => {
    setBusy(keepAll ? "keep" : "take");
    try {
      await apiData(postApiV1AdminSettingsThemeTemplateUpdate({
        body: { expectedDraftRevision: draft.revision, basePublishedRevision: draft.basePublishedRevision, digest: update.digest, take: keepAll ? [] : take, compare },
      }));
      toast.success(t(keepAll ? "themeUpdateKept" : "themeUpdateApplied"));
      setFlipped(new Set());
      setCompare(false);
      await queryClient.invalidateQueries({ queryKey: ["theme-template-update"] });
      await onTaken();
    } catch (error) {
      toast.error(isAdminApiConflictError(error) ? t("themeActionConflict") : actionErrorText(error));
      // A refused choice shows its issues on the rows they come from (the check runs again).
      await queryClient.invalidateQueries({ queryKey: [isAdminApiConflictError(error) ? "theme-template-update" : "theme-template-update-check"] });
    } finally {
      setBusy(null);
    }
  };

  const nameOf = (id: string) => {
    const section = sections.find((each) => each.id === id);
    return section ? sectionName(section) : id;
  };
  const conflicts = update.items.filter((item) => item.kind === "conflict");
  const improvements = update.items.filter((item) => item.kind === "improvement");
  const row = (item: Item, help: ReactNode) => {
    const own = issues.filter((issue) => issue.itemIds.includes(item.id));
    return (
      <li key={item.id}>
        <ChoiceField
          id={`theme-update-${item.id}`}
          label={itemLabel(item, sections, sectionName, t)}
          help={help}
          error={own.length > 0 ? t("themeUpdateRowIssue", { message: own[0]!.message }) : undefined}
          control={<Checkbox id={`theme-update-${item.id}`} checked={taking(item)} disabled={!canEdit || busy !== null} onCheckedChange={() => flip(item.id)} />}
        />
      </li>
    );
  };
  const conflictHelp = (item: Item): ReactNode => {
    if (item.change === "add") return item.replaces ? t("themeUpdateReplaces", { name: nameOf(item.replaces) }) : t("themeUpdateRemoved");
    if (item.change === "remove") return t("themeUpdateDropped");
    const structured = difference(item.mine, item.theirs, t);
    if (structured) return <>{structured} {Array.isArray(item.mine) || Array.isArray(item.theirs) ? t("themeUpdateListWhole") : null}</>;
    return <>{t("themeUpdateSuggestsPrefix")} <Value value={item.theirs} t={t} />; {t("themeUpdateYouHave")} <Value value={item.mine} t={t} />.</>;
  };
  const improvementHelp = (item: Item): ReactNode => {
    if (item.change !== "set") return null;
    return difference(item.mine, item.theirs, t) ?? <><Value value={item.mine} t={t} /> → <Value value={item.theirs} t={t} /></>;
  };
  const note = update.base === "assumed" ? t("themeUpdateAssumed") : update.base === "none" ? t("themeUpdateCompareHelp") : null;
  const unplaced = issues.filter((issue) => issue.itemIds.length === 0);

  return (
    <SectionCard
      title={t("themeUpdateTitle", { name: templateName(update.template), version: update.to })}
      description={t("themeUpdateSummary", { improvements: update.improvements, conflicts: update.conflicts })}
    >
      <div className="space-y-4" data-theme-update>
        {note ? <p className="text-body text-muted-foreground">{note}</p> : null}
        {unplaced.length > 0 ? <p className="text-body text-destructive">{t("themeUpdateBlocked", { message: unplaced[0]!.message })}</p> : null}
        {conflicts.length > 0 ? (
          <section aria-labelledby="theme-update-conflicts" className="space-y-2">
            <h3 id="theme-update-conflicts" className="text-heading-sm">{t("themeUpdateConflicts")}</h3>
            <ul className="space-y-3">{conflicts.map((item) => row(item, conflictHelp(item)))}</ul>
          </section>
        ) : null}
        {improvements.length > 0 ? (
          <section aria-labelledby="theme-update-improvements" className="space-y-2">
            <h3 id="theme-update-improvements" className="text-heading-sm">{t("themeUpdateImprovements")}</h3>
            <ul className="space-y-3">{improvements.map((item) => row(item, improvementHelp(item)))}</ul>
          </section>
        ) : null}
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={busy !== null || issues.length > 0} loading={busy === "take"} onClick={() => void submit(false)}>{t("themeUpdateApply")}</Button>
            <Button type="button" variant="outline" disabled={busy !== null} loading={busy === "keep"} onClick={() => void submit(true)}>{t("themeUpdateKeepAll")}</Button>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
