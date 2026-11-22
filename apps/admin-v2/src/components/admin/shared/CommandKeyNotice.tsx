import type { ReactNode } from "react";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { useMessages } from "~/i18n";
import { commandNoticeMessages, type CommandNoticeTarget } from "~/i18n/command-notice";
import type { KeyNotice } from "~/lib/use-command";

/** The one way a screen says its command's earlier attempt may have gone through, or did. */
export function CommandKeyNotice({ notice, target, children }: {
  notice: KeyNotice | null;
  target: CommandNoticeTarget;
  /** An action beside the words ("Check the order"). */
  children?: ReactNode;
}) {
  const t = useMessages(commandNoticeMessages);
  if (!notice) return null;
  const text = t(`${notice === "landed" ? "landed" : "open"}.${target}`);
  return (
    <Alert role="status" data-testid="command-key-notice">
      <AlertDescription>
        {children ? <div className="flex flex-col items-start gap-2"><p>{text}</p>{children}</div> : text}
      </AlertDescription>
    </Alert>
  );
}
