// Draws an app's declarative UI document (packages/shared/src/plugins/ui.ts)
// with the dashboard's own components. No app code runs here and nothing an
// app sends is ever HTML: every string becomes a React text node. Links go
// only to this app's pages, Scalius resource pages or https sites (a new
// tab); buttons and forms call only routes the app declared.
//
// One tree can sit in three places: an app page (the root `page` draws the
// page header), a resource card or home widget, or an action's answer in a
// dialog. Inside a card, the app's own `card` nodes become sections, so a
// card is never drawn inside a card.
import { createContext, useContext, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, ExternalLink, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import {
  pluginUiRouteActions,
  type PluginUiButton,
  type PluginUiCell,
  type PluginUiDocument,
  type PluginUiInput,
  type PluginUiJson,
  type PluginUiNode,
  type PluginUiRouteAction,
  type PluginUiTarget,
  type PluginUiTone,
} from "@scalius/shared/plugins/ui";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { PageHeader } from "~/components/admin/resource/PageHeader";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { DateInput } from "~/components/ui/date-input";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Field } from "~/components/ui/field";
import { NumberInput } from "~/components/ui/number-input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Separator } from "~/components/ui/separator";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/ui/table";
import { Textarea } from "~/components/ui/textarea";
import { useCurrency } from "~/hooks/use-currency";
import { formatDateTime, formatNumber, useMessages } from "~/i18n";
import { appUiMessages } from "~/i18n/app-ui";
import { appErrorMessage, hasActionEffect, openTarget, runAppRoute, showActionToast } from "./run-action";
import { targetLocation, useCanUseApps, type AppSurfaces } from "./surfaces";
import { checkInput, initialInputValue, inputValueToJson, type InputProblem, type InputValue } from "./ui-form";

/** What the surface around a tree offers it. */
export interface PluginUiHost {
  app: AppSurfaces;
  /** A resource card's record: every action inside it also sends `{ resource, ids: [id] }`. */
  resource?: { target: string; id: string } | null;
  /** Requests the surface again (an action's `refresh`). */
  refresh?: () => void;
  /** Shows another tree in place of this one (an action's `ui`). */
  replace?: (document: PluginUiDocument) => void;
  /** Table pagination through the surface; `back` returns to the page before (null on the first). */
  paginate?: { go: (cursor: string) => void; back: (() => void) | null } | null;
}

const HostContext = createContext<PluginUiHost | null>(null);
/** True inside a card (a resource card, a widget, or the app's own card node). */
const InCardContext = createContext(false);

function useHost(): PluginUiHost {
  const host = useContext(HostContext);
  if (!host) throw new Error("PluginUiRenderer host is missing.");
  return host;
}

const BADGE_VARIANT: Record<PluginUiTone, BadgeVariant> = {
  neutral: "secondary",
  info: "info",
  success: "success",
  warning: "warning",
  critical: "destructive",
};

const BANNER: Record<PluginUiTone, { variant: "default" | "info" | "success" | "warning" | "destructive"; icon: LucideIcon }> = {
  neutral: { variant: "default", icon: Info },
  info: { variant: "info", icon: Info },
  success: { variant: "success", icon: CircleCheck },
  warning: { variant: "warning", icon: TriangleAlert },
  critical: { variant: "destructive", icon: CircleAlert },
};

const TEXT_TONE: Record<PluginUiTone, string> = {
  neutral: "text-muted-foreground",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  critical: "text-critical",
};

const BUTTON_VARIANT = { primary: "default", secondary: "outline", critical: "destructive" } as const;

const STACK_GAP = { sm: "space-y-2", md: "space-y-4", lg: "space-y-6" } as const;
const ROW_GAP = { sm: "gap-2", md: "gap-3", lg: "gap-6" } as const;
const COLUMNS = {
  1: "grid gap-4",
  2: "grid gap-4 @md:grid-cols-2",
  3: "grid gap-4 @md:grid-cols-2 @3xl:grid-cols-3",
  4: "grid gap-4 @md:grid-cols-2 @3xl:grid-cols-4",
} as const;

