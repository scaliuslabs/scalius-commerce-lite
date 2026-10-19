import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { webhooksMessages } from "~/i18n/settings-webhooks";
import { deliveryErrorText } from "./webhook-format";

/** A delivery's error: what failed in plain words, then the recorded reason (with any reference) as a detail. */
export function DeliveryError({ error, tone = "muted" }: { error: string; tone?: "muted" | "destructive" }) {
  const t = useMessages(webhooksMessages);
  const { text, detail } = deliveryErrorText(error);
  return (
    <div className="space-y-0.5">
      <p className={cn("break-words text-body", tone === "destructive" ? "text-destructive" : "text-muted-foreground")}>{text}</p>
      {detail ? (
        <p className="break-words text-body text-muted-foreground">
          {t("errorDetail")} <code className="wrap-anywhere">{detail}</code>
        </p>
      ) : null}
    </div>
  );
}
