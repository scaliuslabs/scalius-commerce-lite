import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { clearCache } from "../api-functions/cache";
import { getServerFnError } from "./shared";

export function useClearCache() {
  return useMutation({
    mutationFn: () => clearCache(),
    onSuccess: () => toast.success("Store refreshed"),
    onError: (error) =>
      toast.error(getServerFnError(error, "Couldn't refresh the store")),
  });
}
