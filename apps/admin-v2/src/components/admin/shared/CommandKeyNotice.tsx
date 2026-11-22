import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { useMessages } from "~/i18n";
import { commandNoticeMessages, type CommandNoticeTarget } from "~/i18n/command-notice";
import type { KeyNotice } from "~/lib/use-command";

/** The one way a screen says its command's earlier attempt may have gone through, or did. */
export function CommandKeyNotice({ notice, target, startOver, children }: {
  notice: KeyNotice | null;
  target: CommandNoticeTarget;
  /**
   * Offered only when the server can neither tell nor replay the earlier attempt
   * ("outcome unknown"): starting over may record it twice, so the label names the check.
   */
  startOver?: { kind: "payment" | "dispute"; onClick: () => void };
  /** An action beside the words ("Check the order"). */
  children?: ReactNode;
}) {
  const t = useMessages(commandNoticeMessages);
  if (!notice) return null;
  const text = notice === "outcome-unknown"
    ? t("unknown.order")
    : t(`${notice === "landed" ? "landed" : "open"}.${target}`);
  const restart = notice === "outcome-unknown" && startOver
    ? <Button type="button" variant="destructive" size="sm" className="h-auto whitespace-normal text-left" onClick={startOver.onClick}>{t(`startOver.${startOver.kind}`)}</Button>
    : null;
  const actions = children || restart ? <>{children}{restart}</> : null;
  return (
    <Alert role="status" data-testid="command-key-notice">
      <AlertDescription>
        {actions ? <div className="flex flex-col items-start gap-2"><p>{text}</p><div className="flex flex-wrap gap-2">{actions}</div></div> : text}
      </AlertDescription>
    </Alert>
  );
}
