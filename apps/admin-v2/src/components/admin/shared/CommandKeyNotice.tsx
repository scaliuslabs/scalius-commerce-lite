import type { ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { useMessages } from "~/i18n";
import { commandNoticeMessages, type CommandNoticeTarget } from "~/i18n/command-notice";
import type { KeyNotice } from "~/lib/use-command";

/** The one way a screen says its command's earlier attempt may have gone through, or did. */
export function CommandKeyNotice({ notice, target, onStartOver, children }: {
  notice: KeyNotice | null;
  target: CommandNoticeTarget;
  /**
   * For a server that cannot settle a changed request under an open key (it answers
   * "outcome unknown"): the person checks, then ends the key deliberately.
   */
  onStartOver?: () => void;
  /** An action beside the words ("Check the order"). */
  children?: ReactNode;
}) {
  const t = useMessages(commandNoticeMessages);
  if (!notice) return null;
  const text = t(`${notice === "landed" ? "landed" : "open"}.${target}`);
  const startOver = notice === "may-have-landed" && onStartOver
    ? <Button type="button" variant="outline" size="sm" onClick={onStartOver}>{t("startOver")}</Button>
    : null;
  const actions = children || startOver ? <>{children}{startOver}</> : null;
  return (
    <Alert role="status" data-testid="command-key-notice">
      <AlertDescription>
        {actions ? <div className="flex flex-col items-start gap-2"><p>{text}</p><div className="flex flex-wrap gap-2">{actions}</div></div> : text}
      </AlertDescription>
    </Alert>
  );
}
