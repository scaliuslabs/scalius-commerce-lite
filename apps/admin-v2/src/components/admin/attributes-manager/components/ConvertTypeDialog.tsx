import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { postApiV1AdminAttributesByIdConvertType } from "@scalius/api-client/sdk";
import {
  ATTRIBUTE_UNIT_MAX_LENGTH,
  ATTRIBUTE_VALUE_TYPES,
  defaultAttributeFacetDisplay,
  type AttributeValueType,
} from "@scalius/shared/catalog-attributes";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { apiData, type ApiResult } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import { queryKeys } from "~/lib/query-keys";
import type { AttributeDto } from "~/lib/api-query-options/attributes";
import { formatNumber, useMessages } from "~/i18n";
import { attributeTypeMessages } from "~/i18n/attribute-types";

type Result = ApiResult<typeof postApiV1AdminAttributesByIdConvertType>;

/**
 * Changes an attribute's value type. "Check values" runs the server's dry run
 * (how many values, and which don't fit); only a clean check can convert.
 */
export function ConvertTypeDialog({ attribute, open, onClose, onConverted }: {
  attribute: AttributeDto;
  open: boolean;
  onClose: () => void;
  onConverted: (valueType: AttributeValueType, unit: string | null) => void;
}) {
  const t = useMessages(attributeTypeMessages);
  const queryClient = useQueryClient();
  const [valueType, setValueType] = useState<AttributeValueType>(
    ATTRIBUTE_VALUE_TYPES.find((type) => type !== attribute.valueType) ?? "text",
  );
  const [unit, setUnit] = useState(attribute.unit ?? "");
  const [preview, setPreview] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const request = (dryRun: boolean) => apiData(postApiV1AdminAttributesByIdConvertType({
    path: { id: attribute.id },
    body: {
      valueType,
      facetDisplay: defaultAttributeFacetDisplay(valueType),
      unit: valueType === "number" ? unit.trim() || null : null,
      dryRun,
    },
  }));
  const check = useMutation({
    mutationFn: () => request(true),
    onMutate: () => setError(null),
    onSuccess: setPreview,
    onError: (failure) => setError(getServerFnError(failure, t("actionFailed"))),
  });
  const convert = useMutation({
    mutationFn: () => request(false),
    onMutate: () => setError(null),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.attributes.all });
      if (result.unconvertibleCount > 0) {
        setPreview(result);
        return;
      }
      toast.success(result.skipped > 0 ? t("convertedPartly", { count: formatNumber(result.skipped) }) : t("converted"));
      onConverted(valueType, result.unit);
      onClose();
    },
    onError: (failure) => setError(getServerFnError(failure, t("actionFailed"))),
  });

  const ready = preview !== null && preview.valueType === valueType && preview.unconvertibleCount === 0;
  const busy = check.isPending || convert.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("convertTitle", { name: attribute.name })}</DialogTitle>
          <DialogDescription>{t("convertBody")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
          <div className="space-y-2">
            <Label htmlFor="convert-type">{t("newType")}</Label>
            <SearchableSelect
              id="convert-type"
              value={valueType}
              disabled={busy}
              onValueChange={(value) => {
                setValueType(value as AttributeValueType);
                setPreview(null);
              }}
              triggerClassName="w-full"
              options={ATTRIBUTE_VALUE_TYPES.map((type) => ({ value: type, label: t(`type_${type}`), disabled: type === attribute.valueType }))}
            />
            <p className="text-body text-muted-foreground">{t(`typeHelp_${valueType}`)}</p>
          </div>
          {valueType === "number" ? (
            <div className="space-y-2">
              <Label htmlFor="convert-unit">{t("unit")}</Label>
              <Input
                id="convert-unit"
                maxLength={ATTRIBUTE_UNIT_MAX_LENGTH}
                placeholder={t("unitPlaceholder")}
                value={unit}
                disabled={busy}
                onChange={(event) => {
                  setUnit(event.target.value);
                  setPreview(null);
                }}
              />
            </div>
          ) : null}
          {preview ? (
            <div className="space-y-1 rounded-lg border p-3 text-body" aria-live="polite">
              <p>{t("previewRows", { rows: formatNumber(preview.rows), distinct: formatNumber(preview.distinctValues) })}</p>
              {preview.newValues > 0 ? <p>{t("previewNewValues", { count: formatNumber(preview.newValues) })}</p> : null}
              {preview.unconvertibleCount > 0 ? (
                <>
                  <p className="text-destructive">{t("previewBlocked", { count: formatNumber(preview.unconvertibleCount) })}</p>
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {preview.unconvertibleSamples.map((sample) => <li key={sample} className="break-words">{sample}</li>)}
                  </ul>
                </>
              ) : (
                <p className="text-success">{t("previewReady")}</p>
              )}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("cancel")}</Button>
          {ready ? (
            <Button type="button" loading={convert.isPending} onClick={() => convert.mutate()}>{t("convert")}</Button>
          ) : (
            <Button type="button" loading={check.isPending} onClick={() => check.mutate()}>{t("checkValues")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
