import { z } from "zod";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
import { translate } from "~/i18n";
import { formMessages } from "~/i18n/forms";
import type { AddressDraft } from "~/components/admin/address/address-draft";

// Apart from the other form schemas: phone validation carries libphonenumber's
// metadata, which only the customer form needs.

type FormMessage = keyof (typeof formMessages)["en"];

const says = (key: FormMessage) => ({
  error: () => translate(formMessages, key),
});

export const customerFormSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(3, says("nameLength")).max(100, says("nameLength")),
  email: z.email(says("emailInvalid")).nullable(),
  phone: phoneNumberSchema,
  /**
   * New customers only: the first address (the default), its country's
   * fields (`AddressFields`). The API checks it against the country's rules;
   * a saved customer's addresses are in the address book.
   */
  address: z.custom<AddressDraft>().optional(),
  /** Staff keep a refused address marked (shown once the API refused it). */
  skipAddressValidation: z.boolean().optional(),
});

export type CustomerFormValues = z.infer<typeof customerFormSchema>;
