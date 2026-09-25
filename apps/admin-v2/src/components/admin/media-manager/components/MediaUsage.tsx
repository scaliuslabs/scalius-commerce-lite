import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "~/components/ui/skeleton";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import { MediaApiClient, type MediaUsage as MediaUsageData } from "../api/mediaClient";
import type { LibraryMediaFile } from "../types";

type Reference = MediaUsageData["references"][number];
type MediaText = (key: keyof typeof mediaMessages.en, vars?: Record<string, string | number>) => string;

const KIND_LABEL = {
  product: "usageProduct",
  category: "usageCategory",
  collection: "usageCollection",
  brand: "usageBrand",
  page: "usagePage",
  article: "usageArticle",
  banner: "usageBanner",
  theme: "usageTheme",
  navigation: "usageNavigation",
  invoice: "usageInvoice",
  social_image: "usageSocialImage",
  video_cover: "usageVideoCover",
  staff_photo: "usageStaffPhoto",
} as const satisfies Record<Reference["kind"], keyof typeof mediaMessages.en>;

const LINK = "font-medium text-link underline-offset-4 hover:underline";

/** The place's editor, named by the record (or by the surface for store-wide places). */
function referenceLink(reference: Reference, text: string): ReactNode {
  const id = reference.id ?? "";
  switch (reference.kind) {
    case "product":
      return <Link className={LINK} to="/admin/products/$productId/edit" params={{ productId: id }}>{text}</Link>;
    case "category":
      return <Link className={LINK} to="/admin/categories/$categoryId/edit" params={{ categoryId: id }}>{text}</Link>;
    case "collection":
      return <Link className={LINK} to="/admin/collections/$collectionId/edit" params={{ collectionId: id }}>{text}</Link>;
    case "page":
      return <Link className={LINK} to="/admin/pages/$pageId/edit" params={{ pageId: id }}>{text}</Link>;
    case "article":
      return <Link className={LINK} to="/admin/articles/$articleId/edit" params={{ articleId: id }}>{text}</Link>;
    case "banner":
      return <Link className={LINK} to="/admin/online-store/banners">{text}</Link>;
    case "theme":
      return <Link className={LINK} to="/admin/online-store/theme">{text}</Link>;
    case "navigation":
      return <Link className={LINK} to="/admin/online-store/navigation">{text}</Link>;
    case "invoice":
      return <Link className={LINK} to="/admin/settings/store">{text}</Link>;
    case "social_image":
      return <Link className={LINK} to="/admin/online-store/preferences">{text}</Link>;
    case "staff_photo":
      return <Link className={LINK} to="/admin/settings/users/$userId" params={{ userId: id }}>{text}</Link>;
    default:
      return <span className="font-medium">{text}</span>;
  }
}

function UsageRow({ reference, t }: { reference: Reference; t: MediaText }) {
  const kind = t(KIND_LABEL[reference.kind]);
  if (!reference.name) return <li>{referenceLink(reference, kind)}</li>;
  const name = reference.trashed ? t("inTrashSuffix", { name: reference.name }) : reference.name;
  return (
    <li className="flex min-w-0 flex-col">
      <span className="truncate">{referenceLink(reference, name)}</span>
      <span className="text-muted-foreground">{kind}</span>
    </li>
  );
}

/** "Used in": every place that shows the file, linking to its editor, plus past orders that keep it. */
export function MediaUsage({ file }: { file: Pick<LibraryMediaFile, "id" | "version"> }) {
  const t = useMessages(mediaMessages);
  const usage = useQuery({
    queryKey: ["media", "usage", file.id, file.version],
    queryFn: () => MediaApiClient.fetchUsage(file.id),
    staleTime: 0,
  });
  const data = usage.data;
  const more = data ? data.count - data.references.length : 0;

  return (
    <section className="flex flex-col gap-1.5 text-body" aria-labelledby={`media-usage-${file.id}`} aria-busy={usage.isPending}>
      <h3 id={`media-usage-${file.id}`} className="font-medium">{t("usedIn")}</h3>
      {usage.isPending ? (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : usage.isError || !data ? (
        <p className="text-muted-foreground">{t("usageLoadFailed")}</p>
      ) : (
        <>
          {data.references.length ? (
            <ul className="flex flex-col gap-2">
              {data.references.map((reference) => (
                <UsageRow key={`${reference.kind}:${reference.id ?? ""}`} reference={reference} t={t} />
              ))}
            </ul>
          ) : data.orderCount === 0 ? (
            <p className="text-muted-foreground">{t("notUsed")}</p>
          ) : null}
          {more > 0 ? <p className="text-muted-foreground">{t("usageMore", { count: more })}</p> : null}
          {data.orderCount > 0 ? (
            <p className="text-muted-foreground">
              {data.orderCount === 1 ? t("ordersOne") : t("ordersMany", { count: data.orderCount })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
