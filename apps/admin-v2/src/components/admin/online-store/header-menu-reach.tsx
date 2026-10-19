/**
 * Whether the live theme draws the header menu (QA round 1, m2). The theme's
 * "Header links from" setting (`blocks.navigation.source`, Theme editor →
 * Theme settings → Navigation) decides it: published categories draw no menu,
 * "Categories and custom links" draws the menu's links after them (behind
 * More once the categories fill the header's top links, `maxTopItems`), and a
 * store without a public category draws the menu whatever the setting says
 * (the storefront's own fallback, `resolveNavigation`). The Navigation page says
 * where each menu is drawn from this, and offers to switch the source in one
 * click: the change is saved to the theme draft and, when the draft holds
 * nothing else, published at once.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { postApiV1AdminSettingsThemeDraft, postApiV1AdminSettingsThemePublish } from "@scalius/api-client/sdk";
import type { StorefrontThemeDocument } from "@scalius/shared/storefront-theme";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { apiData } from "~/lib/api";
import { themeWorkspaceQueryOptions } from "~/lib/api-query-options/online-store";
import { toast } from "~/lib/toast";
import { actionErrorText } from "./action-error";

/**
 * Where the header menu shows: on its own, after the categories, behind More
 * (the categories fill the top links), not at all, or not known (the theme is
 * not readable here).
 */
export type HeaderMenuReach = "drawn" | "afterCategories" | "crowdedOut" | "notDrawn" | "unknown";

export function headerMenuReach(theme: StorefrontThemeDocument, topCategoryCount: number): Exclude<HeaderMenuReach, "unknown"> {
  const { source, maxTopItems } = theme.blocks.navigation;
  // Without a public category the storefront draws the menu (resolveNavigation's fallback).
  if (source === "menu" || topCategoryCount === 0) return "drawn";
  if (source === "category-tree") return "notDrawn";
  return topCategoryCount >= maxTopItems ? "crowdedOut" : "afterCategories";
}

/** The live theme's reach for the header menu; never blocks the page (it loads after it). */
export function useHeaderMenuReach(): HeaderMenuReach {
  const workspace = useQuery({ ...themeWorkspaceQueryOptions(), retry: false });
  if (!workspace.data) return "unknown";
  return headerMenuReach(workspace.data.published.theme as StorefrontThemeDocument, workspace.data.storeShape.topCategoryCount);
}

/** The inline note under the Header menu field when the live theme does not draw it, with the switch. */
export function HeaderMenuNotice({ reach, canSwitch }: { reach: HeaderMenuReach; canSwitch: boolean }) {
  const t = useMessages(onlineStoreMessages);
  const queryClient = useQueryClient();
  const switchSource = useMutation({
    mutationFn: async () => {
      const workspace = await queryClient.fetchQuery({ ...themeWorkspaceQueryOptions(), staleTime: 0 });
      const draft = workspace.draft.theme as StorefrontThemeDocument;
      const theme: StorefrontThemeDocument = {
        ...draft,
        blocks: { ...draft.blocks, navigation: { ...draft.blocks.navigation, source: "menu" } },
      };
      const saved = await apiData(postApiV1AdminSettingsThemeDraft({
        body: { expectedDraftRevision: workspace.draft.revision, basePublishedRevision: workspace.draft.basePublishedRevision, theme },
      }));
      // Only this change goes live: a draft holding other edits waits for the merchant's own Publish.
      if (workspace.draftDiffersFromLive) return { published: false };
      await apiData(postApiV1AdminSettingsThemePublish({
        body: { expectedPublishedRevision: workspace.published.revision, expectedDraftRevision: saved.revision, note: t("headerMenuPublishNote") },
      }));
      return { published: true };
    },
    onSuccess: ({ published }) => {
      if (published) toast.success(t("headerMenuShown"));
      else toast.success(t("headerMenuSavedToDraft"), { description: t("headerMenuSavedToDraftHelp"), duration: 10000 });
    },
    onError: (error) => toast.error(actionErrorText(error)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: themeWorkspaceQueryOptions().queryKey }),
  });

  if (reach === "drawn") return <p className="text-body text-muted-foreground">{t("headerMenuDrawn")}</p>;
  if (reach === "afterCategories") return <p className="text-body text-muted-foreground">{t("headerMenuAfterCategories")}</p>;
  if (reach !== "notDrawn" && reach !== "crowdedOut") return null;
  return (
    <Alert variant="warning" data-header-menu-not-drawn>
      <AlertDescription>
        <p>{t(reach === "notDrawn" ? "headerMenuNotDrawn" : "headerMenuCrowdedOut")}</p>
        <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          {canSwitch ? (
            <Button type="button" variant="outline" size="sm" loading={switchSource.isPending} onClick={() => switchSource.mutate()}>
              {t("headerMenuShowAction")}
            </Button>
          ) : null}
          <Link to="/admin/online-store/theme/editor" className="text-link hover:underline">{t("headerMenuThemeLink")}</Link>
        </span>
      </AlertDescription>
    </Alert>
  );
}
