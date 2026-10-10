/**
 * The people on a record, beside its title (DESIGN.md W1): 28px circles with
 * initials in each person's colour, at most three then "+N". The full name and
 * "editing" or "viewing" show on hover and on focus. Loaded only when someone
 * else is there; the box around it (`PresenceSlot`) keeps the space.
 */
import { formatList } from "@scalius/shared/locale-words";
import type { CSSProperties } from "react";
import type { RealtimePresence } from "@scalius/shared/realtime";
import { cn } from "@scalius/shared/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { getLocale, useMessages } from "~/i18n";
import { realtimeMessages } from "~/i18n/realtime";
import { initialsOf, presenceVar } from "./presence-style";

const SHOWN = 3;

export function PersonAvatar({ person, className }: { person: RealtimePresence; className?: string }) {
  const t = useMessages(realtimeMessages);
  const label = t(person.editing ? "personEditing" : "personViewing", { name: person.name || "?" });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          tabIndex={0}
          aria-label={label}
          style={{ "--presence": presenceVar(person.id) } as CSSProperties}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full bg-(--presence) text-caption font-semibold text-(--presence-foreground) ring-2 ring-background",
            className,
          )}
        >
          <span aria-hidden="true">{initialsOf(person.name)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export default function PresenceAvatars({ people }: { people: readonly RealtimePresence[] }) {
  const t = useMessages(realtimeMessages);
  const shown = people.length > SHOWN + 1 ? people.slice(0, SHOWN) : people.slice(0, SHOWN + 1);
  const rest = people.slice(shown.length);
  const restNames = formatList(rest.map((person) => person.name || "?"), getLocale());
  return (
    <div className="flex items-center">
      {shown.map((person, index) => (
        <PersonAvatar key={person.id} person={person} className={index > 0 ? "-ms-1.5" : undefined} />
      ))}
      {rest.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              tabIndex={0}
              aria-label={t("othersHere", { names: restNames })}
              className="-ms-1.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-caption font-semibold text-foreground ring-2 ring-background"
            >
              <span aria-hidden="true">{t("morePeople", { count: rest.length })}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("othersHere", { names: restNames })}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
