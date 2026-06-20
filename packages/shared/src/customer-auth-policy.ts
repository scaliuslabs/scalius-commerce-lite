export const CUSTOMER_AUTH_METHODS = [
  "email",
  "sms_otp",
  "whatsapp_otp",
  "both",
] as const;

export const CUSTOMER_AUTH_OTP_CHANNELS = ["email", "sms", "whatsapp"] as const;
export const CUSTOMER_AUTH_CONTACT_FIELDS = ["email", "phone"] as const;

export type CustomerAuthMethod = (typeof CUSTOMER_AUTH_METHODS)[number];
export type CustomerAuthOtpChannel = (typeof CUSTOMER_AUTH_OTP_CHANNELS)[number];
export type CustomerAuthContactField = (typeof CUSTOMER_AUTH_CONTACT_FIELDS)[number];
export type CustomerAuthRequestMethod = "email" | "phone";
export type CustomerAuthDeliveryChannel = CustomerAuthOtpChannel;

export interface CustomerAuthPolicyConfig {
  otpChannels: CustomerAuthOtpChannel[];
  requiredContactFields: CustomerAuthContactField[];
  optionalContactFields: CustomerAuthContactField[];
  defaultOtpChannel: CustomerAuthOtpChannel;
}

export interface CustomerAuthRequestOption {
  method: CustomerAuthRequestMethod;
  channel: CustomerAuthOtpChannel;
  destinationField: CustomerAuthContactField;
  label: string;
  destinationLabel: string;
}

export interface CustomerAuthPolicyPreset {
  method: CustomerAuthMethod;
  label: string;
  policy: CustomerAuthPolicyConfig;
  requestOptions: CustomerAuthRequestOption[];
  defaultRequestMethod: CustomerAuthRequestMethod;
  requiresEmailProvider: boolean;
  requiresSmsProvider: boolean;
  requiresWhatsAppProvider: boolean;
}

const CHANNEL_OPTIONS = {
  email: {
    method: "email",
    channel: "email",
    destinationField: "email",
    label: "Email",
    destinationLabel: "Email address",
  },
  sms: {
    method: "phone",
    channel: "sms",
    destinationField: "phone",
    label: "SMS",
    destinationLabel: "Phone number",
  },
  whatsapp: {
    method: "phone",
    channel: "whatsapp",
    destinationField: "phone",
    label: "WhatsApp",
    destinationLabel: "WhatsApp number",
  },
} as const satisfies Record<CustomerAuthOtpChannel, CustomerAuthRequestOption>;

export const CUSTOMER_AUTH_CHANNEL_OPTIONS = CHANNEL_OPTIONS;

const PRESET_POLICIES: Record<CustomerAuthMethod, CustomerAuthPolicyConfig> = {
  email: {
    otpChannels: ["email"],
    requiredContactFields: ["phone"],
    optionalContactFields: [],
    defaultOtpChannel: "email",
  },
  sms_otp: {
    otpChannels: ["sms"],
    requiredContactFields: ["phone"],
    optionalContactFields: ["email"],
    defaultOtpChannel: "sms",
  },
  whatsapp_otp: {
    otpChannels: ["whatsapp"],
    requiredContactFields: ["phone"],
    optionalContactFields: ["email"],
    defaultOtpChannel: "whatsapp",
  },
  both: {
    otpChannels: ["email", "sms"],
    requiredContactFields: ["phone"],
    optionalContactFields: ["email"],
    defaultOtpChannel: "email",
  },
};

const CUSTOMER_AUTH_METHOD_SET = new Set<string>(CUSTOMER_AUTH_METHODS);
const CUSTOMER_AUTH_OTP_CHANNEL_SET = new Set<string>(CUSTOMER_AUTH_OTP_CHANNELS);
const CUSTOMER_AUTH_CONTACT_FIELD_SET = new Set<string>(CUSTOMER_AUTH_CONTACT_FIELDS);

export function isCustomerAuthMethod(value: unknown): value is CustomerAuthMethod {
  return typeof value === "string" && CUSTOMER_AUTH_METHOD_SET.has(value);
}

export function isCustomerAuthOtpChannel(value: unknown): value is CustomerAuthOtpChannel {
  return typeof value === "string" && CUSTOMER_AUTH_OTP_CHANNEL_SET.has(value);
}

export function isCustomerAuthContactField(value: unknown): value is CustomerAuthContactField {
  return typeof value === "string" && CUSTOMER_AUTH_CONTACT_FIELD_SET.has(value);
}

export function normalizeCustomerAuthMethod(value: unknown): CustomerAuthMethod {
  if (value === "phone") return "sms_otp";
  if (value === "email_phone_mandatory") return "email";
  return isCustomerAuthMethod(value) ? value : "email";
}

