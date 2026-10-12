// The Noor footer: an optional sign-up band, the store's identity and
// contact beside its footer menus (two columns on phones), then the legal line
// with the payment methods it takes. A landing page in campaign mode gets
// only the legal line.

import { Image, editable, t, type FooterProps } from "@scalius/plugin-sdk/storefront";
import { Icon, SocialIcon } from "./icons";
import { choice, cx, text } from "./ui";

export interface FooterSettings {
  newsletter_heading: string | null;
  newsletter_text: string | null;
  newsletter_button: string | null;
  tagline: string | null;
  payments: Array<{ name: string | null }>;
  tone: string;
  landing_footer: string;
}

export function Footer({ data, settings, context }: FooterProps<FooterSettings>) {
  const heading = text(settings.newsletter_heading);
  const payments = settings.payments.flatMap((payment) => (text(payment.name) ? [text(payment.name)!] : []));
  const logo = data.store.footerLogo ?? data.store.logo;
  const tone = choice(settings.tone, ["ink", "soft", "plain"] as const, "ink");
  const campaign = context.page.kind === "landing" && choice(settings.landing_footer, ["full", "campaign"] as const, "campaign") === "campaign";
  const legal = (
    <div class="noor-footer-legal">
      <p>
        © {data.year} {data.store.name}
        {data.policies.map((policy) => <><span aria-hidden="true"> · </span><a href={policy.url}>{policy.title}</a></>)}
      </p>
      {payments.length > 0 ? (
        <ul class="noor-payments" aria-label={t(context, { en: "We accept", bn: "আমরা গ্রহণ করি" })}>
          {payments.map((name) => <li>{name}</li>)}
        </ul>
      ) : null}
    </div>
  );
  if (campaign) return <footer class={cx("noor-footer is-campaign", `tone-${tone}`)}><div class="noor-wrap">{legal}</div></footer>;
  return (
    <footer class={cx("noor-footer", `tone-${tone}`)}>
      <div class="noor-wrap">
        {heading && data.newsletter ? (
          <section class="noor-footer-band" aria-labelledby="noor-footer-signup">
            <div>
              <h2 id="noor-footer-signup" class="noor-h3" {...editable(context, "newsletter_heading")}>{heading}</h2>
              {text(settings.newsletter_text) ? <p {...editable(context, "newsletter_text")}>{settings.newsletter_text}</p> : null}
            </div>
            <a class="noor-btn is-light" href={data.routes.newsletter}>
              <span {...editable(context, "newsletter_button")}>{text(settings.newsletter_button) ?? t(context, { en: "Join the list", bn: "যুক্ত হন" })}</span>
              <Icon name="arrow" size={16} />
            </a>
          </section>
        ) : null}
        <div class="noor-footer-main" style={{ "--noor-menus": Math.max(1, Math.min(4, data.menus.length)) }}>
          <div class="noor-footer-brand">
            <a class="noor-footer-logo" href={data.routes.home} aria-label={data.store.name}>
              {logo ? <Image image={logo} alt={data.store.name} class="noor-logo-img" /> : <span class="noor-logo-text">{data.store.name}</span>}
            </a>
            {text(settings.tagline) ? <p class="noor-footer-tagline" {...editable(context, "tagline")}>{settings.tagline}</p> : null}
            <ul class="noor-contact">
              {data.store.phone ? <li><Icon name="phone" size={16} /><a href={`tel:${data.store.phone.replace(/[^\d+]/g, "")}`}>{data.store.phone}</a></li> : null}
              {data.store.email ? <li><Icon name="mail" size={16} /><a href={`mailto:${data.store.email}`}>{data.store.email}</a></li> : null}
              {data.store.address ? <li><Icon name="pin" size={16} /><span>{data.store.address}</span></li> : null}
            </ul>
            {data.store.social.length > 0 ? (
              <ul class="noor-social">
                {data.store.social.map((link) => (
                  <li><a href={link.url} rel="noopener" target="_blank"><SocialIcon network={link.network} label={link.network} /></a></li>
                ))}
              </ul>
            ) : null}
          </div>
          {data.menus.map((menu) => (
            <nav class="noor-footer-menu" aria-label={menu.title}>
              <h2>{menu.title}</h2>
              <ul>{menu.items.map((item) => <li><a href={item.url}>{item.title}</a></li>)}</ul>
            </nav>
          ))}
        </div>
        {legal}
      </div>
    </footer>
  );
}
