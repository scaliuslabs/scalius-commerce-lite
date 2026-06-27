import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";

type OrderSuccessButtonsProps = {
  orderId?: string;
};

export default function OrderSuccessButtons({ orderId }: OrderSuccessButtonsProps) {
  const [isAnimated, setIsAnimated] = useState(false);
  const [isCustomerAuthenticated, setIsCustomerAuthenticated] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [receiptCopyState, setReceiptCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    setIsCustomerAuthenticated(document.cookie.includes("cs_auth=1"));
    setAuthChecked(true);

    setTimeout(() => {
      setIsAnimated(true);
    }, 300);
  }, []);

  const handleContinueShopping = () => {
    window.location.href = "/";
  };

  const handlePrintOrder = () => {
    window.print();
  };

  const handleOpenAuth = () => {
    window.dispatchEvent(new CustomEvent("open-auth-modal"));
  };

  const handleOpenAccountOrder = () => {
    if (orderId) {
      window.location.href = `/account/orders/${encodeURIComponent(orderId)}`;
      return;
    }
    window.location.href = "/account";
  };

  const handleCopyReceiptLink = async () => {
    const receiptUrl = window.location.href;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(receiptUrl);
      setReceiptCopyState("copied");
    } catch {
      setReceiptCopyState("failed");
    }
  };

  return (
    <div
      className={`flex flex-col items-center space-y-6 transition-opacity duration-500 ${isAnimated ? "opacity-100" : "opacity-0"} no-print`}
    >
      <div className="flex flex-col sm:flex-row justify-center gap-4 w-full max-w-md mt-6">
        <Button
          variant="outline"
          className="border-2 border-black text-black font-medium py-3 px-6 rounded-xl hover:bg-gray-50 transition-all duration-200 flex-1"
          onClick={handleContinueShopping}
        >
          <svg
            className="w-5 h-5 mr-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
          Continue Shopping
        </Button>
        {isCustomerAuthenticated && (
          <Button
            variant="outline"
            className="border-2 border-green-600 text-green-700 font-medium py-3 px-6 rounded-xl hover:bg-green-50 transition-all duration-200 flex-1"
            onClick={handleOpenAccountOrder}
          >
            <svg
              className="w-5 h-5 mr-2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
              />
            </svg>
            Track In Account
          </Button>
        )}
        <Button
          className="bg-black text-white font-medium py-3 px-6 rounded-xl hover:bg-gray-800 transition-all duration-200 flex-1"
          onClick={handlePrintOrder}
        >
          <svg
            className="w-5 h-5 mr-2"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
            />
          </svg>
          Print Receipt
        </Button>
      </div>

      <div className="w-full max-w-xl rounded-xl border border-border bg-muted/30 p-4 text-left">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Keep this private receipt link</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Guest orders are tracked from this private receipt link. Account history only includes orders placed while signed in.
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              className="border-border font-medium"
              onClick={handleCopyReceiptLink}
            >
              Copy Link
            </Button>
            {authChecked && !isCustomerAuthenticated && (
              <Button
                type="button"
                variant="outline"
                className="border-border font-medium"
                onClick={handleOpenAuth}
              >
                Sign In For Future Orders
              </Button>
            )}
          </div>
        </div>
        <p
          className={`mt-2 min-h-5 text-sm ${
            receiptCopyState === "failed"
              ? "text-destructive"
              : receiptCopyState === "copied"
                ? "text-primary"
                : "text-muted-foreground"
          }`}
          aria-live="polite"
        >
          {receiptCopyState === "copied"
            ? "Receipt link copied."
            : receiptCopyState === "failed"
              ? "Copy failed. Use your browser address bar to save this link."
              : isCustomerAuthenticated
                ? "If this order belongs to your account, the account button opens its private timeline."
                : "Sign in before future orders to keep them in your account history."}
        </p>
      </div>
    </div>
  );
}
