import { orderNumberText } from "~/lib/order-number";
import { useMessages } from "~/i18n";
import { aiAccessMessages } from "~/i18n/settings-ai-access";

// What the owner reads before approving an agent's change (black-box M7): who
// asks, by the connection's name and client, and which records it acts on, by
// product title, SKU, order number and customer name, never raw parameter names.

type Messages = ReturnType<typeof useMessages<keyof typeof aiAccessMessages.en>>;

export interface ChangeRequester {
  name: string;
  client: string | null;
  kind: "oauth" | "pat" | "cli";
}

export interface ChangeTarget {
  kind: "product" | "variant" | "order" | "customer";
  total: number;
  /** Each record by its id, with the name stored for it (text anyone with edit rights wrote). */
  records: Array<{ id: string; name: string | null }>;
  matching: boolean;
}

/** One row of what the change does, as the platform wrote it from the operation's schema. */
export interface ChangeRow {
  kind: "change" | "money" | "target" | "setting" | "words" | "note";
  operationId: string;
  field: string | null;
  text: string;
  amount?: string;
  currency?: string | null;
}

const ROW_LABEL = {
  change: "changeRowChange",
  money: "changeRowMoney",
  target: "changeRowTarget",
  setting: "changeRowSetting",
  words: "changeRowWords",
  note: "changeRowNote",
} as const;

/**
 * What the change does, one row per fact: each row's label comes from its
 * kind, never from its text, so nothing an agent or a record name says can
 * pose as an amount or a target. Amounts show their ISO currency code.
 */
export function ChangeApprovalRows({ rows }: { rows: readonly ChangeRow[] }) {
  const t = useMessages(aiAccessMessages);
  if (rows.length === 0) return null;
  return (
    <dl className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={`${index}-${row.kind}`} className="flex flex-col gap-0.5" data-row-kind={row.kind}>
          <dt className="text-body font-medium">{t(ROW_LABEL[row.kind])}</dt>
          <dd className="text-body break-words text-muted-foreground">
            {row.field ? <span className="font-mono">{row.field} </span> : null}
            {row.kind === "money" ? (
              <span className="text-foreground">
                {row.amount ?? ""} {row.currency ?? t("changeCurrencyUnknown")}
                {row.text ? ` (${row.text})` : ""}
              </span>
            ) : row.kind === "words" ? (
              <q>{row.text}</q>
            ) : row.kind === "change" ? (
              <span className="text-foreground">{row.text} <span className="font-mono">({row.operationId})</span></span>
            ) : (
              <span>{row.text}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
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
                      {" "}<span className="font-mono">({record.id})</span>
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
