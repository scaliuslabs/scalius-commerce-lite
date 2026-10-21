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
  names: string[];
  matching: boolean;
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
          const more = target.total - target.names.length;
          return (
            <li key={target.kind} className="flex flex-col gap-1">
              <span className="text-body">
                {target.matching && target.total === 0
                  ? t(`targetMatching_${target.kind}`)
                  : t(`target_${target.kind}`, { count: target.total })}
              </span>
              {target.names.length > 0 ? (
                <ul className="flex list-disc flex-col gap-0.5 ps-5 text-body text-muted-foreground">
                  {target.names.map((name, index) => (
                    <li key={`${index}-${name}`} className="break-words">{name}</li>
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
