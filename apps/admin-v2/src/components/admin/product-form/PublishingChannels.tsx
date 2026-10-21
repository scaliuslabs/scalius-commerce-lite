// The Publishing card's body. A product on every channel (the usual case,
// and a new product the merchant has not changed: `salesChannelIds` null) is
// one line with a Change link. The checkboxes, one per sales channel, open
// with it, or at once when the product is off a channel; unticking one turns
// null into the list of the others. An edit saves the channels with the
// page's Save, apart from the product's revision.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { ReadOnlyValue } from "@/components/ui/field";
import { formatList } from "@scalius/shared/locale-words";
import { getLocale, useMessages } from "~/i18n";
import { salesChannelsMessages } from "~/i18n/sales-channels";
import { salesChannelName, salesChannelsQueryOptions } from "~/lib/api-query-options/sales-channels";
import type { ProductFormValues } from "./types";
import { sortedUniqueStrings } from "~/lib/form-values";

export function PublishingChannels({ form, readOnly }: {
  form: UseFormReturn<ProductFormValues>;
  readOnly: boolean;
}) {
  const t = useMessages(salesChannelsMessages);
  const chosen = useWatch({ control: form.control, name: "salesChannelIds" });
  const { data: channels, isError } = useQuery(salesChannelsQueryOptions());
  // null: open only while the product is off a channel; a choice, once made, stays.
  const [opened, setOpened] = useState(false);
  if (isError) return <p className="text-body text-muted-foreground">{t(readOnly ? "loadFailed" : "publishingLoadFailed")}</p>;
  if (!channels) return <Skeleton className="h-40 w-full" />;
  const published = new Set(chosen ?? channels.map((channel) => channel.id));
  const everywhere = channels.length > 0 && channels.every((channel) => published.has(channel.id) && channel.status === "active");
  const availableSomewhere = channels.some((channel) => published.has(channel.id) && channel.status === "active");
  const manageLink = (
    <Link to="/admin/settings/sales-channels" className="inline-flex min-h-11 items-center rounded-md text-body text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-6">
      {t("manageChannels")}
    </Link>
  );
  if (everywhere && !opened) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-body text-muted-foreground">
            {t(chosen === null && !readOnly ? "availableEverywhereNew" : "availableEverywhere", { channels: formatList(channels.map(salesChannelName), getLocale()) })}
          </p>
          {readOnly ? null : (
            <Button type="button" variant="outline" size="sm" onClick={() => setOpened(true)}>{t("changeChannels")}</Button>
          )}
        </div>
        {manageLink}
      </div>
    );
  }

  const toggle = (id: string, on: boolean) => {
    const next = channels.map((channel) => channel.id)
      .filter((channelId) => (channelId === id ? on : published.has(channelId)));
    form.setValue("salesChannelIds", sortedUniqueStrings(next), { shouldDirty: true });
  };

  return (
    <div className="space-y-3">
      <p className="text-body text-muted-foreground">{chosen === null && !readOnly ? t("publishingNew") : t("publishingHelp")}</p>
      <ul className="space-y-2">
        {channels.map((channel) => (
          <li key={channel.id}>
            {readOnly ? (
              <ReadOnlyValue
                label={salesChannelName(channel)}
                value={t(published.has(channel.id) ? "on" : "off")}
                help={channel.status === "active" ? undefined : t("channelOff")}
              />
            ) : (
              <label className="flex items-start gap-3 text-body">
                <Checkbox
                  checked={published.has(channel.id)}
                  onCheckedChange={(checked) => toggle(channel.id, checked === true)}
                  className="mt-0.5"
                />
                <span className="min-w-0 break-words">
                  {salesChannelName(channel)}
                  {channel.status === "active" ? null : <span className="text-muted-foreground"> · {t("channelOff")}</span>}
                </span>
              </label>
            )}
          </li>
        ))}
      </ul>
      {!availableSomewhere ? <p className="text-body text-muted-foreground">{t("noChannels")}</p> : null}
      {manageLink}
    </div>
  );
}
