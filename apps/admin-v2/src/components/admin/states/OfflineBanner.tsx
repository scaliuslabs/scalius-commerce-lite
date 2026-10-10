import { CloudOff } from "lucide-react";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";

/**
 * The calm offline line under the top bar (polish bar R6). The shell, the
 * open page and its read data stay; edits stay in their forms; nothing is
 * queued. `waiting` says a page the merchant asked for opens on reconnect.
 */
export function OfflineBanner({ waiting = false }: { waiting?: boolean }) {
  const t = useMessages(shellMessages);
  return (
    <div
      data-slot="offline-banner"
      role="status"
      className="flex items-start gap-2 border-b border-warning bg-warning-surface px-3 py-2 text-body text-foreground sm:px-4 md:px-6"
    >
      <span className="flex h-lh items-center">
        <CloudOff aria-hidden className="size-4 text-warning" />
      </span>
      <p className="min-w-0 flex-1">{t(waiting ? "offlineWaiting" : "offlineBanner")}</p>
    </div>
  );
}
