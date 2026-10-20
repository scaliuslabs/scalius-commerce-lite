// The Volt footer, as the source store lays it out: a dark band with the
// contact column (logo, hotline, email, app badges), the outlets column,
// the store's footer menus (About us, Policy, ...) as columns, then the
// social icons and the copyright line; a floating WhatsApp "Live chat"
// button at the bottom end when the merchant gives a number.

import { Image, asset, t, type FooterProps } from "@scalius/plugin-sdk/storefront";
import { Icon, socialIcon } from "./icons";
import { cx, list, text } from "./ui";

export interface FooterSettings {
  hotline_label: string | null;
  outlets_heading: string | null;
  outlets: Array<{ name: string | null; address: string | null }>;
  outlets_link: string | null;
  app_store_url: string | null;
  play_store_url: string | null;
  whatsapp: string | null;
  chat_label: string | null;
  copyright: string | null;
}

export function Footer({ data, settings, context }: FooterProps<FooterSettings>) {
  const { store } = data;
  const logo = store.footerLogo ?? store.logo;
  const outlets = list(settings.outlets).flatMap((outlet) => (text(outlet.name) ? [{ name: text(outlet.name)!, address: text(outlet.address) }] : []));
  const whatsapp = text(settings.whatsapp)?.replace(/[^0-9]/g, "") ?? "";
  const apps = [
    text(settings.app_store_url) ? { href: text(settings.app_store_url)!, top: t(context, { en: "Download on the", bn: "ডাউনলোড করুন" }), name: "App Store" } : null,
    text(settings.play_store_url) ? { href: text(settings.play_store_url)!, top: t(context, { en: "Get it on", bn: "ডাউনলোড করুন" }), name: "Google Play" } : null,
  ].filter((entry): entry is { href: string; top: string; name: string } => entry !== null);
  return (
    <footer class="volt-footer">
      <div class="volt-wrap volt-foot-grid">
        <div class="volt-foot-contact">
          <a class="volt-foot-logo" href={data.routes.home} aria-label={store.name}>
            {logo ? <Image image={logo} alt={store.name} /> : <img src={asset(context, "public/logo-light.svg")} alt={store.name} width="220" height="48" />}
          </a>
          {store.phone ? (
            <a class="volt-foot-line" href={`tel:${store.phone.replace(/[^0-9+]/g, "")}`}>
              <Icon name="phone" size={18} />
              <span><small>{text(settings.hotline_label) ?? t(context, { en: "Hotline", bn: "হটলাইন" })}</small>{store.phone}</span>
            </a>
          ) : null}
          {store.email ? <a class="volt-foot-line" href={`mailto:${store.email}`}><Icon name="mail" size={18} /><span>{store.email}</span></a> : null}
          {store.address ? <p class="volt-foot-line"><Icon name="pin" size={18} /><span>{store.address}</span></p> : null}
          {apps.length > 0 ? (
            <div class="volt-apps">
              {apps.map((app) => <a class="volt-app-badge" href={app.href}><small>{app.top}</small><strong>{app.name}</strong></a>)}
            </div>
          ) : null}
        </div>
        {outlets.length > 0 ? (
          <div class="volt-foot-col">
            <h2 class="volt-foot-title">{text(settings.outlets_heading) ?? t(context, { en: "Our outlets", bn: "আমাদের আউটলেট" })}</h2>
            <ul class="volt-outlets">
              {outlets.map((outlet) => <li><Icon name="pin" size={16} /><span><strong>{outlet.name}</strong>{outlet.address ? <small>{outlet.address}</small> : null}</span></li>)}
            </ul>
            {text(settings.outlets_link) ? <a class="volt-more" href={text(settings.outlets_link)!}>{t(context, { en: "See all outlets", bn: "সব আউটলেট দেখুন" })}<Icon name="chevron" size={14} /></a> : null}
          </div>
        ) : null}
        {data.menus.slice(0, 4).map((menu) => (
          <div class="volt-foot-col">
            <h2 class="volt-foot-title">{menu.title}</h2>
            <ul>{menu.items.map((item) => <li>{item.url && item.url !== "#" ? <a href={item.url}>{item.title}</a> : <span>{item.title}</span>}</li>)}</ul>
          </div>
        ))}
        {data.menus.length === 0 && data.policies.length > 0 ? (
          <div class="volt-foot-col">
            <h2 class="volt-foot-title">{t(context, { en: "Policy", bn: "নীতিমালা" })}</h2>
            <ul>{data.policies.map((policy) => <li><a href={policy.url}>{policy.title}</a></li>)}</ul>
          </div>
        ) : null}
      </div>
      <div class="volt-foot-bottom">
        <div class="volt-wrap volt-foot-bottom-row">
          <p>{text(settings.copyright) ?? `© ${data.year} ${store.name}. ${t(context, { en: "All rights reserved.", bn: "সর্বস্বত্ব সংরক্ষিত।" })}`}</p>
          {store.social.length > 0 ? (
            <ul class="volt-social">
              {store.social.map((entry) => (
                <li><a href={entry.url} aria-label={entry.network} rel="noopener"><Icon name={socialIcon(entry.network)} size={18} /></a></li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      {whatsapp.length >= 8 ? (
        <a class={cx("volt-chat")} href={`https://wa.me/${whatsapp}`} rel="noopener">
          <Icon name="whatsapp" size={22} /><span>{text(settings.chat_label) ?? t(context, { en: "Live chat", bn: "লাইভ চ্যাট" })}</span>
        </a>
      ) : null}
    </footer>
  );
}
