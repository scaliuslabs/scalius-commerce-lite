import type {
  CustomerAuthMethod,
  CustomerAuthPolicyConfig,
} from "@scalius/shared/customer-auth-policy";
import type { CartValidationIssue } from "../api/orders";

export interface GatewayMeta {
  label: string;
  icon: string; // SVG HTML string
  desc: string;
}

export interface PaymentContext {
  checkoutData: Record<string, unknown>;
  config: CheckoutConfig;
  orderId: string;
  totalAmount: number;
  advanceAmount: number;
  currencySymbol: string;
  paymentType?: "full" | "deposit" | "balance";
  depositAmount?: number;
  replaceExistingAttempt?: boolean;
  onOrderCreated?: (orderId: string, gateway: string) => void;
}

export interface PaymentResult {
  success: boolean;
  redirectUrl?: string;
  error?: string;
  errorCode?: string;
  status?: number;
  cartIssues?: CartValidationIssue[];
  hostedPaymentRecoveryUrl?: string;
}

export interface GatewayHandler {
  readonly id: string;
  readonly meta: GatewayMeta;
  getButtonText(isPartialPayment: boolean): string;
  /** Called when user selects this gateway. For Stripe: mount card element */
  onSelect?(container: HTMLElement): Promise<void>;
  /** Whether gateway-specific buyer input is complete enough to submit. */
  isReady?(): boolean;
  /** Called when user clicks pay. Handles the full payment flow. */
  processPayment(ctx: PaymentContext): Promise<PaymentResult>;
}

export interface CheckoutConfig {
  gateways: Array<{
    id: string;
    testMode?: boolean;
    amountLimits?: {
      currency: string;
      min: number;
      max: number;
    };
    /** @deprecated Transitional fallback for cached gateway configuration. */
    sandbox?: boolean;
    [key: string]: unknown;
  }>;
  activeDefaultMethod?: string;
  guestCheckoutEnabled: boolean;
  authVerificationMethod: CustomerAuthMethod;
  customerAuthPolicy?: CustomerAuthPolicyConfig;
  checkoutMode: string;
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number;
  allowedCountries?: string[];
  allowedCountriesMode?: "include" | "exclude";
  checkoutReadiness?: {
    ready: boolean;
    hasActiveShippingMethod: boolean;
    hasActiveDeliveryHierarchy: boolean;
    issues: string[];
  };
  unavailable?: boolean;
  unavailableMessage?: string;
}
