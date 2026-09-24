import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { postApiV1AdminPages } from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiClient, apiData } from "~/lib/api";
import { pagesQueryOptions } from "~/lib/api-query-options/pages";
import { storefrontUrlQueryOptions } from "~/lib/api-query-options/storefront-url";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { policiesMessages } from "~/i18n/settings-policies";
import { deliveryZonesQuery } from "./DeliveryZones";
import { policyTemplate, type PolicyKind } from "./policy-templates";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading, SettingsDialog, SettingsField, SettingsRow } from "./SettingsPage";
import { businessQuery } from "./StoreSettings";

const POLICY_KINDS: PolicyKind[] = ["refund", "privacy", "terms", "shipping", "contact"];
type Policies = Record<PolicyKind, string | null>;
type PoliciesPayload = Policies & { revision: number };

// Not in the generated SDK yet: the route is new (dashboard.policies.get/update).
const POLICIES_URL = "/api/v1/admin/settings/policies";
export const policiesQuery = {
  queryKey: ["settings", "policies"] as const,
  queryFn: () => apiData(apiClient.get<{ 200: { success: boolean; data: PoliciesPayload } }>({ url: POLICIES_URL })),
};
const savePolicies = (body: Partial<Policies> & { expectedRevision: number }) =>
  apiData(apiClient.put<{ 200: { success: boolean; data: PoliciesPayload } }>({ url: POLICIES_URL, body }));

type NewPage = Parameters<typeof postApiV1AdminPages>[0]["body"];

/**
 * Creates the policy page. A page (even one in trash) may already use the
 * template's address, e.g. a policy the merchant deleted earlier: the new
 * draft then takes the next free one ("shipping-policy-2").
 */
async function createPolicyPage(body: NewPage) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await apiData(postApiV1AdminPages({ body: attempt === 1 ? body : { ...body, slug: `${body.slug}-${attempt}` } }));
    } catch (error) {
      if (!(error instanceof AdminApiResponseError && error.status === 409) || attempt >= 5) throw error;
    }
  }
}

/** The store's content pages (drafts too), for linking a policy to one. */
export const storePagesQuery = pagesQueryOptions({ page: 1, limit: 100, contentType: "page", sort: "title", order: "asc" });

/**
 * Pick one of the store's own pages; never a typed address. `valueOf` picks
 * what is stored. Staff who can't view pages keep the current link, read-only.
 */
