export type GatewayAmountLimits = {
  currency: string;
  min: number;
  max: number;
};

export function isGatewayEligibleForPaymentAmount(
  gateway: { amountLimits?: GatewayAmountLimits },
  amount: number,
  currencyCode: string,
): boolean {
  const limits = gateway.amountLimits;
  if (!limits) return true;

  const normalizedCurrency = currencyCode.trim().toUpperCase();
  const limitCurrency = limits.currency.trim().toUpperCase();
  return (
    normalizedCurrency.length > 0
    && normalizedCurrency === limitCurrency
    && Number.isFinite(amount)
    && Number.isFinite(limits.min)
    && Number.isFinite(limits.max)
    && limits.min > 0
    && limits.max >= limits.min
    && amount >= limits.min
    && amount <= limits.max
  );
}
