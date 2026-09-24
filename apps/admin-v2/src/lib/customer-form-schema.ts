import { z } from "zod";
import { phoneNumberSchema } from "@scalius/shared/customer-utils";
import { translate } from "~/i18n";
import { formMessages } from "~/i18n/forms";

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
  address: z
    .string()
    .max(500, says("addressTooLong"))
    .nullable(),
  city: z.string().nullable(),
  zone: z.string().nullable(),
  area: z.string().nullable(),
  cityName: z.string().optional(),
  zoneName: z.string().optional(),
  areaName: z.string().optional(),
});

export type CustomerFormValues = z.infer<typeof customerFormSchema>;
