import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import { Plus, Trash2 } from "lucide-react";
import { PRODUCT_BUNDLE_MAX_QUANTITY, PRODUCT_BUNDLE_MIN_QUANTITY, PRODUCT_BUNDLES_MAX } from "@scalius/shared/product-bundles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { NativeSelect } from "@/components/ui/native-select";
import { NumberInput } from "@/components/ui/number-input";
import { MoneyInput } from "@/components/admin/shared/MoneyInput";
import { useCurrency } from "@/hooks/use-currency";
import { useMessages } from "~/i18n";
import { productMerchandisingMessages } from "~/i18n/product-merchandising";
import { CollapsibleCard } from "../CollapsibleCard";
import { productBundlesQueryOptions, saveProductSection } from "./section-api";
import { useProductSection } from "./product-sections";
import { useSectionDraft } from "./use-section-draft";

interface TierDraft {
  key: string;
  quantity: number | null;
  discountType: "percentage" | "fixed_price";
  discountPercentage: number | null;
  price: number | null;
  label: string;
  isActive: boolean;
}

const valid = (value: number | null): value is number => value !== null && Number.isFinite(value);

/** Quantity bundles ("2 for 10% off", "3 for ৳900"): checkout prices them exactly as shown. */
export default function BundlesCard({ productId, readOnly }: { productId: string; readOnly: boolean }) {
  const t = useMessages(productMerchandisingMessages);
  const { code, symbol, fmt } = useCurrency();
  const queryClient = useQueryClient();
  const { data } = useQuery(productBundlesQueryOptions(productId));
  const loaded = useMemo<TierDraft[] | undefined>(() => data?.items.map((item) => ({
    key: item.id,
    quantity: item.quantity,
    discountType: item.discountType,
    discountPercentage: item.discountPercentage,
    price: item.price,
    label: item.label ?? "",
    isActive: item.isActive,
  })), [data]);
  const { draft, setDraft, dirty, markSaved } = useSectionDraft(loaded);
  const tiers = useMemo(() => draft ?? [], [draft]);

  const problems = useMemo(() => {
    const lines: string[] = [];
    const seen = new Set<number>();
    tiers.forEach((tier, index) => {
      const row = index + 1;
      if (!valid(tier.quantity) || !Number.isInteger(tier.quantity)
        || tier.quantity < PRODUCT_BUNDLE_MIN_QUANTITY || tier.quantity > PRODUCT_BUNDLE_MAX_QUANTITY) {
        lines.push(t("bundleQuantityInvalid", { row }));
      } else if (seen.has(tier.quantity)) {
        lines.push(t("bundleQuantityTwice", { row }));
      } else {
        seen.add(tier.quantity);
      }
      if (tier.discountType === "percentage" && (!valid(tier.discountPercentage) || tier.discountPercentage < 0.01 || tier.discountPercentage > 99.99)) {
        lines.push(t("bundlePercentInvalid", { row }));
      }
      if (tier.discountType === "fixed_price" && (!valid(tier.price) || tier.price <= 0)) {
        lines.push(t("bundlePriceInvalid", { row }));
      }
    });
    return lines.length > 0 ? lines : null;
  }, [tiers, t]);

  useProductSection({
    label: t("bundles"),
    dirty: !readOnly && dirty,
    problems,
    save: async (revision) => {
      const sent = tiers;
      const next = await saveProductSection(productId, {
        section: "bundles",
        expectedAggregateRevision: revision,
        tiers: sent.map((tier) => {
          const label = tier.label.trim() || null;
          return tier.discountType === "percentage"
            ? { quantity: tier.quantity!, discountType: "percentage" as const, discountPercentage: tier.discountPercentage!, label, isActive: tier.isActive }
            : { quantity: tier.quantity!, discountType: "fixed_price" as const, price: tier.price!, label, isActive: tier.isActive };
        }),
      });
      markSaved(sent);
      void queryClient.invalidateQueries({ queryKey: productBundlesQueryOptions(productId).queryKey });
      return next;
    },
  });

  const update = (key: string, patch: Partial<TierDraft>) =>
    setDraft(tiers.map((tier) => (tier.key === key ? { ...tier, ...patch } : tier)));
  const add = () => {
    const largest = Math.max(1, ...tiers.map((tier) => tier.quantity ?? 1));
    setDraft([...tiers, {
      key: `new-${nanoid(8)}`,
      quantity: Math.min(PRODUCT_BUNDLE_MAX_QUANTITY, largest + 1),
      discountType: "percentage",
      discountPercentage: null,
      price: null,
      label: "",
      isActive: true,
    }]);
  };

  const summary = (tier: TierDraft) => {
    if (!valid(tier.quantity)) return null;
    if (tier.discountType === "percentage") {
      return valid(tier.discountPercentage) ? t("bundlePercentSummary", { quantity: tier.quantity, percent: tier.discountPercentage }) : null;
    }
    return valid(tier.price) ? t("bundlePriceSummary", { quantity: tier.quantity, price: fmt(tier.price) }) : null;
  };

  return (
    <CollapsibleCard
      title={t("bundles")}
      description={t("bundlesHelp")}
      defaultOpen={tiers.length > 0}
      summary={draft === undefined ? <Skeleton className="h-5 w-40" /> : tiers.length > 0 ? (
        <p className="text-body text-muted-foreground">{t("bundleCount", { count: tiers.length })}</p>
      ) : null}
    >
      {draft === undefined ? <Skeleton className="h-24 w-full" /> : (
        <div className="space-y-3">
          {tiers.length > 0 ? (
            <ul className="divide-y">
              {tiers.map((tier, index) => {
                const row = index + 1;
                const idFor = (field: string) => `bundle-${tier.key}-${field}`;
                return (
                  <li key={tier.key} className="grid gap-3 py-3 first:pt-0 sm:grid-cols-12">
                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor={idFor("quantity")}>{t("bundleQuantity")}</Label>
                      <NumberInput
                        id={idFor("quantity")}
                        integer
                        value={tier.quantity}
                        disabled={readOnly}
                        onValueChange={(quantity) => update(tier.key, { quantity })}
                      />
                    </div>
                    <div className="space-y-1 sm:col-span-3">
                      <Label htmlFor={idFor("type")}>{t("bundleDiscount")}</Label>
                      <NativeSelect
                        id={idFor("type")}
                        value={tier.discountType}
                        disabled={readOnly}
                        onValueChange={(value) => update(tier.key, { discountType: value as TierDraft["discountType"] })}
                      >
                        <option value="percentage">{t("bundlePercentOff")}</option>
                        <option value="fixed_price">{t("bundleSetPrice")}</option>
                      </NativeSelect>
                    </div>
                    <div className="space-y-1 sm:col-span-3">
                      {tier.discountType === "percentage" ? (
                        <>
                          <Label htmlFor={idFor("value")}>{t("bundlePercent")}</Label>
                          <NumberInput
                            id={idFor("value")}
                            value={tier.discountPercentage}
                            disabled={readOnly}
                            onValueChange={(discountPercentage) => update(tier.key, { discountPercentage })}
                          />
                        </>
                      ) : (
                        <>
                          <Label htmlFor={idFor("value")}>{t("bundlePrice", { symbol })}</Label>
                          <MoneyInput
                            id={idFor("value")}
                            currencyCode={code}
                            value={tier.price}
                            disabled={readOnly}
                            onValueChange={(price) => update(tier.key, { price })}
                          />
                        </>
                      )}
                    </div>
                    <div className="space-y-1 sm:col-span-4">
                      <Label htmlFor={idFor("label")}>{t("bundleLabel")}</Label>
                      <Input
                        id={idFor("label")}
                        value={tier.label}
                        maxLength={60}
                        placeholder={t("bundleLabelPlaceholder")}
                        disabled={readOnly}
                        onChange={(event) => update(tier.key, { label: event.target.value })}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3 sm:col-span-12">
                      <p className="min-w-0 text-body text-muted-foreground">{summary(tier)}</p>
                      <div className="flex shrink-0 items-center gap-3">
                        <div className="flex items-center gap-2">
                          <Switch
                            id={idFor("active")}
                            checked={tier.isActive}
                            disabled={readOnly}
                            onCheckedChange={(isActive) => update(tier.key, { isActive })}
                          />
                          <Label htmlFor={idFor("active")}>{t("bundleActive")}</Label>
                        </div>
                        {readOnly ? null : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={t("removeBundle", { row })}
                            onClick={() => setDraft(tiers.filter((item) => item.key !== tier.key))}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-body text-muted-foreground">{t("noBundles")}</p>
          )}
          {readOnly || tiers.length >= PRODUCT_BUNDLES_MAX ? null : (
            <Button type="button" variant="outline" onClick={add}>
              <Plus className="h-4 w-4" />
              {t("addBundle")}
            </Button>
          )}
        </div>
      )}
    </CollapsibleCard>
  );
}
