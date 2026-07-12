import {
  CUSTOMER_REQUEST_INTRO_MAX_LENGTH,
  getCustomerRequestIntro,
  getCustomerRequestPolicyPreview,
  type CustomerRequestPolicy,
} from "@scalius/core/modules/settings/customer-request-policy";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, CircleOff, Loader2, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { getServerFnError } from "@/lib/api-helpers";
import { updateCustomerRequestPolicySettings } from "@/lib/api-functions/settings";
import { customerRequestPolicyQueryOptions } from "@/lib/api-query-options/settings";
import { queryKeys } from "@/lib/query-keys";

const ACTION_SWITCHES: Array<{
  key: "cancellationEnabled" | "returnEnabled" | "refundEnabled";
  label: string;
  description: string;
}> = [
  {
    key: "cancellationEnabled",
    label: "Cancellation requests",
    description: "Before shipment starts.",
  },
  {
    key: "returnEnabled",
    label: "Return requests",
    description: "After an order ships.",
  },
  {
    key: "refundEnabled",
    label: "Refund requests",
    description: "For paid orders after fulfillment starts.",
  },
];

export default function CustomerRequestSettings() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery(
    customerRequestPolicyQueryOptions(),
  );
  const [policy, setPolicy] = useState<CustomerRequestPolicy | null>(null);
  const [previewState, setPreviewState] = useState("pre_shipment");

  useEffect(() => {
    if (data?.policy) setPolicy(data.policy);
  }, [data]);

  const preview = useMemo(
    () => (policy ? getCustomerRequestPolicyPreview(policy) : []),
    [policy],
  );
  const intro = policy ? getCustomerRequestIntro(policy) : "";

  const saveMutation = useMutation({
    mutationFn: (nextPolicy: CustomerRequestPolicy) => (
      updateCustomerRequestPolicySettings({ data: nextPolicy })
    ),
    onSuccess: (payload) => {
      setPolicy(payload.policy);
      queryClient.setQueryData(queryKeys.settings.customerRequests(), payload);
      toast.success("Customer request policy saved");
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Customer request policy could not be saved"));
    },
  });

  if (isLoading || !policy) {
    if (isError) {
      return (
        <Alert className="max-w-2xl border-destructive/30 bg-destructive/5">
          <AlertDescription className="flex items-center justify-between gap-4 text-sm">
            <span>Customer request settings could not be loaded.</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Available request types</CardTitle>
            <CardDescription>
              These switches control buyer buttons and API eligibility. SEO return-policy settings remain separate.
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-y px-0 pb-0">
            {ACTION_SWITCHES.map((action) => (
              <div key={action.key} className="flex items-center justify-between gap-4 px-5 py-3">
                <div className="min-w-0">
                  <Label htmlFor={action.key} className="text-sm font-medium">
                    {action.label}
                  </Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">{action.description}</p>
                </div>
                <Switch
                  id={action.key}
                  checked={policy[action.key]}
                  onCheckedChange={(checked) => setPolicy((current) => ({
                    ...current!,
                    [action.key]: checked,
                  }))}
                  aria-label={action.label}
                />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Unavailable actions</CardTitle>
            <CardDescription>Choose how much context buyers see as an order changes.</CardDescription>
          </CardHeader>
          <CardContent>
            <RadioGroup
              value={policy.visibility}
              onValueChange={(value) => setPolicy((current) => ({
                ...current!,
                visibility: value as CustomerRequestPolicy["visibility"],
              }))}
              className="grid gap-2 sm:grid-cols-2"
            >
              <Label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
                <RadioGroupItem value="eligible_only" className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium">Only available actions</span>
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">The shortest buyer view.</span>
                </span>
              </Label>
              <Label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
                <RadioGroupItem value="show_unavailable" className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium">Show actions with reasons</span>
                  <span className="mt-1 block text-xs font-normal text-muted-foreground">Explains why an action cannot be used.</span>
                </span>
              </Label>
            </RadioGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Customer introduction</CardTitle>
            <CardDescription>Optional. Leave blank to use the concise system message shown in preview.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea
              value={policy.introText ?? ""}
              onChange={(event) => setPolicy((current) => ({
                ...current!,
                introText: event.target.value || null,
              }))}
              maxLength={CUSTOMER_REQUEST_INTRO_MAX_LENGTH}
              rows={3}
              placeholder="Send a request and the store will review it…"
            />
            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>Shown above request actions on receipts and account orders.</span>
              <span>{policy.introText?.length ?? 0}/{CUSTOMER_REQUEST_INTRO_MAX_LENGTH}</span>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button
            type="button"
            onClick={() => saveMutation.mutate(policy)}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save changes
          </Button>
        </div>
      </div>

      <Card className="lg:sticky lg:top-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Buyer preview</CardTitle>
          <CardDescription>Exactly which request actions appear in common order states.</CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={previewState} onValueChange={setPreviewState}>
            <TabsList className="grid h-auto w-full grid-cols-3 p-1">
              {preview.map((state) => (
                <TabsTrigger key={state.id} value={state.id} className="px-2 py-1.5 text-xs">
                  {state.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {preview.map((state) => (
              <TabsContent key={state.id} value={state.id} className="mt-3 space-y-3">
                <div className="rounded-md border bg-muted/20 p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{state.context}</p>
                  <p className="mt-2 text-sm text-foreground">{intro}</p>
                </div>
                {state.actions.length > 0 ? (
                  <div className="space-y-2">
                    {state.actions.map((action) => (
                      <div
                        key={action.type}
                        className={`rounded-md border p-3 ${action.eligible ? "border-primary/30 bg-primary/5" : "bg-muted/20"}`}
                      >
                        <div className="flex items-center gap-2">
                          {action.eligible ? (
                            <Check className="h-3.5 w-3.5 text-primary" />
                          ) : (
                            <CircleOff className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          <p className="text-sm font-medium">{action.label}</p>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">{action.description}</p>
                        {!action.eligible && action.disabledReason && (
                          <p className="mt-1.5 text-xs text-foreground/75">{action.disabledReason}</p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                    No request actions are shown in this state.
                  </div>
                )}
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
