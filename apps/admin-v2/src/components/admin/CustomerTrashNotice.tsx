import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { postApiV1AdminCustomersByIdRestore } from "@scalius/api-client/sdk";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { apiData } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { getServerFnError } from "~/lib/api-helpers";
import { useMessages } from "~/i18n";
import { customersMessages } from "~/i18n/customers";
import { resourceMessages } from "~/i18n/resource";

export interface TrashedCustomer {
  id: string;
  mergedInto: { id: string; name: string } | null;
}

/**
 * Why a deleted customer opens read-only. A record merged into an account
 * only names that account (it can't be restored); one in Trash offers Restore.
 */
export function CustomerTrashNotice({ customer, canRestore }: { customer: TrashedCustomer; canRestore: boolean }) {
  const t = useMessages(customersMessages);
  const tr = useMessages(resourceMessages);
  const queryClient = useQueryClient();
  const restore = useMutation({
    mutationFn: () => apiData(postApiV1AdminCustomersByIdRestore({ path: { id: customer.id } })),
    onSuccess: () => toast.success(tr("restored")),
    onError: (error) => toast.error(getServerFnError(error, tr("actionFailed"))),
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.customers.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
    ]),
  });

  const account = customer.mergedInto;
  if (account) {
    const [before, after] = t("mergedInto").split("{name}");
    return (
      <Alert variant="info" role="note">
        <AlertTitle>
          {before}
          <Link to="/admin/customers/$customerId/edit" params={{ customerId: account.id }} className="text-link hover:underline">
            {account.name}
          </Link>
          {after}
        </AlertTitle>
      </Alert>
    );
  }
  return (
    <Alert variant="warning" role="note">
      <AlertTitle>{t("inTrash")}</AlertTitle>
      <AlertDescription>
        <p>{t("inTrashBody")}</p>
        {canRestore ? (
          <Button type="button" variant="outline" size="sm" className="mt-2" loading={restore.isPending} onClick={() => restore.mutate()}>
            {tr("restore")}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