// ── Formatting ────────────────────────────────────────────────────────────

/** An ISO date (`2026-10-02`, shown as that calendar day) or date-time (shown in store time). */
export function formatAppDate(value: string): string {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return value;
  return dateOnly
    ? formatDateTime(date, { dateStyle: "medium", timeZone: "UTC" })
    : formatDateTime(date, { dateStyle: "medium", timeStyle: "short" });
}

/** Integer minor units in the store currency (or the cell's own currency). */
function useMinorMoney() {
  const { fmt, code } = useCurrency();
  return (minor: number, currency?: string): string => {
    const shown = currency ?? code;
    const digits = getDecimalPlaces(shown);
    const major = minor / 10 ** digits;
    if (shown === code) return fmt(major);
    return `${shown} ${formatNumber(major, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  };
}

function usePlainValue() {
  const t = useMessages(appUiMessages);
  return (value: string | number | boolean | null): string => {
    if (value === null) return "—";
    if (typeof value === "boolean") return t(value ? "yes" : "no");
    if (typeof value === "number") return formatNumber(value);
    return value;
  };
}

// ── Links and actions ─────────────────────────────────────────────────────

function PluginLink({ to, className, children }: { to: PluginUiTarget; className?: string; children: ReactNode }) {
  const host = useHost();
  const t = useMessages(appUiMessages);
  const location = targetLocation(host.app, to);
  if (!location) return <span className={className}>{children}</span>;
  if (location.kind === "external") {
    return (
      <a href={location.href} target="_blank" rel="noopener noreferrer" className={className}>
        {children}
        <ExternalLink aria-hidden="true" className="ms-1 inline size-3.5" />
        <span className="sr-only"> {t("opensInNewTab")}</span>
      </a>
    );
  }
  return (
    <Link to={location.to} search={location.search} className={className}>
      {children}
    </Link>
  );
}

type SendOutcome = { error?: string; errors?: Record<string, string> };

/** Sends one route action from this tree and applies the answer (toast, refresh, navigate, replacement tree). */
function useSendAction() {
  const host = useHost();
  const t = useMessages(appUiMessages);
  const navigate = useNavigate();
  return async (action: PluginUiRouteAction, values?: Record<string, PluginUiJson>): Promise<SendOutcome> => {
    // The dashboard's own keys win over anything the app put in `body`.
    const body: Record<string, unknown> = { ...(action.body ?? {}) };
    if (values) body.values = values;
    if (host.resource) {
      body.resource = host.resource.target;
      body.ids = [host.resource.id];
    }
    let outcome;
    try {
      outcome = await runAppRoute(host.app, action, body);
    } catch (error) {
      return { error: appErrorMessage(error) };
    }
    const { ok, result } = outcome;
    if (!ok && !hasActionEffect(result)) return { error: t("actionFailed") };
    showActionToast(result, ok);
    if (ok && !hasActionEffect(result)) toast.success(t("actionSent"));
    if (result.ui) host.replace?.(result.ui as PluginUiDocument);
    else if (result.refresh) host.refresh?.();
    if (result.navigate) openTarget(navigate as (options: { to: string; search?: Record<string, string> }) => unknown, host.app, result.navigate);
    return result.errors ? { errors: result.errors } : {};
  };
}

function ActionButton({ node, size }: { node: PluginUiButton & { action: PluginUiRouteAction }; size?: "sm" }) {
  const t = useMessages(appUiMessages);
  const canUse = useCanUseApps();
  const send = useSendAction();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    setPending(true);
    try {
      const outcome = await send(node.action);
      const message = outcome.error ?? (outcome.errors ? Object.values(outcome.errors).join(" ") : null);
      if (message) setError(message);
    } finally {
      setPending(false);
    }
  };
  return (
    <span className="inline-flex max-w-full flex-col items-start gap-1">
      <Button
        type="button"
        variant={BUTTON_VARIANT[node.tone ?? "secondary"]}
        size={size}
        disabled={node.disabled || !canUse}
        loading={pending}
        onClick={() => (node.confirm ? setConfirming(true) : void run())}
      >
        {node.label}
      </Button>
      {error ? <span role="alert" className="text-body text-destructive">{error}</span> : null}
      <ConfirmDialog
        open={confirming && Boolean(node.confirm)}
        onOpenChange={setConfirming}
        title={node.confirm?.title ?? node.label}
        description={node.confirm?.text ?? ""}
        confirmLabel={node.confirm?.confirmLabel ?? node.label}
        cancelLabel={t("cancel")}
        variant={node.confirm?.destructive ? "destructive" : "default"}
        onConfirm={() => void run()}
      />
    </span>
  );
}

function PluginButton({ node, size }: { node: PluginUiButton; size?: "sm" }) {
  const variant = BUTTON_VARIANT[node.tone ?? "secondary"];
  if (node.action) return <ActionButton node={{ ...node, action: node.action }} size={size} />;
  if (!node.to || node.disabled) {
    return <Button type="button" variant={variant} size={size} disabled>{node.label}</Button>;
  }
  return (
    <Button variant={variant} size={size} asChild>
      <PluginLink to={node.to}>{node.label}</PluginLink>
    </Button>
  );
}

function ButtonRow({ buttons, size }: { buttons?: PluginUiButton[]; size?: "sm" }) {
  if (!buttons?.length) return null;
  return (
    <div className="flex flex-wrap items-start gap-2">
      {buttons.map((button, index) => <PluginButton key={index} node={button} size={size} />)}
    </div>
  );
}

// ── Forms ─────────────────────────────────────────────────────────────────

interface FormState {
  values: Record<string, InputValue>;
  setValue: (name: string, value: InputValue) => void;
  errorOf: (name: string) => string | null;
  idOf: (name: string) => string;
  disabled: boolean;
  submit: () => void;
}

const FormContext = createContext<FormState | null>(null);

/** The form's inputs, wherever they sit in its layout. */
function collectInputs(nodes: readonly PluginUiNode[]): PluginUiInput[] {
  const found: PluginUiInput[] = [];
  const visit = (node: PluginUiNode) => {
    switch (node.type) {
      case "text-field":
      case "textarea":
      case "number-field":
      case "select":
      case "checkbox":
      case "date-field":
        found.push(node);
        return;
      case "section":
      case "card":
      case "stack":
      case "columns":
        node.children.forEach(visit);
        return;
      default:
        return;
    }
  };
  nodes.forEach(visit);
  return found;
}

function useProblemText() {
  const t = useMessages(appUiMessages);
  return (problem: InputProblem): string => {
    const vars = problem.vars
      ? Object.fromEntries(Object.entries(problem.vars).map(([key, value]) => [key, problem.dates ? formatAppDate(String(value)) : value]))
      : undefined;
    return t(problem.key, vars);
  };
}

function FormNode({ node }: { node: Extract<PluginUiNode, { type: "form" }> }) {
  const t = useMessages(appUiMessages);
  const canUse = useCanUseApps();
  const send = useSendAction();
  const problemText = useProblemText();
  const formId = useId();
  const inputs = useMemo(() => collectInputs(node.children), [node.children]);
  const [values, setValues] = useState<Record<string, InputValue>>(() =>
    Object.fromEntries(inputs.map((input) => [input.name, initialInputValue(input)])));
  // The app's own messages (on the tree, or from the last answer) stay until the field is edited.
  const [appErrors, setAppErrors] = useState<Record<string, string>>(() =>
    Object.fromEntries(inputs.flatMap((input) => (input.error ? [[input.name, input.error]] : []))));
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const problems = useMemo(
    () => Object.fromEntries(inputs.flatMap((input) => {
      const problem = checkInput(input, values[input.name] ?? null);
      return problem ? [[input.name, problem]] : [];
    })) as Record<string, InputProblem>,
    [inputs, values],
  );
  const idOf = (name: string) => `${formId}-${name}`;
  const focus = (name: string) => document.getElementById(idOf(name))?.focus();

  const deliver = async () => {
    setPending(true);
    setFormError(null);
    try {
      const payload = Object.fromEntries(inputs.map((input) => [input.name, inputValueToJson(input, values[input.name] ?? null)]));
      const outcome = await send(node.action, payload);
      if (outcome.error) setFormError(outcome.error);
      if (outcome.errors) {
        const names = new Set(inputs.map((input) => input.name));
        const onFields = Object.fromEntries(Object.entries(outcome.errors).filter(([name]) => names.has(name)));
        const elsewhere = Object.entries(outcome.errors).filter(([name]) => !names.has(name)).map(([, message]) => message);
        setAppErrors(onFields);
        if (elsewhere.length > 0) setFormError(elsewhere.join(" "));
        const first = inputs.find((input) => input.name in onFields);
        if (first) focus(first.name);
      }
    } finally {
      setPending(false);
    }
  };

  const submit = () => {
    if (pending || !canUse) return;
    setSubmitted(true);
    const first = inputs.find((input) => problems[input.name]);
    if (first) {
      focus(first.name);
      return;
    }
    if (node.confirm) setConfirming(true);
    else void deliver();
  };

  const state: FormState = {
    values,
    setValue: (name, value) => {
      setValues((current) => ({ ...current, [name]: value }));
      setAppErrors((current) => {
        if (!(name in current)) return current;
        const next = { ...current };
        delete next[name];
        return next;
      });
    },
    errorOf: (name) => appErrors[name] ?? (submitted && problems[name] ? problemText(problems[name]) : null),
    idOf,
    disabled: pending || !canUse,
    submit,
  };
  const invalid = submitted && Object.keys(problems).length > 0;

  return (
    <FormContext.Provider value={state}>
      <div role="form" aria-label={node.submitLabel} className="space-y-4">
        {node.children.map((child, index) => <Node key={index} node={child} />)}
        <div aria-live="polite">
          {invalid ? <p className="text-body text-destructive">{t("fixFields")}</p> : null}
          {formError ? <p role="alert" className="text-body text-destructive">{formError}</p> : null}
        </div>
        <Button type="button" onClick={submit} loading={pending} disabled={!canUse}>
          {node.submitLabel}
        </Button>
      </div>
      <ConfirmDialog
        open={confirming && Boolean(node.confirm)}
        onOpenChange={setConfirming}
        title={node.confirm?.title ?? node.submitLabel}
        description={node.confirm?.text ?? ""}
        confirmLabel={node.confirm?.confirmLabel ?? node.submitLabel}
        cancelLabel={t("cancel")}
        variant={node.confirm?.destructive ? "destructive" : "default"}
        onConfirm={() => void deliver()}
      />
    </FormContext.Provider>
  );
}

function InputNode({ node }: { node: PluginUiInput }) {
  const form = useContext(FormContext);
  const t = useMessages(appUiMessages);
  if (!form) return null;
  const id = form.idOf(node.name);
  const noteId = `${id}-note`;
  const error = form.errorOf(node.name);
  const describedBy = error || node.help ? noteId : undefined;
  const disabled = form.disabled || node.disabled === true;
  const value = form.values[node.name] ?? null;
  const set = (next: InputValue) => form.setValue(node.name, next);
  const field = {
    id,
    disabled,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy,
    "aria-required": node.required ? true : undefined,
  } as const;
  // Enter in a one-line field sends this form, never the page's own form around it.
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    form.submit();
  };
  const note = error ? (
    <p id={noteId} className="text-body text-destructive">{error}</p>
  ) : node.help ? (
    <p id={noteId} className="text-body text-muted-foreground">{node.help}</p>
  ) : null;

  if (node.type === "checkbox") {
    return (
      <div className="space-y-1">
        <div className="flex min-h-11 items-center gap-3 sm:min-h-8">
          <Checkbox {...field} checked={value === true} onCheckedChange={(checked) => set(checked === true)} />
          <Label htmlFor={id}>{node.label}</Label>
        </div>
        {note}
      </div>
    );
  }

  let control: ReactNode;
  switch (node.type) {
    case "text-field":
      control = (
        <Input
          {...field}
          type={node.format && node.format !== "text" ? node.format : "text"}
          value={typeof value === "string" ? value : ""}
          placeholder={node.placeholder}
          maxLength={node.maxLength}
          autoComplete="off"
          onKeyDown={onEnter}
          onChange={(event) => set(event.target.value)}
        />
      );
      break;
    case "textarea":
      control = (
        <Textarea
          {...field}
          rows={node.rows ?? 3}
          value={typeof value === "string" ? value : ""}
          placeholder={node.placeholder}
          maxLength={node.maxLength}
          onChange={(event) => set(event.target.value)}
        />
      );
      break;
    case "number-field":
      control = (
        <NumberInput
          {...field}
          integer={node.integer}
          value={typeof value === "number" ? value : null}
          onKeyDown={onEnter}
          onValueChange={(next) => set(next)}
        />
      );
      break;
    case "select":
      control = (
        <SearchableSelect
          id={id}
          triggerClassName="w-full"
          disabled={disabled}
          required={node.required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          clearable={!node.required}
          placeholder={node.placeholder ?? t("choose")}
          value={typeof value === "string" ? value : ""}
          options={node.options.map((option) => ({ value: option.value, label: option.label }))}
          onValueChange={(next) => set(next === "" ? null : next)}
        />
      );
      break;
    case "date-field":
      control = (
        <DateInput
          id={field.id}
          disabled={field.disabled}
          aria-invalid={field["aria-invalid"]}
          aria-describedby={field["aria-describedby"]}
          min={node.min}
          max={node.max}
          value={typeof value === "string" ? value : ""}
          onValueChange={(next) => set(next === "" ? null : next)}
        />
      );
      break;
  }
  return (
    <Field id={id} label={node.label} optional={!node.required} help={node.help} error={error} noteId={noteId}>
      {control}
    </Field>
  );
}

// ── Content ───────────────────────────────────────────────────────────────

function Children({ nodes, className = "space-y-4" }: { nodes: readonly PluginUiNode[]; className?: string }) {
  return <div className={className}>{nodes.map((child, index) => <Node key={index} node={child} />)}</div>;
}

function Heading({ text, level }: { text: string; level: 2 | 3 | 4 }) {
  if (level === 2) return <h2 className="text-heading-md">{text}</h2>;
  if (level === 3) return <h3 className="text-heading-sm">{text}</h3>;
  return <h4 className="text-body font-medium">{text}</h4>;
}

function TitleBlock({ title, description, inCard }: { title?: string; description?: string; inCard: boolean }) {
  if (!title && !description) return null;
  return (
    <div className="min-w-0 space-y-1">
      {title ? <Heading text={title} level={inCard ? 3 : 2} /> : null}
      {description ? <p className="whitespace-pre-wrap break-words text-body text-muted-foreground">{description}</p> : null}
    </div>
  );
}

function SectionNode({ node }: { node: Extract<PluginUiNode, { type: "section" }> }) {
  const inCard = useContext(InCardContext);
  return (
    <section className="space-y-3">
      <TitleBlock title={node.title} description={node.description} inCard={inCard} />
      <Children nodes={node.children} />
    </section>
  );
}

function CardNode({ node }: { node: Extract<PluginUiNode, { type: "card" }> }) {
  const inCard = useContext(InCardContext);
  const hasHeader = Boolean(node.title || node.description || node.actions?.length);
  if (inCard) {
    // Never a card inside a card: the app's card becomes a section of this one.
    return (
      <section className="space-y-3 border-t pt-4 first:border-t-0 first:pt-0">
        {hasHeader ? (
          <div className="flex flex-wrap items-start justify-between gap-2">
            <TitleBlock title={node.title} description={node.description} inCard />
            <ButtonRow buttons={node.actions} size="sm" />
          </div>
        ) : null}
        <Children nodes={node.children} />
      </section>
    );
  }
  return (
    <Card>
      {hasHeader ? (
        <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            {node.title ? <CardTitle>{node.title}</CardTitle> : null}
            {node.description ? <CardDescription>{node.description}</CardDescription> : null}
          </div>
          <ButtonRow buttons={node.actions} size="sm" />
        </CardHeader>
      ) : null}
      <CardContent className={hasHeader ? "space-y-4" : "space-y-4 pt-4"}>
        <InCardContext.Provider value>
          <Children nodes={node.children} />
        </InCardContext.Provider>
      </CardContent>
    </Card>
  );
}

function TextNode({ node }: { node: Extract<PluginUiNode, { type: "text" }> }) {
  const tone = node.tone ? TEXT_TONE[node.tone] : "";
  const emphasis = node.emphasis === "strong" ? "font-medium" : node.emphasis === "mono" ? "font-mono" : "";
  return <p className={`whitespace-pre-wrap break-words text-body ${tone} ${emphasis}`.trim()}>{node.text}</p>;
}

function BannerNode({ node }: { node: Extract<PluginUiNode, { type: "banner" }> }) {
  const { variant, icon: Icon } = BANNER[node.tone];
  return (
    <Alert variant={variant}>
      <Icon aria-hidden="true" />
      {node.title ? <AlertTitle>{node.title}</AlertTitle> : null}
      {node.text ? <AlertDescription><p className="whitespace-pre-wrap break-words">{node.text}</p></AlertDescription> : null}
      {node.actions?.length ? <div className="pt-2"><ButtonRow buttons={node.actions} size="sm" /></div> : null}
    </Alert>
  );
}

function KeyValueNode({ node }: { node: Extract<PluginUiNode, { type: "key-value" }> }) {
  const plain = usePlainValue();
  return (
    <dl className="space-y-2">
      {node.items.map((item, index) => (
        <div key={index} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 text-body">
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd className={`min-w-0 break-words ${item.tone ? TEXT_TONE[item.tone] : ""} ${typeof item.value === "number" ? "tabular-nums" : ""}`.trim()}>
            {plain(item.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StatNode({ node }: { node: Extract<PluginUiNode, { type: "stat" }> }) {
  const inCard = useContext(InCardContext);
  const plain = usePlainValue();
  const body = (
    <div className="space-y-1">
      <p className="text-body text-muted-foreground">{node.label}</p>
      <p className="text-heading-lg font-semibold tabular-nums wrap-anywhere">{plain(node.value)}</p>
      {node.help ? <p className="text-body text-muted-foreground">{node.help}</p> : null}
    </div>
  );
  return inCard ? body : <Card className="p-4">{body}</Card>;
}

function EmptyBlock({ title, text, action }: { title: string; text?: string; action?: PluginUiButton }) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-6 text-center">
      <p className="text-heading-sm">{title}</p>
      {text ? <p className="whitespace-pre-wrap break-words text-body text-muted-foreground">{text}</p> : null}
      {action ? <div className="pt-3"><PluginButton node={action} /></div> : null}
    </div>
  );
}

function EmptyStateNode({ node }: { node: Extract<PluginUiNode, { type: "empty-state" }> }) {
  const inCard = useContext(InCardContext);
  const block = <EmptyBlock title={node.title} text={node.text} action={node.action} />;
  return inCard ? block : <Card>{block}</Card>;
}

function CellView({ cell }: { cell: PluginUiCell | undefined }) {
  const plain = usePlainValue();
  const money = useMinorMoney();
  if (cell === undefined) return null;
  if (cell === null || typeof cell !== "object") return <>{plain(cell)}</>;
  if ("badge" in cell) return <Badge variant={BADGE_VARIANT[cell.tone ?? "neutral"]}>{cell.badge}</Badge>;
  if ("to" in cell) return <PluginLink to={cell.to} className="text-link hover:underline">{cell.text}</PluginLink>;
  if ("money" in cell) return <span className="tabular-nums">{money(cell.money, cell.currency)}</span>;
  return <time dateTime={cell.date}>{formatAppDate(cell.date)}</time>;
}

function TableNode({ node }: { node: Extract<PluginUiNode, { type: "table" }> }) {
  const host = useHost();
  const t = useMessages(appUiMessages);
  const inCard = useContext(InCardContext);
  const pagination = node.pagination;
  const previous = typeof pagination?.previous === "string" ? pagination.previous : null;
  const next = typeof pagination?.next === "string" ? pagination.next : null;
  // An app that gives no previous cursor still gets Back to the page before.
  const back = previous === null && pagination?.previous === undefined ? host.paginate?.back ?? null : null;
  const total = typeof pagination?.total === "number" ? pagination.total : null;
  const pager = host.paginate && (previous !== null || back || next !== null);

  const table = node.rows.length === 0 ? (
    <EmptyBlock title={node.empty?.title ?? t("emptyTitle")} text={node.empty?.text} />
  ) : (
    <Table>
      {node.caption ? <caption className="sr-only">{node.caption}</caption> : null}
      <TableHeader>
        <TableRow>
          {node.columns.map((column) => (
            <TableHead key={column.key} data-numeric={column.align === "end" ? "" : undefined}>{column.label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {node.rows.map((row, index) => (
          <TableRow key={row.id ?? index}>
            {node.columns.map((column, columnIndex) => {
              const cell = row.cells[column.key];
              const linkCell = columnIndex === 0 && row.to && !(cell && typeof cell === "object" && "to" in cell);
              return (
                <TableCell key={column.key} data-numeric={column.align === "end" ? "" : undefined}>
                  {linkCell && row.to ? (
                    <PluginLink to={row.to} className="font-medium text-link hover:underline"><CellView cell={cell} /></PluginLink>
                  ) : (
                    <CellView cell={cell} />
                  )}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  const footer = pager || total !== null ? (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
      <span className="text-body text-muted-foreground tabular-nums">{total !== null ? t("total", { count: total }) : null}</span>
      {pager ? (
        <div className="flex gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("previousPage")}
            title={t("previousPage")}
            disabled={previous === null && !back}
            onClick={() => (previous !== null ? host.paginate?.go(previous) : back?.())}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t("nextPage")}
            title={t("nextPage")}
            disabled={next === null}
            onClick={() => (next !== null ? host.paginate?.go(next) : undefined)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  ) : null;

  if (inCard) {
    return (
      <div className="space-y-2">
        {node.caption ? <p aria-hidden="true" className="text-body font-medium">{node.caption}</p> : null}
        <div className="overflow-clip rounded-lg border">
          {table}
          {footer}
        </div>
      </div>
    );
  }
  return (
    <Card className="overflow-clip">
      {node.caption ? (
        <CardHeader>
          <CardTitle aria-hidden="true">{node.caption}</CardTitle>
        </CardHeader>
      ) : null}
      {table}
      {footer}
    </Card>
  );
}

function ImageNode({ node }: { node: Extract<PluginUiNode, { type: "image" }> }) {
  return (
    <img
      src={node.src}
      alt={node.alt}
      width={node.width}
      height={node.height}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="h-auto max-w-full rounded-lg"
    />
  );
}

/** A `page` that is not drawn as a whole dashboard page (a card or dialog body). */
function EmbeddedPage({ node }: { node: Extract<PluginUiNode, { type: "page" }> }) {
  return (
    <div className="space-y-4">
      {node.title || node.description || node.actions?.length ? (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <TitleBlock title={node.title} description={node.description} inCard />
          <ButtonRow buttons={node.actions} size="sm" />
        </div>
      ) : null}
      <Children nodes={node.children} />
    </div>
  );
}

function Node({ node }: { node: PluginUiNode }) {
  switch (node.type) {
    case "page":
      return <EmbeddedPage node={node} />;
    case "section":
      return <SectionNode node={node} />;
    case "card":
      return <CardNode node={node} />;
    case "stack":
      return node.direction === "horizontal" ? (
        <div className={`flex flex-wrap items-center ${ROW_GAP[node.gap ?? "md"]}`}>
          {node.children.map((child, index) => <Node key={index} node={child} />)}
        </div>
      ) : (
        <Children nodes={node.children} className={STACK_GAP[node.gap ?? "md"]} />
      );
    case "columns":
      return (
        <div className={COLUMNS[Math.min(Math.max(node.children.length, 1), 4) as 1 | 2 | 3 | 4]}>
          {node.children.map((child, index) => <div key={index} className="min-w-0"><Node node={child} /></div>)}
        </div>
      );
    case "heading":
      return <Heading text={node.text} level={node.level ?? 2} />;
    case "text":
      return <TextNode node={node} />;
    case "badge":
      return <Badge variant={BADGE_VARIANT[node.tone ?? "neutral"]}>{node.text}</Badge>;
    case "banner":
      return <BannerNode node={node} />;
    case "key-value":
      return <KeyValueNode node={node} />;
    case "stat":
      return <StatNode node={node} />;
    case "table":
      return <TableNode node={node} />;
    case "empty-state":
      return <EmptyStateNode node={node} />;
    case "image":
      return <ImageNode node={node} />;
    case "link":
      return <PluginLink to={node.to} className="text-body text-link hover:underline">{node.text}</PluginLink>;
    case "divider":
      return <Separator />;
    case "button":
      return <PluginButton node={node} />;
    case "form":
      return <FormNode node={node} />;
    default:
      return <InputNode node={node} />;
  }
}

export interface PluginUiRendererProps {
  document: PluginUiDocument;
  host: PluginUiHost;
  /**
   * `page`: a dashboard page of its own (the root page draws the header);
   * `tab`: one tab of an app page (the dashboard draws the page's title and
   * tabs; the root page's description and actions open the tab);
   * `embedded`: a card, widget or dialog body.
   */
  variant: "page" | "tab" | "embedded";
  /** The page title when the app's root page gives none (its manifest title). */
  fallbackTitle?: string;
  /** Beside the page title (`page` only): "Provided by <app>". */
  badge?: ReactNode;
}

/** Draws one validated document. Callers parse it first (`parsePluginUiDocument`). */
export function PluginUiRenderer({ document, host, variant, fallbackTitle, badge }: PluginUiRendererProps) {
  const t = useMessages(appUiMessages);
  const canUse = useCanUseApps();
  const hasActions = useMemo(() => pluginUiRouteActions(document.root).length > 0, [document]);
  const root = document.root;
  const note = hasActions && !canUse ? <p role="note" className="text-body text-muted-foreground">{t("needsUse")}</p> : null;
  return (
    <HostContext.Provider value={host}>
      <InCardContext.Provider value={variant === "embedded"}>
        <div className="@container min-w-0">
          {variant === "page" ? (
            <>
              <PageHeader
                title={(root.type === "page" ? root.title : undefined) || fallbackTitle || host.app.name}
                badge={badge}
                actions={root.type === "page" && root.actions?.length ? <ButtonRow buttons={root.actions} /> : undefined}
              />
              <div className="space-y-4">
                {root.type === "page" && root.description ? (
                  <p className="whitespace-pre-wrap break-words text-body text-muted-foreground">{root.description}</p>
                ) : null}
                {note}
                {root.type === "page" ? <Children nodes={root.children} /> : <Node node={root} />}
              </div>
            </>
          ) : variant === "tab" ? (
            <div className="space-y-4">
              {root.type === "page" && (root.description || root.actions?.length) ? (
                <div className="flex flex-wrap items-start justify-between gap-3">
                  {root.description ? <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-body text-muted-foreground">{root.description}</p> : <span />}
                  {root.actions?.length ? <ButtonRow buttons={root.actions} /> : null}
                </div>
              ) : null}
              {note}
              {root.type === "page" ? <Children nodes={root.children} /> : <Node node={root} />}
            </div>
          ) : (
            <div className="space-y-3">
              {note}
              <Node node={root} />
            </div>
          )}
        </div>
      </InCardContext.Provider>
    </HostContext.Provider>
  );
}