export function getCustomerAuthPolicyForMethod(methodInput: unknown): CustomerAuthPolicyConfig {
  const method = normalizeCustomerAuthMethod(methodInput);
  return clonePolicy(PRESET_POLICIES[method]);
}

export function normalizeCustomerAuthPolicy(
  value: unknown,
  fallbackMethod: unknown = "email",
): CustomerAuthPolicyConfig {
  const fallback = getCustomerAuthPolicyForMethod(fallbackMethod);
  if (!value || typeof value !== "object") return fallback;

  const input = value as Record<string, unknown>;
  const otpChannels = uniqueValidValues(input.otpChannels, isCustomerAuthOtpChannel);
  const channels = otpChannels.length > 0 ? otpChannels : fallback.otpChannels;
  const required = uniqueValidValues(input.requiredContactFields, isCustomerAuthContactField);
  const optional = uniqueValidValues(input.optionalContactFields, isCustomerAuthContactField)
    .filter((field) => !required.includes(field));
  const defaultOtpChannel = isCustomerAuthOtpChannel(input.defaultOtpChannel)
    && channels.includes(input.defaultOtpChannel)
    ? input.defaultOtpChannel
    : channels[0]!;

  return enforceRuntimeContactConstraints({
    otpChannels: channels,
    requiredContactFields: required,
    optionalContactFields: optional,
    defaultOtpChannel,
  });
}

export function resolveCustomerAuthPolicy(value: unknown): CustomerAuthPolicyPreset {
  const method = normalizeCustomerAuthMethod(value);
  const policy = getCustomerAuthPolicyForMethod(method);
  return {
    method,
    label: getCustomerAuthMethodLabel(method),
    policy,
    requestOptions: getCustomerAuthRequestOptions(policy),
    defaultRequestMethod: getCustomerAuthRequestMethodForChannel(policy.defaultOtpChannel),
    requiresEmailProvider: customerAuthPolicyUsesEmailProvider(policy),
    requiresSmsProvider: customerAuthPolicyUsesSmsProvider(policy),
    requiresWhatsAppProvider: customerAuthPolicyUsesWhatsAppProvider(policy),
  };
}

export function getCustomerAuthMethodLabel(methodInput: unknown): string {
  const method = normalizeCustomerAuthMethod(methodInput);
  if (method === "email") return "Email OTP";
  if (method === "sms_otp") return "SMS OTP";
  if (method === "whatsapp_otp") return "WhatsApp OTP";
  return "Email or SMS OTP";
}

export function getCustomerAuthRequestOptions(policyInput: unknown): CustomerAuthRequestOption[] {
  const policy = normalizeCustomerAuthPolicy(policyInput);
  return policy.otpChannels.map((channel) => CHANNEL_OPTIONS[channel]);
}

export function resolveCustomerAuthChannelForRequest(
  policyInput: unknown,
  requestMethod: CustomerAuthRequestMethod,
  requestedChannel?: unknown,
): CustomerAuthOtpChannel | null {
  const policy = normalizeCustomerAuthPolicy(policyInput);
  const options = getCustomerAuthRequestOptions(policy);

  if (isCustomerAuthOtpChannel(requestedChannel)) {
    const requestedOption = CHANNEL_OPTIONS[requestedChannel];
    if (
      policy.otpChannels.includes(requestedChannel)
      && requestedOption.method === requestMethod
    ) {
      return requestedChannel;
    }
  }

  const candidates = options
    .filter((option) => option.method === requestMethod)
    .map((option) => option.channel);

  if (candidates.length === 0) return null;
  if (candidates.includes(policy.defaultOtpChannel)) return policy.defaultOtpChannel;
  return candidates[0]!;
}

export function getCustomerAuthAllowedRequestMethods(value: unknown): CustomerAuthRequestMethod[] {
  return dedupe(getCustomerAuthRequestOptions(getCustomerAuthPolicyForMethod(value)).map((option) => option.method));
}

export function getDefaultCustomerAuthRequestMethod(value: unknown): CustomerAuthRequestMethod {
  return getCustomerAuthRequestMethodForChannel(getCustomerAuthPolicyForMethod(value).defaultOtpChannel);
}

export function getDefaultCustomerAuthOtpChannel(policyInput: unknown): CustomerAuthOtpChannel {
  return normalizeCustomerAuthPolicy(policyInput).defaultOtpChannel;
}

export function getCustomerAuthRequestMethodForChannel(
  channel: CustomerAuthOtpChannel,
): CustomerAuthRequestMethod {
  return CHANNEL_OPTIONS[channel].method;
}

