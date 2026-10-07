import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "~/lib/toast";
import {
  MARKETING_CHANNELS,
  MARKETING_CONSENT_NOTE_MAX,
  type MarketingChannel,
} from "@scalius/shared/customer-marketing";
import { unixToDate } from "@scalius/shared/timestamps";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { getServerFnError } from "~/lib/api-helpers";
import { setCustomerConsent } from "~/lib/api-mutations/customers";
import {
  customerMarketingQueryOptions,
  type CustomerConsent,
  type CustomerConsentEvent,
} from "~/lib/api-query-options/customers";
import { queryKeys } from "~/lib/query-keys";
import { formatDateTime, useMessages } from "~/i18n";
import { customerMarketingMessages } from "~/i18n/customer-marketing";
import { customerPageMessages } from "~/i18n/customer-page";
import { resourceMessages } from "~/i18n/resource";
import { CONSENT_BADGE, consentFacts, suggestedConsentChange } from "./marketing-display";
import { eventTime } from "~/lib/event-time";

/** Consent log entries shown before "Show all". */
const HISTORY_PREVIEW = 3;

const day = (value: string | null | undefined) => {
  const date = unixToDate(value);
  return date ? formatDateTime(date, { dateStyle: "medium" }) : "";
};

const when = (value: string | null | undefined) => {
  const date = unixToDate(value);
  return date ? eventTime(date) ?? "" : "";
};

function ChannelStatus({ consent }: { consent: CustomerConsent }) {
  const t = useMessages(customerMarketingMessages);
  const c = useMessages(customerPageMessages);
  const facts = consentFacts(consent);
  const detail = facts.kind === "no_contact"
    ? t(consent.channel === "email" ? "noEmail" : "noPhone")
    : facts.kind === "other_address"
      ? t("otherAddress")
      : facts.kind === "dated"
        ? [facts.source ? t(`source.${facts.source}`) : null, day(facts.at)].filter(Boolean).join(" · ")
        : null;
  return (
    <li className="space-y-0.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-body font-medium">{c(`channel.${consent.channel}`)}</span>
        <Badge variant={CONSENT_BADGE[consent.status]}>{t(`status.${consent.status}`)}</Badge>
      </div>
      {detail ? <p className="text-body text-muted-foreground">{detail}</p> : null}
    </li>
  );
}

function ConsentEvent({ event }: { event: CustomerConsentEvent }) {
  const t = useMessages(customerMarketingMessages);
  const c = useMessages(customerPageMessages);
  const actor = event.actor === "staff"
    ? event.actorName ? t("eventByStaff", { name: event.actorName }) : t("eventByStaffUnknown")
    : event.actor === "buyer"
      ? t("eventByBuyer")
      : event.actor === "plugin" ? t("eventByApp", { name: event.actorName ?? "" }) : t("eventBySystem");
  return (
    <li className="text-body">
      <p>
        <span className="font-medium">{c(`channel.${event.channel}`)}</span>
        {": "}
        {t(`status.${event.state}`)}
      </p>
      <p className="text-muted-foreground">
        {[t(`source.${event.source}`), when(event.createdAt), actor].join(" · ")}
      </p>
      {event.note ? <p className="break-words text-muted-foreground">“{event.note}”</p> : null}
    </li>
  );
}

/**
 * The customer page's Marketing card: each channel's consent for the
 * customer's current address (status, where it came from and when), the
 * consent log, and an Edit dialog where staff record consent the customer
 * gave outside the store (a note saying how is required) or withdraw it.
 */
