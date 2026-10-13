import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { ReadOnlyValue } from "~/components/ui/field";
import { useMessages } from "~/i18n";
import { discountsMessages } from "~/i18n/discounts";
import { storeTimeToEpoch, type DiscountDraft, type SummaryFormat } from "./discount-form";

/** The same saved rules as the editor, without mutation controls or abbreviated selections. */
export function DiscountSavedView({ draft, format, redemptionCount }: {
  draft: DiscountDraft;
  format: SummaryFormat;
  redemptionCount: number;
}) {
  const t = useMessages(discountsMessages);
  const start = storeTimeToEpoch(draft.startDate, draft.startTime);
  const end = draft.hasEnd ? storeTimeToEpoch(draft.endDate, draft.endTime) : null;
  const date = (epoch: number | null) => epoch === null ? null : format.date(epoch);
  return (
    <div className="min-w-0 space-y-4 lg:col-span-2">
      <Card>
        <CardHeader><CardTitle>{t(`type_${draft.type}`)}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <ReadOnlyValue label={t("methodLabel")} value={t(draft.method === "code" ? "methodCodeTab" : "methodAutomaticTab")} />
          <ReadOnlyValue label={t(draft.method === "code" ? "codeLabel" : "titleLabel")} value={draft.method === "code" ? draft.code : draft.title} mono={draft.method === "code"} />
          {draft.type === "products" ? <ReadOnlyValue label={t(draft.appliesTo.kind === "products" ? "specificProducts" : "specificCollections")} value={format.scope(draft.appliesTo)} /> : null}
          {draft.type === "buy_get" ? <>
            <ReadOnlyValue label={t("buysCard")} value={format.scope(draft.buyScope)} />
            <ReadOnlyValue label={t("getsCard")} value={format.scope(draft.getScope)} />
          </> : null}
          <ReadOnlyValue label={t("eligibilityCard")} value={draft.eligibility === "all" ? t("eligibilityAll") : format.segments?.(draft.customerSegmentIds)} help={draft.eligibility === "segments" ? t("eligibilitySignInHelp") : undefined} />
          <ReadOnlyValue label={t("columnUsed")} value={t("performance", { count: redemptionCount })} numeric />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>{t("datesCard")}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <ReadOnlyValue label={t("startDate")} value={date(start)} />
          <ReadOnlyValue label={t("endDate")} value={date(end)} />
        </CardContent>
      </Card>

    </div>
  );
}
