import { useQuery } from "@tanstack/react-query";
import { useWatch } from "react-hook-form";
import { postApiV1AdminOrdersAppFields } from "@scalius/api-client/sdk";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { DateInput } from "~/components/ui/date-input";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { NumberInput } from "~/components/ui/number-input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Textarea } from "~/components/ui/textarea";
import { useLocale, useMessages } from "~/i18n";
import { orderFormMessages } from "~/i18n/order-form";
import { apiData } from "~/lib/api";
import { useDebounce } from "~/hooks/use-debounce";
import { useOrderForm } from "./OrderFormContext";

/** No answers yet: one object, so the debounce below settles instead of re-running on every render. */
const NO_ANSWERS: Record<string, string> = {};

/**
 * New orders only: what the installed apps ask at checkout (a delivery day
 * and window), so their rules, which check a staff order as they check a
 * buyer's, can pass. The same questions the buyer's checkout draws, with the
 * choices the app offers now. Hidden when no app asks anything.
 */
export function AppQuestionsSection() {
  const { form } = useOrderForm();
  const t = useMessages(orderFormMessages);
  const locale = useLocale();
  const answers = useWatch({ control: form.control, name: "attributes" }) ?? NO_ANSWERS;
  // A later question's choices may follow an earlier answer (the windows of the day picked).
  const asked = useDebounce(answers, 250);
  const fields = useQuery({
    queryKey: ["orders", "app-fields", locale, asked],
    queryFn: async () => (await apiData(postApiV1AdminOrdersAppFields({ body: { attributes: asked, language: locale } }))).fields,
    staleTime: 30_000,
  });
  const list = fields.data ?? [];
  if (fields.isError) {
    return (
      <Card>
        <CardHeader><CardTitle>{t("appQuestions")}</CardTitle></CardHeader>
        <CardContent><p className="text-body text-muted-foreground">{t("appQuestionsFailed")}</p></CardContent>
      </Card>
    );
  }
  if (list.length === 0) return null;
  const set = (key: string, value: string) => form.setValue("attributes", { ...form.getValues("attributes"), [key]: value }, { shouldDirty: true });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("appQuestions")}</CardTitle>
        <CardDescription>{t("appQuestionsHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {list.map((field) => {
          const id = `app-question-${field.key}`;
          const value = answers[field.key] ?? "";
          const help = field.type === "file" ? t("appQuestionFile") : field.help ?? undefined;
          // The API words the choices in this language (a computed day in its format, a declared choice by its label).
          const choices = field.type === "boolean"
            ? [{ value: "true", label: t("appQuestionYes") }, { value: "false", label: t("appQuestionNo") }]
            : field.choices;
          return (
            <Field key={field.key} id={id} label={field.label} help={help} optional={!field.required}>
              {field.type === "file" ? null : choices.length > 0 ? (
                <SearchableSelect id={id} triggerClassName="w-full" clearable={!field.required} value={value} onValueChange={(next) => set(field.key, next)} options={choices} />
              ) : field.type === "date" ? (
                <DateInput id={id} value={value} onValueChange={(next) => set(field.key, next)} />
              ) : field.type === "number" ? (
                <NumberInput id={id} value={value === "" ? null : Number(value)} onValueChange={(next) => set(field.key, next === null || Number.isNaN(next) ? "" : String(next))} />
              ) : field.type === "multiline" ? (
                <Textarea id={id} value={value} maxLength={field.maxLength ?? 500} onChange={(event) => set(field.key, event.target.value)} />
              ) : (
                <Input id={id} value={value} maxLength={field.maxLength ?? 500} onChange={(event) => set(field.key, event.target.value)} />
              )}
            </Field>
          );
        })}
      </CardContent>
    </Card>
  );
}