export function StorePagePicker({
  id,
  value,
  valueOf,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  valueOf: (page: { id: string; slug: string }) => string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const t = useMessages(policiesMessages);
  const canViewPages = useHasPermission(ADMIN_PERMISSIONS.PAGES_VIEW);
  const pages = useQuery({ ...storePagesQuery, enabled: canViewPages });
  if (!canViewPages) {
    return (
      <>
        <SearchableSelect
          id={id}
          value={value}
          options={[{ value, label: value ? t("linkedPage") : t("noPage") }]}
          disabled
          triggerClassName="w-full"
          onValueChange={onChange}
        />
        <p className="text-body text-muted-foreground">{t("needPagesAccess")}</p>
      </>
    );
  }
  const options = [
    { value: "", label: t("noPage") },
    ...(pages.data?.pages ?? []).map((page) => ({
      value: valueOf(page),
      label: page.isPublished ? page.title : t("draftPage", { title: page.title }),
      keywords: [page.slug],
    })),
  ];
  return (
    <SearchableSelect
      id={id}
      value={value}
      options={options}
      disabled={disabled || !pages.data}
      placeholder={t("choosePage")}
      searchPlaceholder={t("searchPages")}
      emptyMessage={t("noPages")}
      triggerClassName="w-full"
      onValueChange={onChange}
    />
  );
}

function PolicyFields({ kind, canEdit }: { kind: PolicyKind; canEdit: boolean }) {
  const t = useMessages(policiesMessages);
  const common = useMessages(settingsMessages);
  const queryClient = useQueryClient();
  const { symbol } = useCurrency();
  const canCreatePage = useHasPermission(ADMIN_PERMISSIONS.PAGES_CREATE);
  const canViewPages = useHasPermission(ADMIN_PERMISSIONS.PAGES_VIEW);
  const canViewShipping = useHasPermission(ADMIN_PERMISSIONS.SETTINGS_SHIPPING_METHODS_VIEW);
  const { values, setValue } = useSettingsForm<Policies, PoliciesPayload, number>({
    label: t(kind),
    queryKey: policiesQuery.queryKey,
    fetchFn: policiesQuery.queryFn,
    saveFn: (draft, expectedRevision) => savePolicies({ [kind]: draft[kind], expectedRevision }),
    defaultValues: { refund: null, privacy: null, terms: null, shipping: null, contact: null },
    errorMessage: common("saveFailed"),
    canEdit,
    fields: { [kind]: `policy-${kind}` },
  });
  // A draft page from the template, linked at once; the merchant stays in Settings.
  const createFromTemplate = useMutation({
    mutationFn: async () => {
      // The store's name and contact, and its shipping zones, fill the text; missing ones keep placeholders.
      const [store, storefront, zones] = await Promise.all([
        queryClient.ensureQueryData(businessQuery).catch(() => null),
        queryClient.ensureQueryData(storefrontUrlQueryOptions()).catch(() => null),
        kind === "shipping" && canViewShipping
          ? queryClient.fetchQuery({ ...deliveryZonesQuery, staleTime: 0 }).catch(() => null)
          : null,
      ]);
      const template = policyTemplate(
        kind,
        {
          companyName: store?.companyName ?? "",
          email: store?.email ?? "",
          phone: store?.phone ?? "",
          addressLine1: store?.addressLine1 ?? "",
          city: store?.city ?? "",
          storefrontUrl: (storefront as { storefrontUrl?: string } | null)?.storefrontUrl ?? "",
        },
        zones ? { zones, currencySymbol: symbol } : null,
      );
      const page = await createPolicyPage({ ...template, metaTitle: null, metaDescription: null, canonicalPath: null, isPublished: false });
      const { revision } = await queryClient.fetchQuery({ ...policiesQuery, staleTime: 0 });
      await savePolicies({ [kind]: page.id, expectedRevision: revision });
      return page.id;
    },
    onSuccess: async () => {
      toast.success(t("templateCreated"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: policiesQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pages.all }),
      ]);
    },
  });
  const linked = values[kind];
  return (
    <>
      <SettingsField id={`policy-${kind}`} label={t("page")} help={t("pageHelp")}>
        <StorePagePicker
          id={`policy-${kind}`}
          value={linked ?? ""}
          valueOf={(page) => page.id}
          disabled={!canEdit}
          onChange={(pageId) => setValue(kind, pageId || null)}
        />
      </SettingsField>
      {linked ? (
        canViewPages ? (
          <div className="space-y-1.5">
            {createFromTemplate.isSuccess ? <p role="status" className="text-body text-muted-foreground">{t("templateCreatedHelp")}</p> : null}
            {/* TODO(integration): add search={{ from: "policies" }} once F6's page-editor `from` param lands, so Back returns here. */}
            <Link to="/admin/pages/$pageId/edit" params={{ pageId: linked }} className="text-body text-link hover:underline">
              {t("editPage")}
            </Link>
          </div>
        ) : null
      ) : canEdit && canCreatePage ? (
        <div className="space-y-1.5">
          <Button type="button" variant="outline" loading={createFromTemplate.isPending} onClick={() => createFromTemplate.mutate()}>
            {t("createFromTemplate")}
          </Button>
          <p className="text-body text-muted-foreground">{t("templateHelp")}</p>
          {createFromTemplate.error ? (
            <p role="alert" className="text-body text-destructive">{createFromTemplate.error.message || t("templateFailed")}</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/** Shopify-style policies: each one is a page of the store, linked in the footer and at checkout. */
export function PoliciesCard({ canEdit }: { canEdit: boolean }) {
  const t = useMessages(policiesMessages);
  const canViewPages = useHasPermission(ADMIN_PERMISSIONS.PAGES_VIEW);
  const policies = useQuery(policiesQuery);
  const pages = useQuery({ ...storePagesQuery, enabled: canViewPages });
  if (policies.isError) return <SettingsLoadFailure title={t("policiesTitle")} onRetry={policies.refetch} />;
  if (!policies.data) return <SettingsCardLoading />;
  const summary = (kind: PolicyKind) => {
    const pageId = policies.data[kind];
    if (!pageId) return t("notSet");
    const page = pages.data?.pages.find((item) => item.id === pageId);
    if (!page) return t("linkedPage");
    return page.isPublished ? page.title : t("draftPage", { title: page.title });
  };
  return (
    <SettingsCard
      id="storePolicies"
      title={t("policiesTitle")}
      description={t("policiesDescription")}
      rows={POLICY_KINDS.map((kind) => (
        <SettingsDialog
          key={kind}
          title={t(kind)}
          trigger={<SettingsRow label={t(kind)} value={summary(kind)} disabled={!canEdit} />}
        >
          <PolicyFields kind={kind} canEdit={canEdit} />
        </SettingsDialog>
      ))}
    />
  );
}
