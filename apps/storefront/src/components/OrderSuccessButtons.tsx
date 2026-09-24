import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  OrderReceiptSupportRequest,
  OrderReceiptSupportRequestAction,
  OrderReceiptSupportRequestType,
} from "@/lib/api/types";
import {
  getOrderReceiptSupportActionLabel,
  getOrderReceiptSupportRequestLabel,
  getOrderReceiptSupportStatusMessage,
} from "@/lib/order-success-localization";
import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";
import { normalizeBdMobile } from "@scalius/shared/phone-input";
import type { AuthModalOpenDetail, AuthModalPrefill } from "@/components/AuthModal";
import { getCustomerSession, type CustomerInfo } from "@/lib/api/customer-auth";
import { AlertCircle, CheckCircle2, HelpCircle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type OrderSuccessButtonsProps = {
  orderId?: string;
  /** Saved to some customer account (not necessarily the viewer's). */
  accountLinked?: boolean;
  /** The order's own contact, to pre-fill sign-in / create account. */
  accountPrefill?: AuthModalPrefill;
  supportRequests?: OrderReceiptSupportRequest[];
  supportRequestActions?: OrderReceiptSupportRequestAction[];
  /** Opened by tracking or later: no "Continue shopping" and no sign-in-to-track upsell. */
  statusView?: boolean;
  copy: CheckoutLanguageData;
};

type SubmitState =
  | { status: "idle"; message: string | null }
  | { status: "submitting"; message: string | null }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

/**
 * One line per state. "hidden": saved to someone else's account, or placed
 * with contacts the signed-in account doesn't have. "refused": the store said
 * why it can't be saved.
 */
type AccountCardState = "checking" | "saved" | "save" | "saving" | "sign_in" | "refused" | "hidden";

const samePhone = (a?: string | null, b?: string | null) =>
  Boolean(a && b && (normalizeBdMobile(a) ?? a.trim()) === (normalizeBdMobile(b) ?? b.trim()));
const sameEmail = (a?: string | null, b?: string | null) =>
  Boolean(a?.trim() && a.trim().toLowerCase() === b?.trim().toLowerCase());

/** The account can hold this order only if it shares the order's phone or email. */
function accountSharesOrderContact(account: CustomerInfo, order: AuthModalPrefill | undefined): boolean {
  if (!order?.phone && !order?.email) return true;
  return samePhone(account.phone, order.phone) || sameEmail(account.email, order.email);
}

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

export default function OrderSuccessButtons({
  orderId,
  accountLinked = false,
  accountPrefill,
  supportRequests: initialSupportRequests = EMPTY_SUPPORT_REQUESTS,
  supportRequestActions: initialSupportRequestActions = EMPTY_SUPPORT_REQUEST_ACTIONS,
  statusView = false,
  copy,
}: OrderSuccessButtonsProps) {
  const [accountCard, setAccountCard] = useState<AccountCardState>("checking");
  const [accountMessage, setAccountMessage] = useState("");
  const claimAfterAuthRef = useRef(false);
  const [supportRequests, setSupportRequests] = useState(initialSupportRequests);
  const [supportRequestActions, setSupportRequestActions] = useState(initialSupportRequestActions);
  const [selectedSupportType, setSelectedSupportType] = useState<OrderReceiptSupportRequestType | null>(null);
  const [supportReason, setSupportReason] = useState("");
  const [supportSubmitState, setSupportSubmitState] = useState<SubmitState>({ status: "idle", message: null });

  const claimOrderToAccount = useCallback(async () => {
    if (!orderId) return;
    setAccountCard("saving");
    setAccountMessage("");
    try {
      const response = await fetch("/api/order-receipt/claim-account", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      const payload = await response.json().catch(() => null) as {
        success?: boolean;
        error?: string | { message?: string };
      } | null;
      if (response.ok && payload?.success !== false) {
        setAccountCard("saved");
        return;
      }
      // A refusal is final (another person's order): say why, offer nothing.
      const reason = typeof payload?.error === "string" ? payload.error : payload?.error?.message;
      if (response.status === 403 && reason) {
        setAccountCard("refused");
        setAccountMessage(reason);
        return;
      }
      throw new Error("account_claim_failed");
    } catch {
      setAccountCard("save");
      setAccountMessage(copy.orderReceiptSaveFailedText);
    }
  }, [copy.orderReceiptSaveFailedText, orderId]);

  /** A signed-in viewer sees "Saved" only for their own account's order. */
  const resolveSignedInCard = useCallback(async (): Promise<AccountCardState> => {
    if (!accountLinked) {
      const session = await getCustomerSession();
      if (!session.authenticated || !session.customer) return session.unavailable ? "save" : "sign_in";
      return accountSharesOrderContact(session.customer, accountPrefill) ? "save" : "hidden";
    }
    if (!orderId) return "hidden";
    try {
      const response = await fetch(
        `/api/customer-auth/orders/${encodeURIComponent(orderId)}`,
        { credentials: "same-origin", cache: "no-store" },
      );
      return response.ok ? "saved" : "hidden";
    } catch {
      return "hidden";
    }
  }, [accountLinked, accountPrefill, orderId]);

  useEffect(() => {
    let cancelled = false;
    const settle = (state: AccountCardState) => {
      if (!cancelled) setAccountCard(state);
    };
    if (document.cookie.includes("cs_auth=1")) void resolveSignedInCard().then(settle);
    else settle("sign_in");

    const handleCustomerLogin = () => {
      if (claimAfterAuthRef.current && !accountLinked) {
        claimAfterAuthRef.current = false;
        void claimOrderToAccount();
        return;
      }
      void resolveSignedInCard().then(settle);
    };
    window.addEventListener("customer-login", handleCustomerLogin);
    return () => {
      cancelled = true;
      window.removeEventListener("customer-login", handleCustomerLogin);
    };
  }, [accountLinked, claimOrderToAccount, resolveSignedInCard]);

  const openAuthForOrder = () => {
    claimAfterAuthRef.current = true;
    const detail: AuthModalOpenDetail = { prefill: accountPrefill ?? {}, source: "receipt" };
    window.dispatchEvent(new CustomEvent("open-auth-modal", { detail }));
  };

  useEffect(() => {
    setSupportRequests(initialSupportRequests);
  }, [initialSupportRequests]);

  useEffect(() => {
    setSupportRequestActions(initialSupportRequestActions);
  }, [initialSupportRequestActions]);

  const activeSupportRequest = useMemo(
    () => supportRequests.find((request) => request.active) ?? null,
    [supportRequests],
  );
  const latestSupportRequest = supportRequests[0] ?? null;
  const availableSupportActions = useMemo(
    () => supportRequestActions.filter((action) => action.eligible),
    [supportRequestActions],
  );
  const selectedSupportAction = selectedSupportType
    ? availableSupportActions.find((action) => action.type === selectedSupportType)
    : null;
  const handlePrintOrder = () => {
    window.print();
  };

  const handleSelectSupportAction = (action: OrderReceiptSupportRequestAction) => {
    setSelectedSupportType(action.type);
    setSupportSubmitState({ status: "idle", message: null });
  };

  const handleSubmitSupportRequest = async () => {
    const reason = supportReason.trim();
    if (!orderId || !selectedSupportType) {
      setSupportSubmitState({
        status: "error",
        message: copy.orderReceiptMissingProofText,
      });
      return;
    }

    if (reason.length < 3) {
      setSupportSubmitState({
        status: "error",
        message: copy.orderReceiptReasonRequiredText,
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
          message: null,
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
        throw new Error("support_request_failed");
      }

      setSupportRequests(payload.data.supportRequests ?? [payload.data.request]);
      setSupportRequestActions(payload.data.supportRequestActions ?? []);
      setSelectedSupportType(null);
      setSupportReason("");
      setSupportSubmitState({
        status: "success",
        message: copy.orderReceiptRequestSentText,
      });
    } catch {
      setSupportSubmitState({
        status: "error",
        message: copy.orderReceiptSupportFailedText,
      });
    }
  };

  return (
    <div className="no-print flex flex-col items-center space-y-6">
      <div className="mt-6 flex w-full max-w-md flex-col justify-center gap-2 sm:flex-row">
        {!statusView && <a
          href="/"
          data-astro-prefetch="false"
          className="inline-flex min-h-10 flex-1 items-center justify-center rounded-xl bg-black px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-gray-800"
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
          {copy.continueShoppingText}
        </a>}
        <Button
          variant="outline"
          className="flex-1 rounded-xl border-border px-6 py-3 font-medium transition-colors hover:bg-muted"
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
          {copy.orderReceiptPrintText}
        </Button>
      </div>

      {accountCard !== "checking" && accountCard !== "hidden" && !(statusView && accountCard === "sign_in") && (
        <div className="flex w-full max-w-xl flex-col gap-3 rounded-xl border border-border p-4 text-left sm:flex-row sm:items-center sm:justify-between">
          {accountCard === "saved" ? (
            <p className="text-sm text-foreground">
              {copy.orderReceiptAccountSavedText} ·{" "}
              <a
                href={`/account/orders/${encodeURIComponent(orderId ?? "")}`}
                data-astro-prefetch="false"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {copy.orderReceiptViewOrderText}
              </a>
            </p>
          ) : accountCard === "save" || accountCard === "saving" ? (
            <Button
              type="button"
              variant="outline"
              className="min-h-11 border-border font-medium"
              onClick={() => void claimOrderToAccount()}
              disabled={accountCard === "saving"}
            >
              {accountCard === "saving" ? copy.orderReceiptSavingText : copy.orderReceiptSaveToAccountText}
            </Button>
          ) : accountCard === "sign_in" ? (
            <>
              <p className="text-sm text-foreground">{copy.orderReceiptAccountSignInText}</p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11 shrink-0 border-border font-medium"
                onClick={openAuthForOrder}
              >
                {copy.orderReceiptSignInText}
              </Button>
            </>
          ) : null}
          <p aria-live="polite" className={`text-sm empty:hidden ${accountCard === "refused" ? "text-foreground" : "text-destructive"}`}>
            {accountMessage}
          </p>
        </div>
      )}

      <div className="w-full max-w-xl rounded-xl border border-border bg-background p-4 text-left">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            {activeSupportRequest ? <CheckCircle2 className="h-5 w-5" /> : <HelpCircle className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">{copy.orderReceiptHelpText}</p>
            <a
              href="/track-order"
              data-astro-prefetch="false"
              className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              {copy.trackOrderText}
            </a>
          </div>
        </div>

        {latestSupportRequest ? (
          <div className={`mt-4 rounded-lg border px-3 py-2 text-sm ${getSupportToneClass(latestSupportRequest.severity)}`}>
            <p className="font-medium">{getOrderReceiptSupportRequestLabel(latestSupportRequest, copy)}</p>
            <p className="mt-1 text-xs opacity-80">
              {getOrderReceiptSupportStatusMessage(latestSupportRequest, copy)}
            </p>
          </div>
        ) : null}

        {!activeSupportRequest && availableSupportActions.length > 0 ? (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap gap-2">
              {availableSupportActions.map((action) => (
                <button
                  key={action.type}
                  type="button"
                  className={`inline-flex min-h-11 items-center justify-center rounded-lg border px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${
                    selectedSupportType === action.type
                      ? "border-primary bg-primary/10 text-primary"
                      : action.eligible
                        ? "border-border bg-muted/20 text-foreground hover:border-primary/40"
                        : "border-border bg-muted/10 text-muted-foreground"
                  }`}
                  onClick={() => handleSelectSupportAction(action)}
                >
                  <span>{getOrderReceiptSupportActionLabel(action.type, copy)}</span>
                </button>
              ))}
            </div>

            {selectedSupportAction && (
              <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
                <div>
                  <label htmlFor="receiptSupportReason" className="text-xs font-medium text-foreground">
                    {copy.orderReceiptReasonText}
                  </label>
                  <Textarea
                    id="receiptSupportReason"
                    aria-label={copy.orderReceiptReasonAriaText}
                    maxLength={500}
                    value={supportReason}
                    onChange={(event) => setSupportReason(event.target.value)}
                    className="mt-1 min-h-20 bg-background"
                    placeholder={copy.orderReceiptReasonPlaceholderText}
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
                      {copy.orderReceiptCancelText}
                    </Button>
                    <Button
                      type="button"
                      onClick={handleSubmitSupportRequest}
                      disabled={supportSubmitState.status === "submitting"}
                    >
                      {supportSubmitState.status === "submitting" && <Loader2 className="h-4 w-4 animate-spin" />}
                       {copy.orderReceiptSendRequestText}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : !latestSupportRequest && supportRequestActions.length > 0 ? (
          <p className="mt-4 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            {copy.orderReceiptSupportUnavailableText}
          </p>
        ) : null}

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
