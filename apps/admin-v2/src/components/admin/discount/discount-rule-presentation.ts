import { formatPrice } from "@scalius/shared/currency";

interface DiscountRequirementInput {
  minPurchaseAmount: number | null;
  minQuantity: number | null;
  symbol: string;
}

export function formatDiscountRequirement({
  minPurchaseAmount,
  minQuantity,
  symbol,
}: DiscountRequirementInput): string {
  const requirements = [
    minPurchaseAmount !== null &&
    Number.isFinite(minPurchaseAmount) &&
    minPurchaseAmount > 0
      ? formatPrice(minPurchaseAmount, { symbol })
      : null,
    minQuantity !== null &&
    Number.isInteger(minQuantity) &&
    minQuantity > 0
      ? `${minQuantity} ${minQuantity === 1 ? "item" : "items"}`
      : null,
  ].filter((requirement): requirement is string => requirement !== null);

  if (requirements.length === 0) return "No minimum";
  if (requirements.length === 1) return `Minimum ${requirements[0]}`;
  return `Minimum ${requirements.join(" and ")} (both required)`;
}
