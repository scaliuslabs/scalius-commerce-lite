// One price list (docs/MARKETS-DESIGN.md D5), Medusa's price list page with
// Shopify's layout: details and the SKU prices on the left; status, type,
// priority and schedule on the right. The page's save bar saves the details
// under the revision it loaded; the price grid opens in a sheet (loaded on
// first use) and saves the prices under the same revision.
import { lazy, Suspense, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { PRICE_LIST_DESCRIPTION_MAX_LENGTH, PRICE_LIST_NAME_MAX_LENGTH, PRICE_LIST_PRIORITY_MAX } from "@scalius/shared/market-pricing";
import { toast } from "~/lib/toast";
import { ErrorBoundary } from "~/components/admin/ErrorBoundary";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { ReadOnlyNotice } from "~/components/admin/resource/ReadOnlyNotice";
import { StatusBadge } from "~/components/admin/resource/StatusBadge";
import { SettingsField } from "~/components/admin/settings/SettingsPage";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { SaveBarProvider, SaveConflict, SaveErrorBanner, useSaveBar, useSaveScope } from "~/components/admin/shared/SaveBar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { NumberInput } from "~/components/ui/number-input";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Textarea } from "~/components/ui/textarea";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { priceListMessages } from "~/i18n/price-lists";
import { saveBarMessages } from "~/i18n/save-bar";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import {
  priceListKeys,
  priceListQueryOptions,
  savePriceList,
  useDeletePriceList,
  type PriceList,
} from "~/lib/api-query-options/price-lists";
import { PriceListPrices } from "./PriceListPrices";
import { scheduleText } from "./PriceListsList";
import { KIND_HELP, KIND_LABEL, priceListForm, priceListFormProblems, priceListUpdateBody, type PriceListForm } from "./price-list-form";

// The grid is the heaviest part of the page and only staff who edit open it.
const PriceGridSheet = lazy(() => import("./PriceGridSheet").then((module) => ({ default: module.PriceGridSheet })));

export function PriceListEditor({ priceList }: { priceList: PriceList }) {
  const t = useMessages(priceListMessages);
  return (
    <ErrorBoundary>
      <SaveBarProvider savedMessage={t("saved")}>
        <PriceListEditorPage initial={priceList} />
      </SaveBarProvider>
    </ErrorBoundary>
  );
}

const sameForm = (left: PriceListForm, right: PriceListForm) => JSON.stringify(left) === JSON.stringify(right);

function PriceListEditorPage({ initial }: { initial: PriceList }) {
  const t = useMessages(priceListMessages);
  const bar = useMessages(saveBarMessages);
  const queryClient = useQueryClient();
  const canEdit = usePermissions().hasPermission(PERMISSIONS.PRODUCTS_EDIT);
  const scope = useSaveScope();
  const revealed = Boolean(scope?.revealed);
  // The saved list (its revision is what every save sends) and the draft of its details.
  const live = useQuery({ ...priceListQueryOptions(initial.id), initialData: initial });
  const [saved, setSaved] = useState<PriceList>(initial);
  const [base, setBase] = useState(() => priceListForm(initial));
  const [draft, setDraft] = useState<PriceListForm>(base);
  const [gridOpen, setGridOpen] = useState(false);
  const [gridLoaded, setGridLoaded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const problems = priceListFormProblems(draft);
  const dirty = canEdit && !sameForm(draft, base);

  const update = (patch: Partial<PriceListForm>) => setDraft((current) => ({ ...current, ...patch }));
  // A save of the prices advances the list's revision; the details draft stays.
  const adopt = (list: PriceList) => {
    setSaved(list);
    queryClient.setQueryData(priceListKeys.detail(list.id), list);
  };

  useSaveBar({
    label: t("detailsTitle"),
    dirty,
    invalid: !canEdit || Object.keys(problems).length > 0,
    save: async () => {
      const sent = draft;
      try {
        const next = await savePriceList(saved.id, priceListUpdateBody(sent, saved.revision));
        adopt(next);
        setBase(priceListForm(next));
        void queryClient.invalidateQueries({ queryKey: priceListKeys.list() });
      } catch (error) {
        if (isAdminApiConflictError(error)) throw new SaveConflict(t("listChanged"));
        throw error;
      }
    },
    discard: () => setDraft(base),
    // After a conflict: the latest saved list becomes the base; these edits stay.
    reload: async () => {
      const current = await queryClient.fetchQuery({ ...priceListQueryOptions(saved.id), staleTime: 0 });
      setSaved(current);
      setBase(priceListForm(current));
    },
  });

  // Someone else's save shows its revision here; the next save then reports the conflict.
  const shown = live.data && live.data.revision > saved.revision ? live.data : saved;
  const field = (key: keyof typeof problems) => (problems[key] && (revealed || key === "end") ? t(problems[key]!) : undefined);
  const openGrid = () => {
    setGridLoaded(true);
    setGridOpen(true);
  };

  return (
    <div className="pb-6">
      <PageHeader
        backTo="/admin/price-lists"
        title={base.name || saved.name}
        badge={<StatusBadge status={shown.state}>{t(shown.state)}</StatusBadge>}
      />
      <div className="flex flex-col gap-4">
        <SaveErrorBanner />
        {canEdit ? null : <ReadOnlyNotice />}
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="min-w-0 space-y-4 lg:col-span-2">
            <fieldset disabled={!canEdit} className="min-w-0">
              <Card>
                <CardHeader>
                  <CardTitle>{t("detailsTitle")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <SettingsField id="price-list-name" label={t("name")} help={t("nameHelp")} error={field("name")}>
                    <Input
                      id="price-list-name"
                      value={draft.name}
                      maxLength={PRICE_LIST_NAME_MAX_LENGTH}
                      autoComplete="off"
                      onChange={(event) => update({ name: event.target.value })}
                    />
                  </SettingsField>
                  <SettingsField id="price-list-description" label={t("description")} help={t("descriptionHelp")}>
                    <Textarea
                      id="price-list-description"
                      rows={2}
                      value={draft.description}
                      maxLength={PRICE_LIST_DESCRIPTION_MAX_LENGTH}
                      onChange={(event) => update({ description: event.target.value })}
                    />
                  </SettingsField>
                </CardContent>
              </Card>
            </fieldset>
            <PriceListPrices list={shown} canEdit={canEdit} onEdit={openGrid} />
          </div>
          <fieldset disabled={!canEdit} className="min-w-0 space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>{t("status")}</CardTitle>
              </CardHeader>
              <CardContent>
                <RadioGroup aria-label={t("status")} value={draft.status} onValueChange={(status) => update({ status: status === "active" ? "active" : "draft" })}>
                  {(["active", "draft"] as const).map((status) => (
                    <label key={status} className="flex min-h-11 items-start gap-2 py-1 text-body">
                      <span className="flex h-lh items-center"><RadioGroupItem value={status} /></span>
                      <span>
                        <span className="block font-medium">{t(status)}</span>
                        <span className="block text-muted-foreground">{t(status === "active" ? "activeHelp" : "draftHelp")}</span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("type")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="text-body font-medium">{t(KIND_LABEL[saved.kind])}</p>
                <p className="text-body text-muted-foreground">{t(KIND_HELP[saved.kind])}</p>
                <p className="text-body">
                  {t("market")}:{" "}
                  <Link to="/admin/settings/markets/$marketId" params={{ marketId: saved.marketId }} className="text-foreground underline">
                    {saved.marketName}
                  </Link>
                </p>
                {saved.segmentId ? (
                  <p className="text-body">
                    {t("segment")}:{" "}
                    <Link to="/admin/customers/segments/$segmentId" params={{ segmentId: saved.segmentId }} className="text-foreground underline">
                      {saved.segmentName}
                    </Link>
                  </p>
                ) : null}
                <SettingsField id="price-list-priority" label={t("priority")} help={t("priorityHelp")} error={field("priority")}>
                  <NumberInput
                    id="price-list-priority"
                    integer
                    min={0}
                    max={PRICE_LIST_PRIORITY_MAX}
                    className="max-w-28"
                    value={draft.priority === "" ? null : Number(draft.priority)}
                    onValueChange={(priority) => update({ priority: priority === null || Number.isNaN(priority) ? "" : String(priority) })}
                  />
                </SettingsField>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("scheduleTitle")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-body text-muted-foreground">{scheduleText(saved, t)}</p>
                <ScheduleField
                  id="price-list-start"
                  label={t("starts")}
                  help={t("startsHelp")}
                  error={field("start")}
                  date={draft.startDate}
                  time={draft.startTime}
                  onChange={(startDate, startTime) => update({ startDate, startTime })}
                />
                <ScheduleField
                  id="price-list-end"
                  label={t("ends")}
                  help={t("endsHelp")}
                  error={field("end")}
                  date={draft.endDate}
                  time={draft.endTime}
                  onChange={(endDate, endTime) => update({ endDate, endTime })}
                />
              </CardContent>
            </Card>
          </fieldset>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap justify-between gap-2 border-t pt-4">
            <Button type="button" variant="destructive" onClick={() => setDeleting(true)}>{t("deleteAction")}</Button>
            <Button type="button" loading={Boolean(scope?.busy)} disabled={!scope?.dirty} onClick={() => void scope?.saveAll()}>
              {bar("save")}
            </Button>
          </div>
        ) : null}
      </div>
      {canEdit && gridLoaded ? (
        <Suspense fallback={null}>
          <PriceGridSheet open={gridOpen} onOpenChange={setGridOpen} list={saved} onSaved={adopt} />
        </Suspense>
      ) : null}
      {canEdit ? <DeletePriceList list={saved} open={deleting} onOpenChange={setDeleting} /> : null}
    </div>
  );
}

/** A date and an optional time of day, in store time; clearing the date clears both. */
function ScheduleField({ id, label, help, error, date, time, onChange }: {
  id: string;
  label: string;
  help: string;
  error: string | undefined;
  date: string;
  time: string;
  onChange: (date: string, time: string) => void;
}) {
  const t = useMessages(priceListMessages);
  return (
    <SettingsField id={id} label={label} help={help} error={error}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          type="date"
          className="w-auto min-w-0 flex-1"
          value={date}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.value, event.target.value ? time : "")}
        />
        <Input
          type="time"
          aria-label={t("timeOf", { field: label })}
          className="w-auto min-w-0 flex-1"
          value={time}
          disabled={!date}
          onChange={(event) => onChange(date, event.target.value)}
        />
        {date ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange("", "")}>{t("clearDate")}</Button>
        ) : null}
      </div>
    </SettingsField>
  );
}

function DeletePriceList({ list, open, onOpenChange }: { list: PriceList; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(priceListMessages);
  const navigate = useNavigate();
  const remove = useDeletePriceList();
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("deleteTitle", { name: list.name })}
      description={t("deleteBody")}
      confirmLabel={t("deleteAction")}
      cancelLabel={t("cancel")}
      loadingLabel={t("deleting")}
      isLoading={remove.isPending}
      onConfirm={() =>
        remove.mutate(list, {
          onSuccess: async () => {
            toast.success(t("deleted"));
            onOpenChange(false);
            await navigate({ to: "/admin/price-lists", replace: true });
          },
          onError: (error) => void toast.error(getServerFnError(error, t("deleteFailed"))),
        })}
    />
  );
}
