import {
  CUSTOMER_REQUEST_INTRO_MAX_LENGTH,
  getCustomerRequestIntro,
  getCustomerRequestPolicyPreview,
  type CustomerRequestPolicy,
} from "@scalius/core/modules/settings/customer-request-policy.shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  ContextualSaveBar,
  InlineHelp,
  SettingsSection,
  SkeletonPage,
  StatusBadge,
} from "~/components/admin/shell";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Switch } from "~/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { getServerFnError } from "~/lib/api-helpers";
import { updateCustomerRequestPolicySettings } from "~/lib/api-functions/settings";
import { customerRequestPolicyQueryOptions } from "~/lib/api-query-options/settings";
import { queryKeys } from "~/lib/query-keys";

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
    description: "Approval and payment processing stay with the order.",
  },
];

function policiesEqual(
  left: CustomerRequestPolicy | null,
  right: CustomerRequestPolicy | null,
): boolean {
  return Boolean(
    left
    && right
    && left.cancellationEnabled === right.cancellationEnabled
    && left.returnEnabled === right.returnEnabled
    && left.refundEnabled === right.refundEnabled
    && left.visibility === right.visibility
    && left.introText === right.introText,
  );
}

export default function CustomerRequestSettings() {
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery(
    customerRequestPolicyQueryOptions(),
  );
  const [policy, setPolicy] = useState<CustomerRequestPolicy | null>(null);
  const [savedPolicy, setSavedPolicy] = useState<CustomerRequestPolicy | null>(null);
  const [previewState, setPreviewState] = useState("pre_shipment");

  useEffect(() => {
    if (!data?.policy) return;
    const hasUnsavedDraft = Boolean(
      policy && savedPolicy && !policiesEqual(policy, savedPolicy),
    );
    if (hasUnsavedDraft) return;
    // Refresh clean forms from the authoritative read while preserving drafts.
    setPolicy(data.policy);
    setSavedPolicy(data.policy);
  }, [data?.policy, policy, savedPolicy]);

  const dirty = Boolean(policy && savedPolicy && !policiesEqual(policy, savedPolicy));

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
      setSavedPolicy(payload.policy);
      queryClient.setQueryData(queryKeys.settings.customerRequests(), payload);
      toast.success("Customer request policy saved");
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Customer request policy could not be saved"));
    },
  });
  const canEdit = canManage && !saveMutation.isPending;

  if (isLoading || !policy) {
    if (isError) {
      return (
        <Alert className="max-w-2xl border-destructive/30 bg-destructive/5">
          <AlertDescription className="flex items-center justify-between gap-4 text-sm">
            <span>Customer request settings could not be loaded.</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    return (
      <SkeletonPage
        showHeader={false}
        sections={3}
        rowsPerSection={3}
        label="Loading customer request settings"
      />
    );
  }

  return (
    <>
      <ContextualSaveBar
        isDirty={dirty}
        saving={saveMutation.isPending}
        canSave={canManage}
        message="Unsaved customer request changes"
        saveLabel="Save policy"
        allowSamePathNavigation
        // The settings section picker is sticky on narrow widths.
        stickyClassName="sticky top-15 z-30 lg:top-0"
        onDiscard={() => savedPolicy && setPolicy(savedPolicy)}
        onSave={() => saveMutation.mutate(policy)}
      />

      <div className="max-w-5xl space-y-6">
        {!canManage && (
          <Alert>
            <AlertDescription>
              Your role can review buyer request policy, but cannot change it.
            </AlertDescription>
          </Alert>
        )}

        <SettingsSection
          title="Available request types"
          description="Chooses which requests a buyer can raise from a receipt or their account orders."
          contentClassName="p-0 sm:p-0"
        >
          <div className="divide-y">
            {ACTION_SWITCHES.map((action) => (
              <div key={action.key} className="flex items-center justify-between gap-4 px-4 py-3 sm:px-6">
                <div className="min-w-0">
                  <Label htmlFor={action.key} className="text-sm font-medium">
                    {action.label}
                  </Label>
                  <InlineHelp id={`${action.key}-help`} className="mt-0.5">
                    {action.description}
                  </InlineHelp>
                </div>
                <label htmlFor={action.key} className="flex min-h-11 min-w-11 shrink-0 items-center justify-end">
                  <Switch
                    id={action.key}
                    checked={policy[action.key]}
                    disabled={!canEdit}
                    aria-describedby={`${action.key}-help`}
                    onCheckedChange={(checked) => setPolicy((current) => ({
                      ...current!,
                      [action.key]: checked,
                    }))}
                    aria-label={action.label}
                  />
                </label>
              </div>
            ))}
          </div>
        </SettingsSection>

        <SettingsSection
          title="Unavailable actions"
          description="Decides what a buyer sees for a request they cannot raise on this order yet."
        >
          <RadioGroup
            value={policy.visibility}
            disabled={!canEdit}
            onValueChange={(value) => setPolicy((current) => ({
              ...current!,
              visibility: value as CustomerRequestPolicy["visibility"],
            }))}
            className="grid gap-2 sm:grid-cols-2"
          >
            <Label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
              <RadioGroupItem value="eligible_only" className="mt-0.5" />
              <span>
                <span className="block text-sm font-medium">Only available actions</span>
                <span className="mt-0.5 block text-xs font-normal leading-4 text-muted-foreground">
                  Hides everything the buyer cannot raise right now.
                </span>
              </span>
            </Label>
            <Label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
              <RadioGroupItem value="show_unavailable" className="mt-0.5" />
              <span>
                <span className="block text-sm font-medium">Show actions with reasons</span>
                <span className="mt-0.5 block text-xs font-normal leading-4 text-muted-foreground">
                  Lists every action and says why the unavailable ones are blocked.
                </span>
              </span>
            </Label>
          </RadioGroup>
        </SettingsSection>

        <SettingsSection
          title="Customer introduction"
          description="Appears above the request actions on receipts and account orders."
        >
          <div className="space-y-2">
            <Label htmlFor="customer-request-intro">Introduction text</Label>
            <Textarea
              id="customer-request-intro"
              value={policy.introText ?? ""}
              onChange={(event) => setPolicy((current) => ({
                ...current!,
                introText: event.target.value || null,
              }))}
              maxLength={CUSTOMER_REQUEST_INTRO_MAX_LENGTH}
              disabled={!canEdit}
              rows={3}
              aria-describedby="customer-request-intro-help"
              aria-label="Customer request introduction"
              placeholder="Send a request and the store will review it…"
            />
            <div className="flex items-center justify-between gap-3">
              <InlineHelp id="customer-request-intro-help">
                Shown above request actions on receipts and account orders.
              </InlineHelp>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {policy.introText?.length ?? 0}/{CUSTOMER_REQUEST_INTRO_MAX_LENGTH}
              </span>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Buyer preview"
          description="Shows what a buyer sees for this policy at each stage of an order."
        >
          <Tabs value={previewState} onValueChange={setPreviewState}>
            <TabsList className="grid h-auto w-full grid-cols-3 p-1">
              {preview.map((state) => (
                <TabsTrigger key={state.id} value={state.id} className="min-h-11 px-2 py-1.5 text-xs sm:min-h-9">
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
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-sm font-medium">{action.label}</p>
                          <StatusBadge
                            tone={action.eligible ? "success" : "neutral"}
                            srLabel={`${action.label}:`}
                          >
                            {action.eligible ? "Available" : "Unavailable"}
                          </StatusBadge>
                        </div>
                        <InlineHelp className="mt-1">{action.description}</InlineHelp>
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
        </SettingsSection>
      </div>
    </>
  );
}
