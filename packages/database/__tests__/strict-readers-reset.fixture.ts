// Rows for 0149_strict_readers_reset: what the strict readers reject (and the migration resets),
// beside valid rows it must leave alone. Portable SQL: the same text seeds SQLite and PostgreSQL.
const current = '{"version":9,"template":"marketplace","tokens":{},"blocks":{"product":{"buyBox":{"variant":"classic","settings":{}}}}}';
const old = '{"version":6,"template":"marketplace","tokens":{}}';
const retiredChoice = '{"version":9,"template":"marketplace","blocks":{"product":{"buyBox":{"variant":"spec","settings":{}}}}}';
const wrapped = (theme: string) => JSON.stringify({ meta: { changes: [], moreChanges: 0, note: null }, theme: JSON.parse(theme) });
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function strictReadersSeed(publishedTheme: string = current): string {
  return `
INSERT INTO "user"(id,name,email,email_verified,role) VALUES ('admin_1','Admin','admin@shop.test',1,'admin');
INSERT INTO two_factor(id,user_id,secret,backup_codes) VALUES ('tf_plain','admin_1','s','["abc-def"]'),('tf_sealed','admin_1','s','sealed-ciphertext');
INSERT INTO theme_settings(id,colors,revision) VALUES ('default',${quote(publishedTheme)},7);
INSERT INTO theme_settings_drafts(id,theme,revision,base_published_revision) VALUES ('default',${quote(retiredChoice)},9,7);
INSERT INTO theme_settings_versions(id,published_revision,theme,source) VALUES
  ('themev_ok',7,${quote(wrapped(current))},'publish'),
  ('themev_old',6,${quote(old)},'publish'),
  ('themev_retired',5,${quote(wrapped(retiredChoice))},'publish');
INSERT INTO theme_restore_points(id,theme,draft_revision,reason) VALUES ('themerp_good01',${quote(current)},2,'discard'),('themerp_bad001',${quote(old)},3,'discard');
INSERT INTO theme_preview_sessions(token_hash,expires_at) VALUES ('hash_a',4102444800);
INSERT INTO orders(id,customer_name,customer_phone,shipping_address,city,zone,total_amount_minor,payment_method) VALUES
  ('ord_ssl','Buyer','+8801712345678','House 1','c','z',100,'sslcommerz'),
  ('ord_pack','Buyer','+8801712345678','House 1','c','z',100,'scalius.bangladesh:sslcommerz'),
  ('ord_cod','Buyer','+8801712345678','House 1','c','z',100,'cod');
INSERT INTO order_payments(id,order_id,amount_minor,payment_method,status) VALUES ('pay_ssl','ord_ssl',100,'sslcommerz','confirmed');
INSERT INTO payment_session_attempts(id,attempt_key,order_id,gateway,payment_type,currency,request_hash,status)
  VALUES ('psa_ssl','k1','ord_ssl','sslcommerz','full','BDT','h','created');
INSERT INTO delivery_providers(id,name,type,is_active,credentials,config) VALUES
  ('dp_pathao','Pathao','pathao',1,'enc:v1:keys','{"storeId":"924"}'),
  ('dp_app','Acme','acme.parcel:parcel',1,'{}','{}');
INSERT INTO delivery_shipments(id,order_id,provider_id,provider_type,tracking_id,tracking_url,courier_name,status) VALUES
  ('shp_pathao','ord_ssl','dp_pathao','pathao','DL1001',NULL,NULL,'in_transit'),
  ('shp_steadfast','ord_cod',NULL,'steadfast','SF9',NULL,NULL,'in_transit'),
  ('shp_saved','ord_cod',NULL,'pathao','DL2','https://saved.example/DL2','Pathao','in_transit'),
  ('shp_app','ord_pack','dp_app','acme.parcel:parcel','AP1',NULL,NULL,'in_transit');
INSERT INTO settings(id,key,value,type,category) VALUES
  ('s_pm','document','{"enabledMethods":["sslcommerz","cod"],"defaultMethod":"sslcommerz"}','json','payment_methods'),
  ('s_ssl','document','{"storeId":"x","storePassword":"enc","sandbox":true,"enabled":true}','json','sslcommerz'),
  ('s_sms','document','{"activeProvider":"bdbulksms","bdbulksmsToken":"enc:v1:x"}','json','sms');
INSERT INTO checkout_attempts(id,request_key,request_hash,checkout_token,order_id,status) VALUES
  ('ca_done','rk1','h','chk_1','ord_cod','committed'),
  ('ca_stuck','rk2','h','chk_2','ord_ssl','failed'),
  ('ca_wip','rk3','h','chk_3','ord_ssl','processing');
INSERT INTO abandoned_checkouts(id,checkout_id,checkout_data) VALUES
  ('ab_old','c1','{"items":[{"id":"p"}],"customerInfo":{}}'),
  ('ab_new','c2','{"cart":{"items":[{"id":"p"}]},"customerInfo":{}}');`;
}
