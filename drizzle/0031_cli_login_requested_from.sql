-- Where a `foldrun login` request came from (30 Oct 2026, RFC 8628 §5.4):
-- the approval page shows the person the requesting network (an IPv4 /24 or
-- IPv6 /48, from the trusted proxy's word) and, behind Cloudflare, its
-- country — so a code someone else started and sent them reads as such.
-- Nullable, no default: the release before this one never names either,
-- and a request it inserted is shown as "not known".
ALTER TABLE "cli_logins" ADD COLUMN "requested_from" text;--> statement-breakpoint
ALTER TABLE "cli_logins" ADD COLUMN "requested_country" text;
