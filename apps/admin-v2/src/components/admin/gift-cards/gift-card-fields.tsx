import { Badge } from "~/components/ui/badge";
import { Checkbox } from "~/components/ui/checkbox";
import { ChoiceField } from "~/components/ui/field";
import { useMessages } from "~/i18n";
import { giftCardsMessages } from "~/i18n/gift-cards";
import { GIFT_CARD_STATUS_BADGE, giftCardDisplayStatus } from "./gift-card-format";

export function GiftCardCheckRow({ id, label, help, checked, disabled, onChange }: {
  id: string;
  label: string;
  help?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <ChoiceField
      id={id}
      label={label}
      help={help}
      control={(
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          aria-describedby={help ? `${id}-help` : undefined}
          onCheckedChange={(value) => onChange(value === true)}
        />
      )}
    />
  );
}

/** Active / Disabled / Expired / Used up, as text and colour. */
export function GiftCardStatusBadge({ card }: { card: { status: string; expired: boolean; balanceMinor: number } }) {
  const t = useMessages(giftCardsMessages);
  const status = giftCardDisplayStatus(card);
  return <Badge variant={GIFT_CARD_STATUS_BADGE[status]}>{t(`status_${status}`)}</Badge>;
}
