// The gift cards this order issued (Wave B §9.1): per card its last 4, value and
// masked recipient, with "Resend" for staff who manage gift cards. The code is
// never on this page; resending mails it to the card's contact.
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { giftCardOrderMessages } from "~/i18n/gift-card-orders";
import { apiClient, apiData } from "~/lib/api";
import { formatSavedMinorAmount } from "~/lib/order-tax-presentation";
import { getDecimalPlaces } from "@scalius/shared/currency";
import type { Order } from "./types";

export interface IssuedGiftCardLine {
  giftCardId: string;
  last4: string;
  initialAmountMinor: number;
  currencyCode: string;
  sentTo: string | null;
  productName: string | null;
  variantLabel: string | null;
}

function readIssuedCard(value: unknown): Omit<IssuedGiftCardLine, "productName" | "variantLabel"> | null {
  if (!value || typeof value !== "object") return null;
  const card = value as Record<string, unknown>;
  if (typeof card.giftCardId !== "string" || typeof card.last4 !== "string") return null;
  if (typeof card.initialAmountMinor !== "number" || typeof card.currencyCode !== "string") return null;
  return {
    giftCardId: card.giftCardId,
    last4: card.last4,
    initialAmountMinor: card.initialAmountMinor,
    currencyCode: card.currencyCode,
    sentTo: typeof card.sentTo === "string" && card.sentTo ? card.sentTo : null,
  };
}

/** Every card the order's lines issued (`extras.giftCards`), in line order. */
export function issuedGiftCards(order: Pick<Order, "items">): IssuedGiftCardLine[] {
  return order.items.flatMap((item) => {
    const cards = item.extras?.giftCards;
    if (!Array.isArray(cards)) return [];
    return cards.flatMap((value) => {
      const card = readIssuedCard(value);
      return card ? [{ ...card, productName: item.productName, variantLabel: item.variantLabel }] : [];
    });
  });
}

function resendGiftCard(giftCardId: string) {
  return apiData(apiClient.post<{ 200: { success: boolean; data: { queued: boolean } } }>({
    url: `/api/v1/admin/gift-cards/${encodeURIComponent(giftCardId)}/resend`,
  }));
}

export function GiftCardLinesCard({ order }: { order: Order }) {
  const t = useMessages(giftCardOrderMessages);
  const canManage = useHasPermission(PERMISSIONS.GIFT_CARDS_MANAGE);
  const resend = useMutation({
    mutationFn: ({ giftCardId }: { giftCardId: string }) => resendGiftCard(giftCardId),
    onSuccess: () => void toast.success(t("lines.resent")),
    onError: (error) => void toast.error(t("lines.resendFailed"), {
      description: error instanceof Error ? error.message : undefined,
    }),
  });
  const cards = issuedGiftCards(order);
  if (cards.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("lines.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {cards.map((card) => {
            const product = [card.productName, card.variantLabel].filter(Boolean).join(" · ");
            const sending = resend.isPending && resend.variables?.giftCardId === card.giftCardId;
            return (
              <li key={card.giftCardId} className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 space-y-1">
                  <p className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono font-medium">{t("lines.card", { last4: card.last4 })}</span>
                    <span className="tabular-nums">
                      {formatSavedMinorAmount(card.initialAmountMinor, {
                        currencyCode: card.currencyCode,
                        decimalPlaces: getDecimalPlaces(card.currencyCode),
                      })}
                    </span>
                  </p>
                  {product ? <p className="text-muted-foreground">{product}</p> : null}
                  <p className="text-muted-foreground">
                    {card.sentTo ? t("lines.sentTo", { contact: card.sentTo }) : t("lines.sentToBuyer")}
                  </p>
                </div>
                {canManage ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={sending}
                    disabled={resend.isPending && !sending}
                    aria-label={t("lines.resendLabel", { last4: card.last4 })}
                    onClick={() => resend.mutate({ giftCardId: card.giftCardId })}
                  >
                    {t("lines.resend")}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
