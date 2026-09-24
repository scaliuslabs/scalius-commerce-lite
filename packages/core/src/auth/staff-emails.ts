// Emails the dashboard sends to staff: invite, password reset, sign-in code
// and the password-changed notice. They carry the store's display name
// (`readStoreName`), never the product brand, and the sender name is the store too.

import type { Database } from "@scalius/database/client";
import { escapeHtml } from "@scalius/shared/html-escape";
import { joinPlatformUrl } from "@scalius/shared/platform-config";
import { readStoreName } from "../modules/notifications/store-messages";

export const STAFF_INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const PASSWORD_RESET_TTL_SECONDS = 60 * 60;

export interface StaffEmail {
  subject: string;
  html: string;
  text: string;
}

interface Layout {
  store: string | null;
  heading: string;
  greeting: string;
  lines: string[];
  code?: string;
  action?: { label: string; href: string };
  after?: string[];
  footer: string;
}

function render(subject: string, layout: Layout): StaffEmail {
  const paragraph = (text: string) => `<p style="margin:0 0 16px;">${escapeHtml(text)}</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#ffffff;">
<div role="main" style="max-width:560px;margin:0 auto;padding:24px 20px;overflow-wrap:anywhere;color:#202124;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
${layout.store ? `<p style="margin:0 0 20px;font-size:18px;font-weight:600;">${escapeHtml(layout.store)}</p>` : ""}
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;">${escapeHtml(layout.heading)}</h1>
${paragraph(layout.greeting)}
${layout.lines.map(paragraph).join("\n")}
${layout.code ? `<p style="margin:0 0 16px;font-size:32px;font-weight:600;letter-spacing:6px;font-family:Menlo,Consolas,monospace;">${escapeHtml(layout.code)}</p>` : ""}
${layout.action ? `<p style="margin:24px 0;"><a href="${escapeHtml(layout.action.href)}" style="display:inline-block;padding:12px 20px;background:#202124;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(layout.action.label)}</a></p>
<p style="margin:0 0 16px;color:#5f6368;font-size:14px;">Or open this link: <span style="word-break:break-all;">${escapeHtml(layout.action.href)}</span></p>` : ""}
${(layout.after ?? []).map(paragraph).join("\n")}
<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #dadce0;color:#5f6368;font-size:14px;">${escapeHtml(layout.footer)}</p>
</div></body></html>`;
  const text = [
    layout.store,
    layout.heading,
    layout.greeting,
    ...layout.lines,
    layout.code,
    layout.action ? `${layout.action.label}: ${layout.action.href}` : null,
    ...(layout.after ?? []),
    layout.footer,
  ].filter(Boolean).join("\n\n");
  return { subject: subject.replace(/[\r\n]+/g, " "), html, text };
}

export function staffInviteEmail(input: {
  store: string | null;
  inviterName: string | null;
  name: string;
  link: string;
}): StaffEmail {
  const place = input.store ?? "the store dashboard";
  const heading = input.inviterName ? `${input.inviterName} invited you to ${place}` : `You're invited to ${place}`;
  return render(heading, {
    store: input.store,
    heading,
    greeting: `Hi ${input.name},`,
    lines: [`You've been added as staff. Set up your account to start working in ${place}.`],
    action: { label: "Accept invite", href: input.link },
    after: ["This invite expires in 7 days. After you choose a password, you'll turn on two-step verification."],
    footer: "If you weren't expecting this invite, you can ignore this email.",
  });
}

export function staffPasswordResetEmail(input: { store: string | null; name: string; link: string }): StaffEmail {
  const subject = input.store ? `Reset your ${input.store} password` : "Reset your password";
  return render(subject, {
    store: input.store,
    heading: "Reset your password",
    greeting: `Hi ${input.name},`,
    lines: [`We got a request to reset the password for your staff account${input.store ? ` at ${input.store}` : ""}.`],
    action: { label: "Reset password", href: input.link },
    after: ["This link works once and expires in 1 hour."],
    footer: "If you didn't ask for this, you can ignore this email. Your password won't change.",
  });
}

export function staffSignInCodeEmail(input: { store: string | null; name: string; code: string }): StaffEmail {
  const subject = input.store ? `Your ${input.store} verification code` : "Your verification code";
  return render(subject, {
    store: input.store,
    heading: "Your verification code",
    greeting: `Hi ${input.name},`,
    lines: ["Enter this code to confirm it's you:"],
    code: input.code,
    after: ["It expires in 5 minutes. Don't share it with anyone."],
    footer: "If you didn't try to sign in, change your password right away.",
  });
}

export function staffPasswordChangedEmail(input: {
  store: string | null;
  name: string;
  email: string;
  resetLink: string | null;
}): StaffEmail {
  const subject = input.store ? `Your ${input.store} password was changed` : "Your password was changed";
  return render(subject, {
    store: input.store,
    heading: "Your password was changed",
    greeting: `Hi ${input.name},`,
    lines: [
      `The password for your staff account (${input.email}) was just changed.`,
      "If this was you, there's nothing else to do.",
      "If this wasn't you, reset your password now and tell the store owner.",
    ],
    action: input.resetLink ? { label: "Reset password", href: input.resetLink } : undefined,
    footer: "This is a security notice about your staff account.",
  });
}

/**
 * The security notice after a password change or reset. It links only to the
 * forgot-password page (no token), and a delivery failure never undoes the change.
 */
export async function sendStaffPasswordChangedEmail(input: {
  db: Database;
  env: Record<string, unknown>;
  dashboardUrl: string | undefined;
  user: { name: string; email: string };
}): Promise<void> {
  try {
    const { sendEmail } = await import("../integrations/email");
    const message = staffPasswordChangedEmail({
      store: await readStoreName(input.db),
      name: input.user.name,
      email: input.user.email,
      resetLink: input.dashboardUrl ? joinPlatformUrl(input.dashboardUrl, "/auth/forgot-password") : null,
    });
    const delivery = await sendEmail({ to: input.user.email, ...message }, {
      db: input.db,
      env: input.env,
      encryptionKey: input.env.CREDENTIAL_ENCRYPTION_KEY as string | undefined,
    });
    if (!delivery.success) console.warn("[Auth] Password-changed notice was not delivered", { provider: delivery.provider });
  } catch {
    console.warn("[Auth] Password-changed notice failed");
  }
}
