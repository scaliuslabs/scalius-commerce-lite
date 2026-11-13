import { formatList } from "@scalius/shared/locale-words";
import { useLocale, useMessages } from "~/i18n";
import { aiAccessMessages } from "~/i18n/settings-ai-access";
import type { BuiltInRoleKey } from "@scalius/shared/built-in-roles";
import type { ApprovalRecordKind } from "@scalius/shared/agent-approval";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { rolePermissionsText, targetRecordName, type ApprovalDescription } from "./approval-describe";

// What the owner reads before approving an agent's change (black-box M7): who
// asks, by the connection's name and client, what it wants to do in a
// sentence, each fact under a label in the dashboard's language
// (approval-describe.ts), and which records it acts on, by product title, SKU,
// order number, customer, discount, category, collection, page or staff name.

type Messages = ReturnType<typeof useMessages<keyof typeof aiAccessMessages.en>>;

export interface ChangeRequester {
  name: string;
  client: string | null;
  kind: "oauth" | "pat" | "cli";
}

export interface ChangeTarget {
  kind: ApprovalRecordKind;
  total: number;
  /** Each record by its id, with the name stored for it (text anyone with edit rights wrote, null when it has none); a payment or chargeback with its amount, a role with what it may do. */
  records: Array<{ id: string; name: string | null; amount?: string; currency?: string; permissions?: string[]; builtInRole?: BuiltInRoleKey }>;
}

/** Records shown per kind before "Show all": a longer list is opened before Approve is offered. */
export const AFFECTS_SHOWN = 10;

/**
 * What the change does, in the dashboard's language: the sentence (who asks
 * and what it wants to do), then each fact under its label. A label comes
 * from the dashboard's vocabulary and a row's kind, never from its text, so
 * nothing an agent or a record name says can pose as an amount or a target;
 * the agent's own words are quoted and marked as unchecked.
 */
export function ChangeApprovalSummary({
  description,
  requester,
}: {
  description: ApprovalDescription;
  requester: string | null;
}) {
  const t = useMessages(aiAccessMessages);
  const locale = useLocale();
  const actions = formatList(description.actions, locale);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body">
        {actions
          ? requester ? t("changeWants", { requester, actions }) : t("changeWantsUnnamed", { actions })
          : t("changeDescription")}{" "}
        <span className="text-muted-foreground">{t("changeRunsOnce")}</span>
      </p>
      {description.lines.length > 0 ? (
        <dl className="flex flex-col gap-2">
          {description.lines.map((line, index) => (
            <div key={`${index}-${line.kind}`} className="flex flex-col gap-0.5" data-row-kind={line.kind}>
              <dt className="text-body font-medium">{line.label}</dt>
              <dd className="text-body break-words text-muted-foreground">
                {line.kind === "words" ? (
                  <>
                    <q>{line.value}</q> <span>({t("changeWordsHint")})</span>
                  </>
                ) : (
                  <span className={line.kind === "money" ? "text-foreground" : undefined}>{line.value}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/** "Claude Code via Scalius CLI", or "CI (Access key)" for a key without a client. */
export function changeRequesterText(t: Messages, requester: ChangeRequester | null | undefined): string | null {
  if (!requester) return null;
  const kind = t(`kind_${requester.kind}`);
  const name = requester.name || kind;
  if (requester.client && requester.client !== requester.name) {
    return t("changeRequesterVia", { name, client: requester.client });
  }
  return t("changeRequesterKind", { name, kind });
}

/** The kinds whose list is longer than shown and not opened yet: Approve waits until each is. */
export function closedTargetLists(targets: readonly ChangeTarget[], opened: ReadonlySet<string>): string[] {
  return targets.filter((target) => target.records.length > AFFECTS_SHOWN && !opened.has(target.kind)).map((target) => target.kind);
}

/**
 * Every record a change acts on, by kind: its count, then each by the name
 * staff call it with its id beside (a role with what it may do). A long
 * list shows its first records and "Show all", and the page offers Approve
 * only once every list is open, so a person approves what they have seen.
 */
export function ChangeApprovalTargets({
  targets,
  opened = new Set<string>(),
  onOpen,
}: {
  targets: readonly ChangeTarget[];
  opened?: ReadonlySet<string>;
  onOpen?: (kind: string) => void;
}) {
  const t = useMessages(aiAccessMessages);
  const locale = useLocale();
  if (targets.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body font-medium">{t("changeAffects")}</p>
      <ul className="flex flex-col gap-3">
        {targets.map((target) => {
          const open = opened.has(target.kind) || target.records.length <= AFFECTS_SHOWN;
          const shown = open ? target.records : target.records.slice(0, AFFECTS_SHOWN);
          return (
            <li key={target.kind} className="flex flex-col gap-1">
              <span className="text-body">{t(`target_${target.kind}`, { count: target.total })}</span>
              <ul className={cn("flex list-disc flex-col gap-0.5 ps-5 text-body text-muted-foreground", open && target.records.length > AFFECTS_SHOWN && "max-h-96 overflow-y-auto")}>
                {shown.map((record) => (
                  <li key={record.id} className="break-words">
                    {/* The id beside the name: two records alike (a rename, two namesakes) stay apart. */}
                    {targetRecordName(target.kind, record, locale) ?? t("changeNameMissing")}
                    {" "}<span className="font-mono">({record.id})</span>
                    {target.kind === "role" && record.permissions ? (
                      <span className="block">{rolePermissionsText(record.permissions, locale)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
              {open ? null : (
                <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => onOpen?.(target.kind)}>
                  {t("changeShowAll", { count: target.records.length })}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
