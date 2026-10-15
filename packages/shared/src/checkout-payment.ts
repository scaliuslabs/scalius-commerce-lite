/** Amounts must use the same currency/unit; gift-card and foreign-currency flows disable deposits before calling. */
export function isDepositPaymentRequired(
  config: { partialPaymentEnabled: boolean; partialPaymentAmount: number },
  totalAmount: number,
): boolean {
  const deposit = Number(config.partialPaymentAmount);
  return config.partialPaymentEnabled && Number.isFinite(deposit) && deposit > 0 && deposit < totalAmount;
}
