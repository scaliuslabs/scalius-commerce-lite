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
}

export interface PaymentResult {
  success: boolean;
  redirectUrl?: string;
  error?: string;
  clearCartOnRedirect?: boolean;
}

export interface GatewayHandler {
  readonly id: string;
  readonly meta: GatewayMeta;
  getButtonText(isPartialPayment: boolean): string;
  /** Called when user selects this gateway. For Stripe: mount card element */
  onSelect?(container: HTMLElement): Promise<void>;
  /** Called when user clicks pay. Handles the full payment flow. */
  processPayment(ctx: PaymentContext): Promise<PaymentResult>;
}

export interface CheckoutConfig {
  gateways: Array<{ id: string; [key: string]: unknown }>;
  guestCheckoutEnabled: boolean;
  authVerificationMethod: string;
  checkoutMode: string;
  partialPaymentEnabled: boolean;
  partialPaymentAmount: number;
  allowedCountries?: string[];
  allowedCountriesMode?: "include" | "exclude";
}
