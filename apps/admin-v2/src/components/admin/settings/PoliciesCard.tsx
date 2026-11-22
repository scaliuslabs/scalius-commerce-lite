import { useCallback, useRef } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import { getApiV1AdminPages, postApiV1AdminPages } from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { standaloneLinkClassName } from "~/components/ui/link";
import { SearchableSelect, type SearchableSelectLoader } from "~/components/ui/searchable-select";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useCurrency } from "~/hooks/use-currency";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { apiClient, apiData } from "~/lib/api";
import {
  POLICIES_URL,
  businessQuery,
  deliveryZonesQuery,
  policiesQuery,
  type PoliciesPayload,
} from "~/lib/api-query-options/settings-screens";
import { storefrontUrlQueryOptions } from "~/lib/api-query-options/storefront-url";
import { pageQueryOptions } from "~/lib/api-query-options/pages";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";
import { policiesMessages } from "~/i18n/settings-policies";
import { policyTemplate, type PolicyKind } from "./policy-templates";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { SettingsCard, SettingsCardLoading, SettingsDialog, SettingsField, SettingsRow } from "./SettingsPage";
import { useCommand } from "~/lib/use-command";

const POLICY_KINDS: PolicyKind[] = ["refund", "privacy", "terms", "shipping", "contact"];
type Policies = Record<PolicyKind, string | null>;

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
      return (await apiData(postApiV1AdminPages({ body: attempt === 1 ? body : { ...body, slug: `${body.slug}-${attempt}` } }))).page;
    } catch (error) {
      if (!(error instanceof AdminApiResponseError && error.status === 409) || attempt >= 5) throw error;
    }
  }
}

const PAGE_PICKER_SIZE = 25;

/** A page as the picker and the summary name it: its title, marked when it is a draft. */
function pageLabel(page: { title: string; isPublished: boolean }, t: (key: "draftPage", vars: { title: string }) => string): string {
  return page.isPublished ? page.title : t("draftPage", { title: page.title });
}

/**
 * Pick one of the store's own pages; never a typed address. `valueOf` picks
 * what is stored. Pages are searched on the server and paged, so every page
 * can be found however many the store has; `selectedLabel` names the linked
 * one before its page of results loads. Staff who can't view pages keep the
 * current link, read-only.
 */
export function StorePagePicker({
  id,
  value,
  valueOf,
  selectedLabel,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  valueOf: (page: { id: string; slug: string }) => string;
  selectedLabel?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const t = useMessages(policiesMessages);
  const canViewPages = useHasPermission(ADMIN_PERMISSIONS.PAGES_VIEW);
  const valueOfRef = useRef(valueOf);
  valueOfRef.current = valueOf;
  const load = useCallback<SearchableSelectLoader>(async ({ search, page, signal }) => {
    const result = await apiData(getApiV1AdminPages({
      query: { page, limit: PAGE_PICKER_SIZE, contentType: "page", sort: "title", order: "asc", ...(search ? { search } : {}) },
      signal,
    }));
    return {
      options: result.pages.map((item) => ({
        value: valueOfRef.current(item),
        label: pageLabel(item, t),
        description: `/${item.slug}`,
      })),
      hasMore: page < result.pagination.totalPages,
    };
  }, [t]);
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
  return (
    <SearchableSelect
      id={id}
      value={value}
      load={load}
      queryKey={[...queryKeys.pages.all, "picker", id]}
      selectedLabel={value ? selectedLabel ?? t("linkedPage") : undefined}
      clearable
      disabled={disabled}
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
  // A page created whose link didn't save is remembered for this session (closing
  // the dialog too), so a retry links it instead of making another draft.
  const unlinkedKey = ["settings", "policies", "unlinked-template", kind] as const;
  const createFromTemplate = useCommand({
    mutationFn: async () => {
      let pageId = queryClient.getQueryData<string>(unlinkedKey);
      if (!pageId) {
        pageId = await createTemplatePage();
        queryClient.setQueryDefaults(unlinkedKey, { gcTime: Infinity });
        queryClient.setQueryData(unlinkedKey, pageId);
      }
      try {
        const { revision } = await queryClient.fetchQuery({ ...policiesQuery, staleTime: 0 });
        await savePolicies({ [kind]: pageId, expectedRevision: revision });
      } catch {
        throw new Error(t("templateLinkFailed"));
      }
      queryClient.removeQueries({ queryKey: unlinkedKey, exact: true });
      return pageId;
    },
    onSuccess: async () => {
      toast.success(t("templateCreated"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: policiesQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pages.all }),
      ]);
    },
  });
  /** Creates the draft page from the template; the store's facts fill it. */
  async function createTemplatePage(): Promise<string> {
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
    return page.id;
  }
  const linked = values[kind];
  const linkedPage = useQuery({ ...pageQueryOptions(linked ?? ""), enabled: Boolean(linked) && canViewPages });
  return (
    <>
      <SettingsField id={`policy-${kind}`} label={t("page")} help={t("pageHelp")}>
        <StorePagePicker
          id={`policy-${kind}`}
          value={linked ?? ""}
          selectedLabel={linkedPage.data ? pageLabel(linkedPage.data, t) : undefined}
          valueOf={(page) => page.id}
          disabled={!canEdit}
          onChange={(pageId) => setValue(kind, pageId || null)}
        />
      </SettingsField>
      {linked ? (
        canViewPages ? (
          <div className="space-y-1.5">
            {createFromTemplate.isSuccess ? <p role="status" className="text-body text-muted-foreground">{t("templateCreatedHelp")}</p> : null}
            <Link to="/admin/pages/$pageId/edit" params={{ pageId: linked }} search={{ from: "policies" }} className={standaloneLinkClassName}>
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
  // Each linked page by its id: a store's pages are many, and a list page would miss some.
  const linkedIds = canViewPages ? [...new Set(POLICY_KINDS.map((kind) => policies.data?.[kind]).filter((id): id is string => Boolean(id)))] : [];
  const linkedPages = useQueries({ queries: linkedIds.map((id) => pageQueryOptions(id)) });
  if (policies.isError) return <SettingsLoadFailure title={t("policiesTitle")} onRetry={policies.refetch} />;
  if (!policies.data) return <SettingsCardLoading />;
  const summary = (kind: PolicyKind) => {
    const pageId = policies.data[kind];
    if (!pageId) return t("notSet");
    const page = linkedPages[linkedIds.indexOf(pageId)]?.data;
    return page ? pageLabel(page, t) : t("linkedPage");
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