export function getCustomerAuthContactFieldForChannel(
  channel: CustomerAuthOtpChannel,
): CustomerAuthContactField {
  return CHANNEL_OPTIONS[channel].destinationField;
}

export function customerAuthMethodUsesSmsProvider(value: unknown): boolean {
  return customerAuthPolicyUsesSmsProvider(getCustomerAuthPolicyForMethod(value));
}

export function customerAuthMethodUsesEmailProvider(value: unknown): boolean {
  return customerAuthPolicyUsesEmailProvider(getCustomerAuthPolicyForMethod(value));
}

export function customerAuthMethodUsesWhatsAppProvider(value: unknown): boolean {
  return customerAuthPolicyUsesWhatsAppProvider(getCustomerAuthPolicyForMethod(value));
}

export function customerAuthPolicyUsesEmailProvider(policyInput: unknown): boolean {
  return normalizeCustomerAuthPolicy(policyInput).otpChannels.includes("email");
}

export function customerAuthPolicyUsesSmsProvider(policyInput: unknown): boolean {
  return normalizeCustomerAuthPolicy(policyInput).otpChannels.includes("sms");
}

export function customerAuthPolicyUsesWhatsAppProvider(policyInput: unknown): boolean {
  return normalizeCustomerAuthPolicy(policyInput).otpChannels.includes("whatsapp");
}

export function getCustomerAuthDeliveryChannel(
  authMethod: unknown,
  requestMethod: CustomerAuthRequestMethod,
  requestedChannel?: unknown,
): CustomerAuthDeliveryChannel {
  const policy = typeof authMethod === "object" && authMethod !== null
    ? normalizeCustomerAuthPolicy(authMethod)
    : getCustomerAuthPolicyForMethod(authMethod);
  const channel = resolveCustomerAuthChannelForRequest(policy, requestMethod, requestedChannel);
  if (channel) return channel;
  return requestMethod === "email" ? "email" : "sms";
}

export function getLegacyCustomerAuthMethodForPolicy(policyInput: unknown): CustomerAuthMethod {
  const policy = normalizeCustomerAuthPolicy(policyInput);
  const channels = [...policy.otpChannels].sort().join(",");
  if (channels === "email") return "email";
  if (channels === "sms") return "sms_otp";
  if (channels === "whatsapp") return "whatsapp_otp";
  if (channels === "email,sms") return "both";
  if (policy.defaultOtpChannel === "whatsapp") return "whatsapp_otp";
  if (policy.defaultOtpChannel === "sms") return "sms_otp";
  return "email";
}

export function isContactFieldRequiredForAuthChannel(
  policyInput: unknown,
  channel: CustomerAuthOtpChannel,
  field: CustomerAuthContactField,
): boolean {
  const policy = normalizeCustomerAuthPolicy(policyInput);
  return getCustomerAuthContactFieldForChannel(channel) === field
    || policy.requiredContactFields.includes(field);
}

export function isContactFieldVisibleForAuthChannel(
  policyInput: unknown,
  channel: CustomerAuthOtpChannel,
  field: CustomerAuthContactField,
): boolean {
  const policy = normalizeCustomerAuthPolicy(policyInput);
  return isContactFieldRequiredForAuthChannel(policy, channel, field)
    || policy.optionalContactFields.includes(field);
}

function enforceRuntimeContactConstraints(policy: CustomerAuthPolicyConfig): CustomerAuthPolicyConfig {
  const required = [...policy.requiredContactFields];

  // Phone is a platform invariant for customer identity, checkout, delivery,
  // fraud checks, and SMS/WhatsApp destinations. Merchants can require email,
  // but they cannot make phone optional or uncollected.
  if (!required.includes("phone")) {
    required.push("phone");
  }

  return {
    ...policy,
    requiredContactFields: required,
    optionalContactFields: policy.optionalContactFields.filter((field) => !required.includes(field)),
  };
}

function clonePolicy(policy: CustomerAuthPolicyConfig): CustomerAuthPolicyConfig {
  return enforceRuntimeContactConstraints({
    otpChannels: [...policy.otpChannels],
    requiredContactFields: [...policy.requiredContactFields],
    optionalContactFields: [...policy.optionalContactFields],
    defaultOtpChannel: policy.defaultOtpChannel,
  });
}

function uniqueValidValues<T extends string>(
  value: unknown,
  guard: (item: unknown) => item is T,
): T[] {
  if (!Array.isArray(value)) return [];
  return dedupe(value.filter(guard));
}

function dedupe<T extends string>(values: T[]): T[] {
  return Array.from(new Set(values));
}
