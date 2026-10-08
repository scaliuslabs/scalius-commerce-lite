/**
 * The side-by-side choice for a real same-field clash (lib/merge-choice.ts).
 * Everything else was already combined; each row here shows the saved version
 * beside the merchant's, and the merchant keeps one per row. Their own version
 * is chosen to start with, so one click saves.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { useMessages } from "~/i18n";
import { realtimeMessages } from "~/i18n/realtime";
import { answerMergeChoice, currentMergeChoice, subscribeMergeChoice } from "~/lib/merge-choice";
import type { MergeChoice } from "~/lib/three-way-merge";
import { cn } from "@scalius/shared/utils";

function Side({
  label,
  value,
  selected,
  onSelect,
}: {
  label: string;
  value: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg border px-3 py-2 text-start hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "border-foreground bg-accent" : "border-border",
      )}
    >
      <span className="text-body text-muted-foreground">{label}</span>
      <span className="line-clamp-3 break-words text-body">{value}</span>
    </button>
  );
}

export function MergeChoiceHost() {
  const t = useMessages(realtimeMessages);
  const pending = useSyncExternalStore(subscribeMergeChoice, currentMergeChoice, () => null);
  const [choices, setChoices] = useState<Record<string, MergeChoice>>({});
  const rows = pending?.request.rows ?? [];
  const rowKey = rows.map((row) => row.key).join("|");
  useEffect(() => {
    setChoices(Object.fromEntries(rowKey ? rowKey.split("|").map((key) => [key, "mine" as const]) : []));
  }, [rowKey, pending]);

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) answerMergeChoice(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("mergeTitle")}</DialogTitle>
          <DialogDescription>{t("mergeBody")}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[min(24rem,60vh)] flex-col gap-4 overflow-y-auto">
          {rows.map((row) => (
            <fieldset key={row.key} className="flex min-w-0 flex-col gap-2">
              <legend className="text-body font-medium">
                {row.label}
                {row.coupled ? <span className="ms-2 font-normal text-muted-foreground">{t("coupledHint")}</span> : null}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <Side
                  label={t("theirs")}
                  value={row.theirs}
                  selected={choices[row.key] === "theirs"}
                  onSelect={() => setChoices((current) => ({ ...current, [row.key]: "theirs" }))}
                />
                <Side
                  label={t("yours")}
                  value={row.mine}
                  selected={choices[row.key] === "mine"}
                  onSelect={() => setChoices((current) => ({ ...current, [row.key]: "mine" }))}
                />
              </div>
            </fieldset>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => answerMergeChoice(null)}>{t("mergeCancel")}</Button>
          <Button onClick={() => answerMergeChoice(choices)}>{t("mergeSave")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default MergeChoiceHost;
