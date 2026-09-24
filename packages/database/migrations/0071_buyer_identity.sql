-- Buyer identity: one sign-in flow (no stored intent or pinned sign-up
-- contacts), superseded-code detection, no forced profile gate, and an
-- index for linking orders to the account whose email was verified.
ALTER TABLE `customer_auth_otp_challenges` DROP COLUMN `intent`;
--> statement-breakpoint
ALTER TABLE `customer_auth_otp_challenges` DROP COLUMN `contact_email_encrypted`;
--> statement-breakpoint
ALTER TABLE `customer_auth_otp_challenges` DROP COLUMN `phone_encrypted`;
--> statement-breakpoint
ALTER TABLE `customer_auth_otp_challenges` ADD COLUMN `previous_code_hash` text;
--> statement-breakpoint
ALTER TABLE `customers` DROP COLUMN `profile_completion_required_at`;
--> statement-breakpoint
ALTER TABLE `customers` DROP COLUMN `profile_completed_at`;
--> statement-breakpoint
CREATE INDEX `orders_customer_email_normalized_idx` ON `orders` (lower(trim(`customer_email`)));
--> statement-breakpoint
INSERT INTO `scalius_schema_migrations` (`version`, `name`, `source_sha256`) VALUES (71, '0071_buyer_identity', 'cd97b292a1a55b5fa0c99624a080d57bd92f79f62a9b1a4ed68bf86f2064c2b2');
