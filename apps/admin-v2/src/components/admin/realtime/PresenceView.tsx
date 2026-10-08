/**
 * The presence line and the live save notice (see EditorPresence.tsx). Calm
 * by design: the line appears and leaves without motion, and a save by
 * someone else is one inline notice the merchant can act on or dismiss.
 * Copy: i18n/realtime.ts.
 */
import { Users } from "lucide-react";
import { formatList } from "@scalius/shared/locale-words";
import type { RealtimePerson } from "@scalius/shared/realtime";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { getLocale, useMessages } from "~/i18n";
import { realtimeMessages } from "~/i18n/realtime";
import { realtimeUserId } from "~/lib/realtime/store";
import type { EditorPresence as EditorPresenceState } from "~/lib/realtime/presence";

const SHOWN_NAMES = 2;

/** Up to two letters from a display name, for the avatar. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = Array.from(parts[0]!)[0] ?? "";
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1]!)[0] ?? "" : "";
  return `${first}${last}`.toLocaleUpperCase(getLocale());
}

export function useOthersLine(others: readonly RealtimePerson[]): string | null {
  const t = useMessages(realtimeMessages);
  if (others.length === 0) return null;
  const names = others.map((person) => person.name || "?");
  const shown = names.length > SHOWN_NAMES + 1
    ? t("andOthers", { name: names[0]!, count: names.length - 1 })
    : formatList(names, getLocale());
  return t("alsoEditing", { names: shown, count: others.length });
}

export function PresenceAvatars({ others }: { others: readonly RealtimePerson[] }) {
  const line = useOthersLine(others);
  if (!line) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 text-body text-muted-foreground" aria-live="polite">
      <div className="flex shrink-0 gap-1">
        {others.slice(0, 3).map((person) => (
          <span
            key={person.id}
            title={person.name}
            aria-hidden="true"
            className="flex size-6 items-center justify-center rounded-lg bg-success-surface text-caption font-semibold text-success"
          >
            {initialsOf(person.name)}
          </span>
        ))}
      </div>
      <span className="truncate">{line}</span>
    </div>
  );
}

/** What `EditorPresence` shows once someone else is there or has saved (loaded only then). */
export default function PresenceNotice({
  others,
  remoteSave,
  dismissRemoteSave,
  dirty,
  onLoadLatest,
}: EditorPresenceState & { dirty: boolean; onLoadLatest?: () => void }) {
  const t = useMessages(realtimeMessages);
  const byYou = remoteSave?.by.id === realtimeUserId();
  return (
    <div className="flex flex-col gap-2">
      <PresenceAvatars others={others} />
      {remoteSave ? (
        <Alert variant="info">
          <Users />
          <AlertTitle>{byYou ? t("savedByYou") : t("savedByOther", { name: remoteSave.by.name || "?" })}</AlertTitle>
          <AlertDescription>
            <p>{dirty ? t("savedHint") : t("savedHintClean")}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {onLoadLatest ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    dismissRemoteSave();
                    onLoadLatest();
                  }}
                >
                  {t("loadLatest")}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={dismissRemoteSave}>{t("dismiss")}</Button>
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
