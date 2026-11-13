import { formatList } from "@scalius/shared/locale-words";
import { orderNumberText } from "~/lib/order-number";
import { useLocale, useMessages } from "~/i18n";
import { aiAccessMessages } from "~/i18n/settings-ai-access";
import type { ApprovalDescription } from "./approval-describe";

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
  kind: "product" | "variant" | "order" | "customer" | "discount" | "category" | "collection" | "page" | "staff";
  total: number;
  /** Each record by its id, with the name stored for it (text anyone with edit rights wrote). */
  records: Array<{ id: string; name: string | null }>;
  matching: boolean;
}

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

/** The records a change acts on: a count per kind, the names it could read, or every match of a filter. */
export function ChangeApprovalTargets({ targets }: { targets: readonly ChangeTarget[] }) {
  const t = useMessages(aiAccessMessages);
  if (targets.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body font-medium">{t("changeAffects")}</p>
      <ul className="flex flex-col gap-3">
        {targets.map((target) => {
          const more = target.total - target.records.length;
          return (
            <li key={target.kind} className="flex flex-col gap-1">
              <span className="text-body">
                {target.matching && target.total === 0
                  ? t(`targetMatching_${target.kind}`)
                  : t(`target_${target.kind}`, { count: target.total })}
              </span>
              {target.records.length > 0 ? (
                <ul className="flex list-disc flex-col gap-0.5 ps-5 text-body text-muted-foreground">
                  {target.records.map((record) => (
                    <li key={record.id} className="break-words">
                      {record.name === null
                        ? t("changeNameMissing")
                        : target.kind === "order" ? orderNumberText(record.name) : record.name}
                    </li>
                  ))}
                  {more > 0 ? <li className="list-none">{t("changeAndMore", { count: more })}</li> : null}
                </ul>
              ) : null}
              {target.matching && target.total > 0 ? (
                <span className="text-body text-muted-foreground">{t(`targetMatching_${target.kind}`)}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
