import type { CheckoutLanguageData } from "@scalius/shared/checkout-language";
import type { CustomerIdentitySettings } from "@scalius/shared/customer-auth-policy";
import type { Readiness } from "@scalius/shared/readiness";
import type { FulfillmentType } from "@scalius/shared/fulfilment";
import type { CartValidationIssue } from "../api/orders";
import type { CheckoutOrderRefusal } from "./tax-quote-error-contract";

export interface PaymentContext {
  checkoutData: Record<string, unknown>;
  config: CheckoutConfig;
  /** The page's checkout language (the merchant's edits included): every word a handler gives the buyer. */
  copy: CheckoutLanguageData;
  orderId: string;
  totalAmount: number;
  advanceAmount: number;
  /**
   * The reviewed quote's line types (whether the deposit plan applies to a
   * new order); absent for an existing order paid with an explicit type.
   */
  lineTypes?: ReadonlyArray<FulfillmentType | null>;
  currencySymbol: string;
  paymentType?: "full" | "deposit" | "balance";
  depositAmount?: number;
  replaceExistingAttempt?: boolean;
  onOrderCreated?: (orderId: string, gateway: string) => void;
}

export interface PaymentResult {
  success: boolean;
  redirectUrl?: string;
  /** What the buyer reads, in the page's language: never a developer's or a provider's message. */
  error?: string;
  errorCode?: string;
  details?: unknown;
  status?: number;
  cartIssues?: CartValidationIssue[];
  /** A refusal the checkout repairs itself (a store app's rule, method or delivery option). */
  refusal?: CheckoutOrderRefusal | null;
  hostedPaymentRecoveryUrl?: string;
}

/**
 * A payment method's checkout behaviour. Its name, description and button
 * text are the page's (gateway-presentation.ts and the checkout language),
 * never the handler's.
 */
export interface GatewayHandler {
  readonly id: string;
  /** Called when user selects this gateway. For Stripe: mount card element. A failure is a `CheckoutCopyError`. */
  onSelect?(container: HTMLElement, copy: CheckoutLanguageData): Promise<void>;
  /** Whether gateway-specific buyer input is complete enough to submit. */
  isReady?(): boolean;
  /** Called when user clicks pay. Handles the full payment flow. */
  processPayment(ctx: PaymentContext): Promise<PaymentResult>;
}

export interface CheckoutConfig {
  gateways: Array<{
    id: string;
    flow?: "card" | "hosted" | "cod" | "deferred";
    /** A deferred method's terms (days). */
    dueInDays?: number;
    testMode?: boolean;
    amountLimits?: {
      currency: string;
      min: number;
      max: number;
    };
    [key: string]: unknown;
  }>;
  activeDefaultMethod?: string;
  guestCheckoutEnabled: boolean;
  /** Settings → Customer accounts; `channels` are only chosen ones that can send. */
  customerIdentity?: CustomerIdentitySettings;
  checkoutMode: string;
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number;
  /** Store currency used for amounts. */
  currency: {
    code: string;
    symbol: string;
    decimalPlaces: number;
  };
  /** Settings → Checkout flow: manual COD deposit required before dispatch. */
  codDeposit?: {
    enabled: boolean;
    mode: "fixed" | "percentage";
    amount: number;
    percent: number;
    instructions: string;
  };
  /** Settings → Checkout: every order asks for a full billing address (absent: off). */
  requireFullBillingAddress?: boolean;
  allowedCountries?: string[];
  allowedCountriesMode?: "include" | "exclude";
  checkoutReadiness?: Readiness & {
    hasActiveShippingMethod: boolean;
    hasActiveDeliveryHierarchy: boolean;
  };
  unavailable?: boolean;
  unavailableMessage?: string;
}
