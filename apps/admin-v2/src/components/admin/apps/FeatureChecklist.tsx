// Choosing an app's features during setup (Shopify's setup guide picks):
// every feature by kind, recommended ones ticked in advance, then one review
// of exactly what the ticked ones may do and one approval. Each feature is
// still turned on by itself, with its own grant key, one after another (each
// answer carries the next feature's key). Only a Super Admin approves.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { ChoiceField, FieldSet } from "~/components/ui/field";
import { useMessages } from "~/i18n";
import { appFeaturesMessages } from "~/i18n/app-features";
import { type AppDetail } from "~/lib/api-query-options/apps";
import { enableAppFeature } from "~/lib/api-mutations/apps";
import { queryKeys } from "~/lib/query-keys";
import { serviceGroups } from "./app-services";
import { useAppMutationResult } from "./AppDialogs";
import { FeatureAccess, hasFeatureAccess } from "./AppFeatures";

export function FeatureChecklist({ app, canTurnOn }: { app: AppDetail; canTurnOn: boolean }) {
  const t = useMessages(appFeaturesMessages);
  const result = useAppMutationResult(app);
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState(() => new Set(app.features.filter((feature) => feature.recommended && !feature.enabled).map((feature) => feature.id)));
  const [reviewing, setReviewing] = useState(false);
  const chosen = app.features.filter((feature) => picked.has(feature.id) && !feature.enabled);
  // The review agrees to a list only when one is there.
  const asks = chosen.some(hasFeatureAccess);
  const groups = serviceGroups({ features: app.features, providers: [] });
  const turnOn = useMutation({
    mutationFn: async () => {
      let current = app;
      for (const wanted of chosen) {
        const feature = current.features.find((entry) => entry.id === wanted.id);
        if (!feature || feature.enabled) continue;
        try {
          current = (await enableAppFeature(current, feature)).app;
        } catch (error) {
          throw Object.assign(new Error(wanted.name), { cause: error });
        }
      }
      return current;
    },
    onSuccess: (next) => {
      result.applied(next, null, t("turnedOn", { count: chosen.length }));
      setPicked(new Set());
      setReviewing(false);
    },
    onError: (error: Error) => {
      // The ones turned on before the failure stay on: the page reads the app again.
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(app.id) });
      if (result.changed(error.cause)) return;
      toast.error(t("enableFailed", { name: error.message }));
    },
  });
  const toggle = (id: string, on: boolean) => setPicked((current) => {
    const next = new Set(current);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  });
  return (
    <div className="flex flex-col gap-4">
      {groups.map(({ group, items }) => (
        <FieldSet key={group} label={t(`group_${group}`)}>
          <div className="flex flex-col gap-3">
            {items.flatMap((item) => (item.kind === "feature" ? [item.feature] : [])).map((feature) => {
              const id = `setup-feature-${feature.id}`;
              return (
                <ChoiceField
                  key={feature.id}
                  id={id}
                  label={(
                    <span className="flex flex-wrap items-center gap-x-2">
                      {feature.name}
                      {feature.enabled ? <span className="font-normal text-muted-foreground">{t("alreadyOn")}</span> : feature.recommended ? <span className="font-normal text-muted-foreground">{t("recommendedNote")}</span> : null}
                    </span>
                  )}
                  help={feature.description}
                  control={(
                    <Checkbox
                      id={id}
                      checked={feature.enabled || picked.has(feature.id)}
                      disabled={feature.enabled || !canTurnOn}
                      onCheckedChange={(on) => toggle(feature.id, on === true)}
                    />
                  )}
                />
              );
            })}
          </div>
        </FieldSet>
      ))}
      {canTurnOn ? (
        <Button type="button" className="self-start" disabled={chosen.length === 0} onClick={() => setReviewing(true)}>
          {t("reviewCount", { count: chosen.length })}
        </Button>
      ) : null}
      <Dialog open={reviewing} onOpenChange={(next) => (turnOn.isPending ? undefined : setReviewing(next))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("reviewTitle", { count: chosen.length })}</DialogTitle>
            <DialogDescription>{t(asks ? "reviewIntro" : "reviewNoAccess", { app: app.name })}</DialogDescription>
          </DialogHeader>
          <div className="flex max-h-96 flex-col gap-4 overflow-y-auto">
            {chosen.map((feature) => (
              <section key={feature.id} className="flex flex-col gap-2">
                <h3 className="text-body font-medium">{feature.name}</h3>
                <FeatureAccess feature={feature} />
              </section>
            ))}
          </div>
          <p className="text-body text-muted-foreground">{t(asks ? "reviewConsent" : "reviewTurnOffLater", { app: app.name })}</p>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={turnOn.isPending} onClick={() => setReviewing(false)}>{t("cancel")}</Button>
            <Button type="button" loading={turnOn.isPending} onClick={() => turnOn.mutate()}>{t("enable")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
