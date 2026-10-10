import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { CUSTOMER_SEGMENT_FIELDS, type CustomerSegmentField } from "@scalius/shared/customer-marketing";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Textarea } from "~/components/ui/textarea";
import { ErrorBoundary } from "~/components/admin/ErrorBoundary";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { ReadOnlyNotice } from "~/components/admin/resource/ReadOnlyNotice";
import { SettingsField } from "~/components/admin/settings/SettingsPage";
import {
  SaveBarProvider,
  SaveConflict,
  SaveErrorBanner,
  SaveNotCompleted,
  useSaveBar,
  useSaveScope,
} from "~/components/admin/shared/SaveBar";
import { usePermissions } from "~/contexts/PermissionContext";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { createCustomerSegment, updateCustomerSegment } from "~/lib/api-mutations/customers";
import { customFieldDefinitionsQueryOptions } from "~/lib/api-query-options/custom-fields";
import { customerSegmentQueryOptions, type CustomerSegment } from "~/lib/api-query-options/customers";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { customerSegmentMessages, type CustomerSegmentMessageKey } from "~/i18n/customer-segments";
import { fieldErrorMessages, saveBarMessages } from "~/i18n/save-bar";
import { DeleteSegmentDialog, useSegmentExport } from "./segment-actions";
import { SegmentConditionRow } from "./SegmentConditionRow";
import { SegmentPreview } from "./SegmentPreview";
import {
  definitionFromDraft,
  draftFromSegment,
  newCondition,
  sameSegmentDraft,
  SEGMENT_CONDITIONS_MAX,
  SEGMENT_DESCRIPTION_MAX,
  SEGMENT_NAME_MAX,
  segmentNameProblem,
  type SegmentDraft,
} from "./segment-draft";
import { Page } from "~/components/admin/resource/Page";

/**
 * A saved customer segment, or a new one: name and description, the filters
 * (Shopify-style rows: match all or any, add a filter, edit or remove each)
 * and a live preview. Saving uses the page's save bar; a save that lost to
 * someone else's offers to reload their version under these edits.
 */
export function SegmentEditor({ segment }: { segment: CustomerSegment | null }) {
  const t = useMessages(customerSegmentMessages);
  return (
    <ErrorBoundary>
      <SaveBarProvider unsavedLabel={segment ? undefined : t("unsavedSegment")} savedMessage={t("segmentSaved")}>
        <SegmentEditorPage segment={segment} />
      </SaveBarProvider>
    </ErrorBoundary>
  );
}

