import type { FitCondition, StorefrontFitFacts, StorefrontThemeFallback } from "@scalius/shared/storefront-theme";
import { formatNumber, useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";

type MessageKey = keyof (typeof onlineStoreMessages)["en"];

/**
 * A fit condition in plain words: what the store needs for a choice to show
 * as chosen, with the value the resolver judged it on (the store shape plus
 * the navigation the header renders).
 */
export function useFitReason(facts: StorefrontFitFacts) {
  const t = useMessages(onlineStoreMessages);
  const option = (key: string) => t(key as MessageKey);
  const reason = (condition: FitCondition): string => {
    if ("anyOf" in condition) return condition.anyOf.map(reason).join(" ");
    if ("block" in condition) return t("fitNeedsCard", { name: option(`cardStyle_${condition.variants[0]}`) });
    const what = option(`fact_${condition.fact}`);
    if ("equals" in condition) return t("fitNeeds", { what });
    const value = formatNumber(facts[condition.fact]);
    if (condition.min !== undefined && condition.max !== undefined) {
      return t("fitBetween", { what, min: formatNumber(condition.min), max: formatNumber(condition.max), value });
    }
    if (condition.max !== undefined) return t("fitAtMost", { what, max: formatNumber(condition.max), value });
    return t("fitAtLeast", { what, min: formatNumber(condition.min ?? 0), value });
  };
  return (fallback: Pick<StorefrontThemeFallback, "failed">) => fallback.failed.map(reason).join(" ");
}
