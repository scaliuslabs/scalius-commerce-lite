import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  OrderReceiptSupportRequest,
  OrderReceiptSupportRequestAction,
  OrderReceiptSupportRequestType,
} from "@/lib/api/types";
import { AlertCircle, CheckCircle2, HelpCircle, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type OrderSuccessButtonsProps = {
  orderId?: string;
  supportRequests?: OrderReceiptSupportRequest[];
  supportRequestActions?: OrderReceiptSupportRequestAction[];
  supportRequestIntro?: string;
};

type SubmitState =
  | { status: "idle"; message: string | null }
  | { status: "submitting"; message: string | null }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

const EMPTY_SUPPORT_REQUESTS: OrderReceiptSupportRequest[] = [];
const EMPTY_SUPPORT_REQUEST_ACTIONS: OrderReceiptSupportRequestAction[] = [];

function getSupportToneClass(severity: OrderReceiptSupportRequest["severity"]) {
  switch (severity) {
    case "success":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "warning":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "danger":
      return "border-red-200 bg-red-50 text-red-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-800";
  }
}

function getApiMessage(payload: unknown, fallback: string) {
  if (typeof payload !== "object" || payload === null) return fallback;
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (
    typeof record.error === "object" &&
    record.error !== null &&
    typeof (record.error as Record<string, unknown>).message === "string"
  ) {
    return (record.error as Record<string, string>).message;
  }
  return fallback;
}

export default function OrderSuccessButtons({
  orderId,
  supportRequests: initialSupportRequests = EMPTY_SUPPORT_REQUESTS,
  supportRequestActions: initialSupportRequestActions = EMPTY_SUPPORT_REQUEST_ACTIONS,
  supportRequestIntro: initialSupportRequestIntro = "Send a request and the store will review it before changing payment, shipment, or inventory.",
}: OrderSuccessButtonsProps) {
  const [isAnimated, setIsAnimated] = useState(false);
  const [isCustomerAuthenticated, setIsCustomerAuthenticated] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [receiptCopyState, setReceiptCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [supportRequests, setSupportRequests] = useState(initialSupportRequests);
  const [supportRequestActions, setSupportRequestActions] = useState(initialSupportRequestActions);
  const [supportRequestIntro, setSupportRequestIntro] = useState(initialSupportRequestIntro);
  const [selectedSupportType, setSelectedSupportType] = useState<OrderReceiptSupportRequestType | null>(null);
  const [supportReason, setSupportReason] = useState("");
  const [supportMessage, setSupportMessage] = useState("");
  const [supportSubmitState, setSupportSubmitState] = useState<SubmitState>({ status: "idle", message: null });

  useEffect(() => {
    setIsCustomerAuthenticated(document.cookie.includes("cs_auth=1"));
    setAuthChecked(true);

    setTimeout(() => {
      setIsAnimated(true);
    }, 300);
  }, []);

  useEffect(() => {
    setSupportRequests(initialSupportRequests);
  }, [initialSupportRequests]);

  useEffect(() => {
    setSupportRequestActions(initialSupportRequestActions);
  }, [initialSupportRequestActions]);

  useEffect(() => {
    setSupportRequestIntro(initialSupportRequestIntro);
  }, [initialSupportRequestIntro]);

  const activeSupportRequest = useMemo(
    () => supportRequests.find((request) => request.active) ?? null,
    [supportRequests],
  );
  const latestSupportRequest = supportRequests[0] ?? null;
  const selectedSupportAction = selectedSupportType
    ? supportRequestActions.find((action) => action.type === selectedSupportType)
    : null;
  const firstDisabledReason = supportRequestActions.find((action) => action.disabledReason)?.disabledReason ?? null;

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

  const handleSelectSupportAction = (action: OrderReceiptSupportRequestAction) => {
    setSelectedSupportType(action.type);
    setSupportSubmitState({ status: "idle", message: null });
  };

  const handleSubmitSupportRequest = async () => {
    const reason = supportReason.trim();
    const message = supportMessage.trim();

    if (!orderId || !selectedSupportType) {
      setSupportSubmitState({
        status: "error",
        message: "This receipt is missing the browser proof needed to send a request.",
      });
      return;
    }

    if (reason.length < 3) {
      setSupportSubmitState({
        status: "error",
        message: "Add a short reason before sending the request.",
      });
      return;
    }

    setSupportSubmitState({ status: "submitting", message: null });
    try {
      const response = await fetch("/api/order-support/receipt-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId,
          type: selectedSupportType,
          reason,
          message: message || null,
        }),
      });
      const payload = await response.json().catch(() => null) as {
        success?: boolean;
        data?: {
          request?: OrderReceiptSupportRequest;
          supportRequests?: OrderReceiptSupportRequest[];
          supportRequestActions?: OrderReceiptSupportRequestAction[];
          supportRequestIntro?: string;
        };
      } | null;

      if (!response.ok || payload?.success === false || !payload?.data?.request) {
        throw new Error(getApiMessage(payload, "Support request failed. Please try again."));
      }

      setSupportRequests(payload.data.supportRequests ?? [payload.data.request]);
      setSupportRequestActions(payload.data.supportRequestActions ?? []);
      setSupportRequestIntro(payload.data.supportRequestIntro ?? initialSupportRequestIntro);
      setSelectedSupportType(null);
      setSupportReason("");
      setSupportMessage("");
      setSupportSubmitState({
        status: "success",
        message: "Request sent. The store team can now review it from the order.",
      });
    } catch (error) {
      setSupportSubmitState({
        status: "error",
        message: error instanceof Error ? error.message : "Support request failed. Please try again.",
      });
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
            <p className="text-sm font-semibold text-foreground">Keep this browser receipt</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Guest receipts stay available in this browser for a limited time. Account history only includes orders placed while signed in.
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
              ? "Copy failed. Use your browser address bar to save this clean receipt URL."
              : isCustomerAuthenticated
                ? "If this order belongs to your account, the account button opens its private timeline."
                : "This link opens only while this browser keeps its private receipt cookie."}
        </p>
      </div>

      <div className="w-full max-w-xl rounded-xl border border-border bg-background p-4 text-left shadow-sm">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            {activeSupportRequest ? <CheckCircle2 className="h-5 w-5" /> : <HelpCircle className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">Need help with this order?</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {supportRequestIntro}
            </p>
          </div>
        </div>

        {activeSupportRequest || latestSupportRequest ? (
          <div className={`mt-4 rounded-lg border px-3 py-2 text-sm ${getSupportToneClass((activeSupportRequest ?? latestSupportRequest)!.severity)}`}>
            <p className="font-medium">{(activeSupportRequest ?? latestSupportRequest)!.label}</p>
            <p className="mt-1 text-xs opacity-80">
              {(activeSupportRequest ?? latestSupportRequest)!.active
                ? "The store team will review this request before making any order changes."
                : "This request is already settled. Contact the store if you still need help."}
            </p>
          </div>
        ) : supportRequestActions.length > 0 ? (
          <div className="mt-4 space-y-3">
            <div className="grid gap-2 sm:grid-cols-3">
              {supportRequestActions.map((action) => (
                <button
                  key={action.type}
                  type="button"
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${
                    selectedSupportType === action.type
                      ? "border-primary bg-primary/10 text-primary"
                      : action.eligible
                        ? "border-border bg-muted/20 text-foreground hover:border-primary/40"
                        : "border-border bg-muted/10 text-muted-foreground"
                  }`}
                  onClick={() => handleSelectSupportAction(action)}
                  disabled={!action.eligible}
                >
                  <span className="font-medium">{action.label}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{action.description}</span>
                  {!action.eligible && action.disabledReason && (
                    <span className="mt-1.5 block text-xs text-foreground/70">{action.disabledReason}</span>
                  )}
                </button>
              ))}
            </div>

            {selectedSupportAction && (
              <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
                <div>
                  <label htmlFor="receiptSupportReason" className="text-xs font-medium text-foreground">
                    Reason
                  </label>
                  <Textarea
                    id="receiptSupportReason"
                    aria-label="Support request reason"
                    maxLength={500}
                    value={supportReason}
                    onChange={(event) => setSupportReason(event.target.value)}
                    className="mt-1 min-h-20 bg-background"
                    placeholder={`Why do you want to ${selectedSupportAction.label.toLowerCase()}?`}
                  />
                </div>
                <div>
                  <label htmlFor="receiptSupportMessage" className="text-xs font-medium text-foreground">
                    Details
                  </label>
                  <Textarea
                    id="receiptSupportMessage"
                    aria-label="Support request details"
                    maxLength={1000}
                    value={supportMessage}
                    onChange={(event) => setSupportMessage(event.target.value)}
                    className="mt-1 min-h-20 bg-background"
                    placeholder="Add any details the store should know."
                  />
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="min-h-5 text-sm text-muted-foreground" aria-live="polite">
                    {supportSubmitState.status === "error" ? (
                      <span className="inline-flex items-center gap-1 text-destructive">
                        <AlertCircle className="h-4 w-4" />
                        {supportSubmitState.message}
                      </span>
                    ) : supportSubmitState.status === "success" ? (
                      <span className="inline-flex items-center gap-1 text-primary">
                        <CheckCircle2 className="h-4 w-4" />
                        {supportSubmitState.message}
                      </span>
                    ) : null}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="border-border"
                      onClick={() => {
                        setSelectedSupportType(null);
                        setSupportSubmitState({ status: "idle", message: null });
                      }}
                      disabled={supportSubmitState.status === "submitting"}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      onClick={handleSubmitSupportRequest}
                      disabled={supportSubmitState.status === "submitting"}
                    >
                      {supportSubmitState.status === "submitting" && <Loader2 className="h-4 w-4 animate-spin" />}
                      Send Request
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="mt-4 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            {firstDisabledReason ?? "Support requests are not available for this order right now."}
          </p>
        )}

        {supportSubmitState.status === "success" && !activeSupportRequest && (
          <p className="mt-3 inline-flex items-center gap-1 text-sm text-primary" aria-live="polite">
            <CheckCircle2 className="h-4 w-4" />
            {supportSubmitState.message}
          </p>
        )}
      </div>
    </div>
  );
}
