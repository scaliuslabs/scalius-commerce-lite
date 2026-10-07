// The Publishing card's body: one checkbox per sales channel. A new product
// the merchant has not changed is available everywhere (`salesChannelIds`
// null); unticking a channel turns that into the list of the others. An edit
// saves the channels with the page's Save, apart from the product's revision.
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useWatch, type UseFormReturn } from "react-hook-form";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useMessages } from "~/i18n";
import { salesChannelsMessages } from "~/i18n/sales-channels";
import { salesChannelName, salesChannelsQueryOptions } from "~/lib/api-query-options/sales-channels";
import type { ProductFormValues } from "./types";

export function PublishingChannels({ form, readOnly }: {
  form: UseFormReturn<ProductFormValues>;
  readOnly: boolean;
}) {
  const t = useMessages(salesChannelsMessages);
  const chosen = useWatch({ control: form.control, name: "salesChannelIds" });
  const { data: channels, isError } = useQuery(salesChannelsQueryOptions());
  if (isError) return <p className="text-body text-muted-foreground">{t("publishingLoadFailed")}</p>;
  if (!channels) return <Skeleton className="h-40 w-full" />;
  const published = new Set(chosen ?? channels.map((channel) => channel.id));

  const toggle = (id: string, on: boolean) => {
    const next = channels.map((channel) => channel.id)
      .filter((channelId) => (channelId === id ? on : published.has(channelId)));
    form.setValue("salesChannelIds", next, { shouldDirty: true });
  };

  return (
    <div className="space-y-3">
      <p className="text-body text-muted-foreground">{chosen === null ? t("publishingNew") : t("publishingHelp")}</p>
      <ul className="space-y-2">
        {channels.map((channel) => (
          <li key={channel.id}>
            <label className="flex items-start gap-3 text-body">
              <Checkbox
                checked={published.has(channel.id)}
                disabled={readOnly}
                onCheckedChange={(checked) => toggle(channel.id, checked === true)}
                className="mt-0.5"
              />
              <span className="min-w-0 break-words">
                {salesChannelName(channel)}
                {channel.status === "active" ? null : <span className="text-muted-foreground"> · {t("channelOff")}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {published.size === 0 ? <p className="text-body text-muted-foreground">{t("noChannels")}</p> : null}
      <Link to="/admin/settings/sales-channels" className="inline-block text-body text-primary hover:underline">
        {t("manageChannels")}
      </Link>
    </div>
  );
}
