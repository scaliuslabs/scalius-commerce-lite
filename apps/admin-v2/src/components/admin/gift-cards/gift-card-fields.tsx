import type { ReactNode } from "react";
import { Badge } from "~/components/ui/badge";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { useMessages } from "~/i18n";
import { giftCardsMessages } from "~/i18n/gift-cards";
import { GIFT_CARD_STATUS_BADGE, giftCardDisplayStatus } from "./gift-card-format";

/** Label, control, then the error (or the help) under it, tied to the control by id. */
export function GiftCardField({ id, label, help, error, children }: {
  id: string;
  label: string;
  help?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? <p id={`${id}-error`} className="text-body text-destructive">{error}</p> : null}
      {!error && help ? <p id={`${id}-help`} className="text-body text-muted-foreground">{help}</p> : null}
    </div>
  );
}

/** The `aria-describedby` for a GiftCardField's control. */
export function fieldDescribedBy(id: string, error: string | undefined, help: boolean): string | undefined {
  if (error) return `${id}-error`;
  return help ? `${id}-help` : undefined;
}

export function GiftCardCheckRow({ id, label, help, checked, disabled, onChange }: {
  id: string;
  label: string;
  help?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex h-lh items-center">
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          aria-describedby={help ? `${id}-help` : undefined}
          onCheckedChange={(value) => onChange(value === true)}
        />
      </span>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id}>{label}</Label>
        {help ? <p id={`${id}-help`} className="text-body text-muted-foreground">{help}</p> : null}
      </div>
    </div>
  );
}

/** Active / Disabled / Expired / Used up, as text and colour. */
export function GiftCardStatusBadge({ card }: { card: { status: string; expired: boolean; balanceMinor: number } }) {
  const t = useMessages(giftCardsMessages);
  const status = giftCardDisplayStatus(card);
  return <Badge variant={GIFT_CARD_STATUS_BADGE[status]}>{t(`status_${status}`)}</Badge>;
}
