// Brings Home's setup guide back for this staff member: the dismiss toast's
// Undo and Home's "Show setup guide" menu item say the same.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { postApiV1AdminDashboardSetupGuideShow, type getApiV1AdminDashboardSetupGuide } from "@scalius/api-client/sdk";
import { translate } from "~/i18n";
import { setupGuideMessages } from "~/i18n/setup-guide";
import { apiData, type ApiResult } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { toast } from "~/lib/toast";

type SetupGuideData = ApiResult<typeof getApiV1AdminDashboardSetupGuide>;

export function useShowSetupGuide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiData(postApiV1AdminDashboardSetupGuideShow()),
    onSuccess: () => {
      queryClient.setQueryData<SetupGuideData>(queryKeys.dashboard.setupGuide(), (current) => current && { ...current, dismissed: false });
    },
    onError: () => toast.error(translate(setupGuideMessages, "showFailed")),
  });
}
