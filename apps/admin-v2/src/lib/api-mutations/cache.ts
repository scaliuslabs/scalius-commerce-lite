import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { postApiV1CacheClear } from "@scalius/api-client/sdk";
import { apiData } from "../api";
import { getServerFnError } from "./shared";

export function useClearCache() {
  return useMutation({
    mutationFn: () => apiData(postApiV1CacheClear()),
    onSuccess: () => toast.success("Store refreshed"),
    onError: (error) =>
      toast.error(getServerFnError(error, "Couldn't refresh the store")),
  });
}
