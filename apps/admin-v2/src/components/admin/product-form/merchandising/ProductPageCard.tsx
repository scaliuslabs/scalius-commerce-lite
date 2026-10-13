import { useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { TemplateSelect } from "@/components/admin/catalog/TemplateSelect";
import { useMessages } from "~/i18n";
import { productMerchandisingMessages } from "~/i18n/product-merchandising";
import { productBaseSectionQueryOptions } from "./section-api";
import { useProductSection } from "./product-sections";
import { useSectionDraft } from "./use-section-draft";
import { Field, ChoiceField, ReadOnlyValue } from "~/components/ui/field";

interface PageSettings {
  pageTemplate: string | null;
  emiEligible: boolean;
}

/** Side card: which product page template the product uses, and whether it shows EMI. */
export default function ProductPageCard({ productId, readOnly }: { productId: string; readOnly: boolean }) {
  const t = useMessages(productMerchandisingMessages);
  const queryClient = useQueryClient();
  const { data } = useQuery(productBaseSectionQueryOptions(productId));
  const loaded = useMemo<PageSettings | undefined>(
    () => (data ? { pageTemplate: data.product.pageTemplate, emiEligible: data.product.emiEligible } : undefined),
    [data],
  );
  const { draft, setDraft, saved, dirty, markSaved, prepareRebase } = useSectionDraft(loaded);
  const sent = useRef<PageSettings | null>(null);
  const shown = readOnly ? loaded : draft;

  useProductSection({
    label: t("productPage"),
    dirty: !readOnly && dirty,
    navigationDirty: dirty,
    problems: null,
    prepareRebase: async () => {
      const latest = await queryClient.fetchQuery(productBaseSectionQueryOptions(productId));
      return () => prepareRebase({ pageTemplate: latest.product.pageTemplate, emiEligible: latest.product.emiEligible });
    },
    changes: () => {
      if (readOnly || !draft || !saved) return {};
      sent.current = draft;
      return {
        ...(draft.pageTemplate !== saved.pageTemplate ? { pageTemplate: draft.pageTemplate } : {}),
        ...(draft.emiEligible !== saved.emiEligible ? { emiEligible: draft.emiEligible } : {}),
      };
    },
    saved: () => {
      if (sent.current) markSaved(sent.current);
      void queryClient.invalidateQueries({ queryKey: productBaseSectionQueryOptions(productId).queryKey });
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("productPage")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {shown ? (
          <>
            {readOnly ? <TemplateSelect kind="product" value={shown.pageTemplate} readOnly onChange={() => {}} /> :
            <Field id="product-page-template" label={t("template")} help={t("templateHelp")}>
              <TemplateSelect
                id="product-page-template"
                kind="product"
                value={shown.pageTemplate}
                onChange={(pageTemplate) => setDraft({ ...shown, pageTemplate })}
              />
            </Field>}
            {readOnly ? <ReadOnlyValue label={t("emiEligible")} value={t(shown.emiEligible ? "yes" : "no")} /> : <ChoiceField
              id="product-emi"
              controlAt="end"
              label={t("emiEligible")}
              help={t("emiEligibleHelp")}
              control={(
              <Switch
                id="product-emi"
                checked={shown.emiEligible}
                onCheckedChange={(emiEligible) => setDraft({ ...shown, emiEligible })}
              />
              )}
            />}
          </>
        ) : (
          <Skeleton className="h-28 w-full" />
        )}
      </CardContent>
    </Card>
  );
}