function SegmentEditorPage({ segment }: { segment: CustomerSegment | null }) {
  const t = useMessages(customerSegmentMessages);
  const bar = useMessages(saveBarMessages);
  const fieldError = useMessages(fieldErrorMessages);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canEdit = usePermissions().hasPermission(PERMISSIONS.CUSTOMERS_EDIT);
  const scope = useSaveScope();
  const revealed = Boolean(scope?.revealed);
  const exporter = useSegmentExport();
  const [deleting, setDeleting] = useState(false);

  // The version the draft was loaded at (its revision and content) and the draft itself.
  const [base, setBase] = useState(() => ({ revision: segment?.revision ?? 0, draft: draftFromSegment(segment) }));
  const [draft, setDraft] = useState<SegmentDraft>(base.draft);
  const { definition, problems } = useMemo(() => definitionFromDraft(draft), [draft]);
  const nameProblem = segmentNameProblem(draft.name);
  const descriptionTooLong = draft.description.trim().length > SEGMENT_DESCRIPTION_MAX;
  const dirty = canEdit && !sameSegmentDraft(draft, base.draft);
  const hasCustomField = draft.conditions.some((condition) => condition.field === "custom_field");
  const definitions = useQuery({ ...customFieldDefinitionsQueryOptions(), enabled: hasCustomField });
  const customerFields = definitions.isError
    ? []
    : definitions.data?.definitions.filter((field) => field.ownerType === "customer");

  const update = (patch: Partial<SegmentDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const latest = () => queryClient.fetchQuery({ ...customerSegmentQueryOptions(segment!.id), staleTime: 0 });

  const save = async () => {
    if (!definition || nameProblem) throw new SaveNotCompleted(t("fixFilters"));
    const sent = draft;
    const body = {
      name: sent.name.replace(/\s+/g, " ").trim(),
      description: sent.description.trim() || null,
      definition,
    };
    try {
      if (!segment) {
        const created = await createCustomerSegment(body);
        queryClient.setQueryData(customerSegmentQueryOptions(created.id).queryKey, created);
        setBase({ revision: created.revision, draft: sent });
        void queryClient.invalidateQueries({ queryKey: queryKeys.customers.segments(), exact: true });
        // Still saving, so leaving the new-segment page isn't blocked.
        void navigate({ to: "/admin/customers/segments/$segmentId", params: { segmentId: created.id }, replace: true });
        return;
      }
      const saved = await updateCustomerSegment(segment.id, base.revision, body);
      queryClient.setQueryData(customerSegmentQueryOptions(segment.id).queryKey, saved);
      setBase({ revision: saved.revision, draft: sent });
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.segments(), exact: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.segmentCount(segment.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
    } catch (error) {
      if (!isAdminApiConflictError(error)) throw error;
      // 409: someone saved first, or the name is taken. The saved revision tells which.
      if (segment) {
        const current = await latest().catch(() => null);
        if (!current || current.revision !== base.revision) throw new SaveConflict(t("segmentChanged"));
      }
      throw new SaveNotCompleted(t("nameTaken"));
    }
  };

  useSaveBar({
    label: t("segment"),
    dirty,
    invalid: !canEdit || nameProblem !== null || descriptionTooLong || definition === null,
    save,
    discard: () => setDraft(base.draft),
    // After a conflict: the latest saved version becomes the base; these edits stay.
    reload: segment
      ? async () => {
          const current = await latest();
          setBase({ revision: current.revision, draft: draftFromSegment(current) });
        }
      : undefined,
  });

  const addCondition = (field: CustomerSegmentField) =>
    update({ conditions: [...draft.conditions, newCondition(field)] });
  const full = draft.conditions.length >= SEGMENT_CONDITIONS_MAX;
  const nameError = nameProblem === "required"
    ? t("nameRequired")
    : nameProblem === "too_long" ? t("nameTooLong", { count: SEGMENT_NAME_MAX }) : undefined;

  return (
    <Page width="form" className="pb-6">
      <PageHeader
        backTo="/admin/customers/segments"
        title={segment ? base.draft.name : t("newSegment")}
        actions={segment ? (
          <>
            <Button variant="outline" asChild>
              <Link to="/admin/customers" search={{ segmentId: segment.id } as never}>{t("viewCustomers")}</Link>
            </Button>
            <Button variant="outline" loading={exporter.busy !== null} onClick={() => void exporter.run(segment.id)}>
              {t("export")}
            </Button>
          </>
        ) : undefined}
      />
      <div className="flex flex-col gap-4">
        <SaveErrorBanner />
        {canEdit ? null : <ReadOnlyNotice />}
        <fieldset disabled={!canEdit} className="min-w-0">
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="min-w-0 space-y-4 lg:col-span-2">
              <Card>
                <CardHeader>
                  <CardTitle>{t("details")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <SettingsField id="segment-name" label={t("name")} error={nameError}>
                    <Input
                      id="segment-name"
                      value={draft.name}
                      maxLength={SEGMENT_NAME_MAX + 20}
                      autoComplete="off"
                      onChange={(event) => update({ name: event.target.value })}
                    />
                  </SettingsField>
                  <SettingsField
                    id="segment-description"
                    label={t("description")}
                    help={t("descriptionHelp")}
                    error={descriptionTooLong ? fieldError("maxLength", { count: SEGMENT_DESCRIPTION_MAX }) : undefined}
                  >
                    <Textarea
                      id="segment-description"
                      rows={2}
                      value={draft.description}
                      onChange={(event) => update({ description: event.target.value })}
                    />
                  </SettingsField>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
                  <CardTitle>{t("filters")}</CardTitle>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="outline" size="sm" disabled={!canEdit || full}>
                        <Plus aria-hidden="true" />
                        {t("addFilter")}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {CUSTOMER_SEGMENT_FIELDS.map((field) => (
                        <DropdownMenuItem key={field} onSelect={() => addCondition(field)}>
                          {t(`field.${field}` as CustomerSegmentMessageKey)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </CardHeader>
                <CardContent className="space-y-4">
                  {draft.conditions.length > 1 ? (
                    <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <legend className="sr-only">{t("matchLabel")}</legend>
                      <span aria-hidden="true" className="text-body font-medium">{t("matchLabel")}</span>
                      <RadioGroup
                        value={draft.match}
                        onValueChange={(match) => update({ match: match as SegmentDraft["match"] })}
                        className="flex flex-wrap"
                      >
                        {(["all", "any"] as const).map((match) => (
                          <label key={match} className="me-2 flex min-h-11 items-center gap-2 text-body md:min-h-9">
                            <RadioGroupItem value={match} />
                            {t(match === "all" ? "matchAll" : "matchAny")}
                          </label>
                        ))}
                      </RadioGroup>
                    </fieldset>
                  ) : null}
                  {draft.conditions.length === 0 ? (
                    <p className={revealed ? "text-body text-destructive" : "text-body text-muted-foreground"}>
                      {revealed ? t("needFilter") : t("noFilters")}
                    </p>
                  ) : (
                    <ul>
                      {draft.conditions.map((condition) => (
                        <SegmentConditionRow
                          key={condition.key}
                          condition={condition}
                          problem={problems[condition.key]}
                          showProblem={revealed}
                          disabled={!canEdit}
                          customerFields={customerFields}
                          onChange={(next) => update({
                            conditions: draft.conditions.map((row) => (row.key === next.key ? next : row)),
                          })}
                          onRemove={() => update({ conditions: draft.conditions.filter((row) => row.key !== condition.key) })}
                        />
                      ))}
                    </ul>
                  )}
                  {full ? <p className="text-body text-muted-foreground">{t("filterLimit", { count: SEGMENT_CONDITIONS_MAX })}</p> : null}
                </CardContent>
              </Card>
            </div>
            <div className="min-w-0 space-y-4">
              <SegmentPreview definition={definition} />
            </div>
          </div>
        </fieldset>
        {canEdit ? (
          <div className="flex flex-wrap justify-between gap-2 border-t pt-4">
            {segment ? (
              <Button type="button" variant="destructive" onClick={() => setDeleting(true)}>{t("delete")}</Button>
            ) : <span />}
            <Button
              type="button"
              loading={Boolean(scope?.busy)}
              disabled={!scope?.dirty}
              onClick={() => void scope?.saveAll()}
            >
              {bar("save")}
            </Button>
          </div>
        ) : null}
      </div>
      <DeleteSegmentDialog
        segment={deleting && segment ? segment : null}
        onOpenChange={(open) => setDeleting(open)}
        onDeleted={() => void navigate({ to: "/admin/customers/segments", replace: true })}
      />
    </Page>
  );
}
