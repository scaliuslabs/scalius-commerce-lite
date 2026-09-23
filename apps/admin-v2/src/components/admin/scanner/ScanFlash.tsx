import { CheckCircle, XCircle } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { useMessages } from "~/i18n";
import { scannerMessages } from "~/i18n/scanner";

export type FlashState =
  | {
      type: "success";
      action: string;
      productName: string;
      oldStock: number;
      newStock: number;
    }
  | {
      type: "error";
      barcode: string;
    };

/** Full-screen confirmation shown for half a second after each scan. */
export function ScanFlash({ flash }: { flash: FlashState }) {
  const t = useMessages(scannerMessages);
  const success = flash.type === "success";
  const Icon = success ? CheckCircle : XCircle;

  return (
    <div
      className={cn(
        "pointer-events-none fixed inset-0 z-50 flex items-center justify-center animate-in fade-in duration-100",
        success ? "bg-primary/25" : "bg-destructive/25",
      )}
    >
      <div
        className={cn(
          "rounded-2xl px-8 py-6 text-center",
          success ? "bg-primary text-primary-foreground" : "bg-destructive text-destructive-foreground",
        )}
      >
        <Icon className="mx-auto mb-2 size-16" />
        {success ? (
          <>
            <p className="text-heading-lg font-semibold">{flash.action}</p>
            <p className="text-body">{flash.productName}</p>
            <p className="text-body">{t("stockChange", { from: flash.oldStock, to: flash.newStock })}</p>
          </>
        ) : (
          <>
            <p className="text-heading-lg font-semibold">{t("notFound")}</p>
            <p className="text-body">{t("barcodeValue", { code: flash.barcode })}</p>
          </>
        )}
      </div>
    </div>
  );
}
