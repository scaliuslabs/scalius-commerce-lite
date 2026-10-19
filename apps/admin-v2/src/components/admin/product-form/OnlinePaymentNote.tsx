import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useMessages } from "~/i18n";
import { productMessages } from "~/i18n/products";
import { setupGuideQueryOptions } from "~/lib/api-query-options/dashboard-home";
import type { ProductFormValues } from "./types";

/** The editor reads checkout's payment methods once in a while, not on every visit. */
const ONLINE_PAYMENT_STALE_TIME_MS = 60_000;

/**
 * An active gift card or all-digital product is paid only online: when
 * checkout takes only cash on delivery, buyers can't buy it, so the editor
 * says so beside its status and links to Payments (the same fact Home's
 * to-do counts).
 */
export function OnlinePaymentNote({ form }: { form: UseFormReturn<ProductFormValues> }) {
  const t = useMessages(productMessages);
  const [isActive, isGiftCard, fulfillmentKind] = useWatch({
    control: form.control,
    name: ["isActive", "isGiftCard", "fulfillmentKind"],
  });
  const paidOnlyOnline = Boolean(isActive) && (isGiftCard === true || fulfillmentKind === "digital");
  const checkout = useQuery({
    ...setupGuideQueryOptions(),
    staleTime: ONLINE_PAYMENT_STALE_TIME_MS,
    enabled: paidOnlyOnline,
  });
  if (!paidOnlyOnline || checkout.data?.onlinePayment?.ready !== false) return null;
  return (
    <Alert variant="warning" data-online-payment-note>
      <AlertDescription>
        <span className="flex flex-col items-start gap-2">
          <span>{t("onlinePaymentNeededNote")}</span>
          <Button variant="outline" size="sm" asChild>
            <Link to="/admin/settings/payments">{t("onlinePaymentNeededAction")}</Link>
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  );
}
