import {
  getCustomerAuthRequestOptions,
  getDefaultCustomerAuthOtpChannel,
  getLegacyCustomerAuthMethodForPolicy,
  isContactFieldRequiredForAuthChannel,
  isContactFieldVisibleForAuthChannel,
  isCustomerAuthOtpChannel,
  normalizeCustomerAuthPolicy,
  type CustomerAuthMethod,
  type CustomerAuthOtpChannel,
  type CustomerAuthPolicyConfig,
  type CustomerAuthRequestMethod,
  type CustomerAuthRequestOption,
} from "@scalius/shared/customer-auth-policy";
import { isValidPhoneNumber } from "@scalius/shared/customer-utils";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CustomerAuthUiModel {
  authMethod: CustomerAuthMethod;
  policy: CustomerAuthPolicyConfig;
  otpChannel: CustomerAuthOtpChannel;
  requestMethod: CustomerAuthRequestMethod;
  requestOptions: CustomerAuthRequestOption[];
  currentOption: CustomerAuthRequestOption;
  showMethodSwitcher: boolean;
  fields: {
    email: {
      visible: boolean;
      required: boolean;
      primary: boolean;
      label: string;
    };
    phone: {
      visible: boolean;
      required: boolean;
      primary: boolean;
      label: string;
    };
  };
}

export interface CustomerAuthInputState {
  authPolicy: unknown;
  otpChannel: CustomerAuthOtpChannel;
  intent?: "sign_in" | "sign_up";
  identifier: string;
  phoneInput?: string;
  emailInput?: string;
}

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

export function resolveCustomerAuthUi(
  authPolicyInput: unknown,
  otpChannelInput?: CustomerAuthOtpChannel,
  intent: "sign_in" | "sign_up" = "sign_up",
): CustomerAuthUiModel {
  const policy = normalizeCustomerAuthPolicy(authPolicyInput, authPolicyInput);
  const requestOptions = getCustomerAuthRequestOptions(policy);
  const otpChannel = isCustomerAuthOtpChannel(otpChannelInput)
    && policy.otpChannels.includes(otpChannelInput)
    ? otpChannelInput
    : getDefaultCustomerAuthOtpChannel(policy);
  const currentOption = requestOptions.find((option) => option.channel === otpChannel)
    ?? requestOptions[0];
  const emailPrimary = currentOption.destinationField === "email";
  const phonePrimary = currentOption.destinationField === "phone";
  const showCollectionFields = intent === "sign_up";
  const emailRequired = emailPrimary || (showCollectionFields && isContactFieldRequiredForAuthChannel(policy, otpChannel, "email"));
  const phoneRequired = phonePrimary || (showCollectionFields && isContactFieldRequiredForAuthChannel(policy, otpChannel, "phone"));

  return {
    authMethod: getLegacyCustomerAuthMethodForPolicy(policy),
    policy,
    otpChannel,
    requestMethod: currentOption.method,
    requestOptions,
    currentOption,
    showMethodSwitcher: requestOptions.length > 1,
    fields: {
      email: {
        visible: emailPrimary || (showCollectionFields && isContactFieldVisibleForAuthChannel(policy, otpChannel, "email")),
        required: emailRequired,
        primary: emailPrimary,
        label: emailPrimary
          ? currentOption.destinationLabel
          : `Email address (${emailRequired ? "required" : "optional"})`,
      },
      phone: {
        visible: phonePrimary || (showCollectionFields && isContactFieldVisibleForAuthChannel(policy, otpChannel, "phone")),
        required: phoneRequired,
        primary: phonePrimary,
        label: phonePrimary
          ? currentOption.destinationLabel
          : `Phone number (${phoneRequired ? "required" : "optional"})`,
      },
    },
  };
}

export function getCustomerAuthInputError(input: CustomerAuthInputState): string | null {
  const ui = resolveCustomerAuthUi(input.authPolicy, input.otpChannel, input.intent);
  const isAccountCreation = input.intent === "sign_up";
  const emailValue = ui.fields.email.primary ? input.identifier : (input.emailInput ?? "");
  const phoneValue = ui.fields.phone.primary ? input.identifier : (input.phoneInput ?? "");

  if ((ui.fields.email.primary || (isAccountCreation && ui.fields.email.required)) && !isValidEmail(emailValue)) {
    return ui.fields.email.primary
      ? "Enter a valid email address."
      : "Enter a valid email address, or change the login mode.";
  }
  if (ui.fields.email.visible && emailValue.trim() && !isValidEmail(emailValue)) {
    return "Enter a valid email address, or leave it blank.";
  }

  if ((ui.fields.phone.primary || (isAccountCreation && ui.fields.phone.required)) && (!phoneValue || !isValidPhoneNumber(phoneValue))) {
    return ui.fields.phone.primary
      ? `Enter a valid ${ui.currentOption.destinationLabel.toLowerCase()}.`
      : "Enter a valid phone number for account creation.";
  }
  if (ui.fields.phone.visible && phoneValue && !isValidPhoneNumber(phoneValue)) {
    return "Enter a valid phone number, or leave it blank.";
  }

  return null;
}

export function getCustomerAuthAlternateIntent(error: string | null | undefined): "sign_in" | "sign_up" | null {
  const message = error?.toLowerCase() ?? "";
  if (message.includes("sign in instead")) return "sign_in";
  if (message.includes("create an account instead")) return "sign_up";
  return null;
}

export function getCustomerAuthAlternateIntentLabel(intent: "sign_in" | "sign_up"): string {
  return intent === "sign_in" ? "Sign in with this contact" : "Create an account with this contact";
}