export function CustomerMarketingCard({ customerId, canEdit }: { customerId: string; canEdit: boolean }) {
  const t = useMessages(customerMarketingMessages);
  const c = useMessages(customerPageMessages);
  const r = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const marketing = useQuery(customerMarketingQueryOptions(customerId));
  const consents = marketing.data?.consents ?? [];
  const events = marketing.data?.events ?? [];
  const [showAll, setShowAll] = useState(false);

  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<MarketingChannel>("email");
  const [change, setChange] = useState<"subscribed" | "unsubscribed">("subscribed");
  const [note, setNote] = useState("");
  const [noteMissing, setNoteMissing] = useState(false);
  const consentOf = (wanted: MarketingChannel) => consents.find((consent) => consent.channel === wanted);
  const pick = (next: MarketingChannel) => {
    setChannel(next);
    setChange(suggestedConsentChange(consentOf(next)?.status ?? "not_subscribed"));
    setNoteMissing(false);
  };
  const openEditor = () => {
    const first = consents.find((consent) => consent.contact)?.channel ?? "email";
    pick(first);
    setNote("");
    save.reset();
    setOpen(true);
  };

  const save = useMutation({
    mutationFn: () => setCustomerConsent(customerId, { channel, state: change, note: note.trim() || null }),
    onSuccess: (result) => {
      queryClient.setQueryData(customerMarketingQueryOptions(customerId).queryKey, result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.detail(customerId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.customers.list() });
      toast.success(t("consentSaved"));
      setOpen(false);
    },
  });
  const selected = consentOf(channel);
  const noContact = !selected?.contact;
  const blocked = change === "subscribed" && noContact;
  const submit = () => {
    if (blocked) return;
    if (change === "subscribed" && !note.trim()) {
      setNoteMissing(true);
      return;
    }
    save.mutate();
  };
  const history = showAll ? events : events.slice(0, HISTORY_PREVIEW);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>{t("marketing")}</CardTitle>
        {canEdit ? (
          <Button type="button" variant="link" size="sm" disabled={!marketing.data} onClick={openEditor}>
            {t("editMarketing")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {marketing.isError ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-body text-muted-foreground">{t("loadMarketingFailed")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void marketing.refetch()}>{r("retry")}</Button>
          </div>
        ) : !marketing.data ? (
          <div className="space-y-3">
            {MARKETING_CHANNELS.map((item) => <Skeleton key={item} className="h-5 w-full" />)}
          </div>
        ) : (
          <ul className="space-y-3">
            {consents.map((consent) => <ChannelStatus key={consent.channel} consent={consent} />)}
          </ul>
        )}
        {events.length > 0 ? (
          <div className="space-y-2 border-t pt-3">
            <h3 className="text-heading-sm">{t("consentHistory")}</h3>
            <ol className="space-y-2">
              {history.map((event) => <ConsentEvent key={event.id} event={event} />)}
            </ol>
            {events.length > HISTORY_PREVIEW ? (
              <Button type="button" variant="link" size="sm" onClick={() => setShowAll((value) => !value)}>
                {showAll ? t("showLessHistory") : t("showAllHistory", { count: events.length })}
              </Button>
            ) : null}
          </div>
        ) : null}
      </CardContent>

      <Dialog open={open} onOpenChange={(next) => { if (!next && !save.isPending) setOpen(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("editMarketingTitle")}</DialogTitle>
            <DialogDescription>{t("consentNoteHelp")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="mb-2 text-body font-medium">{t("consentChannel")}</legend>
              <RadioGroup value={channel} onValueChange={(value) => pick(value as MarketingChannel)}>
                {consents.map((consent) => (
                  <div key={consent.channel} className="flex min-h-9 items-center gap-2">
                    <RadioGroupItem id={`consent-channel-${consent.channel}`} value={consent.channel} />
                    <Label htmlFor={`consent-channel-${consent.channel}`}>
                      {c(`channel.${consent.channel}`)}
                      <span className="font-normal text-muted-foreground"> · {t(`status.${consent.status}`)}</span>
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="mb-2 text-body font-medium">{t("consentChange")}</legend>
              <RadioGroup value={change} onValueChange={(value) => { setChange(value as typeof change); setNoteMissing(false); }}>
                {(["subscribed", "unsubscribed"] as const).map((value) => (
                  <div key={value} className="flex min-h-9 items-center gap-2">
                    <RadioGroupItem id={`consent-change-${value}`} value={value} />
                    <Label htmlFor={`consent-change-${value}`}>{t(value === "subscribed" ? "subscribe" : "unsubscribe")}</Label>
                  </div>
                ))}
              </RadioGroup>
              {blocked ? (
                <p className="text-body text-destructive">
                  {t("needsContact", { contact: t(channel === "email" ? "contactEmail" : "contactPhone") })}
                </p>
              ) : null}
            </fieldset>
            <div className="space-y-1.5">
              <Label htmlFor="consent-note">{change === "subscribed" ? t("consentNote") : t("consentNoteOptional")}</Label>
              <Textarea
                id="consent-note"
                rows={3}
                value={note}
                maxLength={MARKETING_CONSENT_NOTE_MAX}
                aria-invalid={noteMissing || undefined}
                aria-describedby={noteMissing ? "consent-note-error" : undefined}
                onChange={(event) => {
                  setNote(event.target.value);
                  if (event.target.value.trim()) setNoteMissing(false);
                }}
              />
              {noteMissing ? (
                <p id="consent-note-error" role="alert" className="text-body text-destructive">{t("consentNoteRequired")}</p>
              ) : null}
            </div>
            {save.isError ? (
              <p role="alert" className="text-body text-destructive">{getServerFnError(save.error, r("actionFailed"))}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={save.isPending} onClick={() => setOpen(false)}>{r("cancel")}</Button>
            <Button type="button" loading={save.isPending} disabled={blocked} onClick={submit}>{r("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
