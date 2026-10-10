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
import { Field, ChoiceField } from "~/components/ui/field";

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

  useProductSection({
    label: t("productPage"),
    dirty: !readOnly && dirty,
    problems: null,
    prepareRebase: async () => {
      const latest = await queryClient.fetchQuery(productBaseSectionQueryOptions(productId));
      return () => prepareRebase({ pageTemplate: latest.product.pageTemplate, emiEligible: latest.product.emiEligible });
    },
    changes: () => {
      if (!draft || !saved) return {};
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
        {draft ? (
          <>
            <Field id="product-page-template" label={t("template")} help={t("templateHelp")}>
              <TemplateSelect
                id="product-page-template"
                kind="product"
                value={draft.pageTemplate}
                disabled={readOnly}
                onChange={(pageTemplate) => setDraft({ ...draft, pageTemplate })}
              />
            </Field>
            <ChoiceField
              id="product-emi"
              controlAt="end"
              label={t("emiEligible")}
              help={t("emiEligibleHelp")}
              control={(
              <Switch
                id="product-emi"
                checked={draft.emiEligible}
                disabled={readOnly}
                onCheckedChange={(emiEligible) => setDraft({ ...draft, emiEligible })}
              />
              )}
            />
          </>
        ) : (
          <Skeleton className="h-28 w-full" />
        )}
      </CardContent>
    </Card>
  );
}
