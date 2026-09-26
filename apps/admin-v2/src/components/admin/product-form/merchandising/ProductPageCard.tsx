import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { TemplateSelect } from "@/components/admin/catalog/TemplateSelect";
import { useMessages } from "~/i18n";
import { productMerchandisingMessages } from "~/i18n/product-merchandising";
import { productBaseSectionQueryOptions, saveProductSection } from "./section-api";
import { useProductSection } from "./product-sections";
import { useSectionDraft } from "./use-section-draft";

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

  useProductSection({
    label: t("productPage"),
    dirty: !readOnly && dirty,
    problems: null,
    prepareRebase: async () => {
      const latest = await queryClient.fetchQuery(productBaseSectionQueryOptions(productId));
      return () => prepareRebase({ pageTemplate: latest.product.pageTemplate, emiEligible: latest.product.emiEligible });
    },
    save: async (revision) => {
      if (!draft || !saved) return revision;
      const sent = draft;
      let next = revision;
      if (sent.pageTemplate !== saved.pageTemplate) {
        next = await saveProductSection(productId, { section: "template", expectedAggregateRevision: next, pageTemplate: sent.pageTemplate });
      }
      if (sent.emiEligible !== saved.emiEligible) {
        next = await saveProductSection(productId, {
          section: "base",
          expectedAggregateRevision: next,
          patch: { emiEligible: sent.emiEligible },
        });
      }
      markSaved(sent);
      void queryClient.invalidateQueries({ queryKey: productBaseSectionQueryOptions(productId).queryKey });
      return next;
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
            <div className="space-y-2">
              <Label htmlFor="product-page-template">{t("template")}</Label>
              <TemplateSelect
                id="product-page-template"
                kind="product"
                value={draft.pageTemplate}
                disabled={readOnly}
                onChange={(pageTemplate) => setDraft({ ...draft, pageTemplate })}
              />
              <p className="text-body text-muted-foreground">{t("templateHelp")}</p>
            </div>
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <Label htmlFor="product-emi">{t("emiEligible")}</Label>
                <p className="text-body text-muted-foreground">{t("emiEligibleHelp")}</p>
              </div>
              <Switch
                id="product-emi"
                checked={draft.emiEligible}
                disabled={readOnly}
                onCheckedChange={(emiEligible) => setDraft({ ...draft, emiEligible })}
              />
            </div>
          </>
        ) : (
          <Skeleton className="h-28 w-full" />
        )}
      </CardContent>
    </Card>
  );
}
