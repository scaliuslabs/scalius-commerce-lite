import { createServerFn } from "@tanstack/react-start";
import { apiDelete } from "../api.server";

export interface DeleteAbandonedCheckoutsInput {
  ids: string[];
}

export const deleteAbandonedCheckouts = createServerFn({ method: "POST" })
  .validator((data: DeleteAbandonedCheckoutsInput) => data)
  .handler(async ({ data }) => {
    return apiDelete("/abandoned-checkouts", data);
  });
