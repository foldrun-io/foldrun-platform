ALTER TABLE "model_usage" ADD COLUMN "payer_reason" text;--> statement-breakpoint
ALTER TABLE "model_usage" ADD COLUMN "estimate_usd" numeric(14, 6);--> statement-breakpoint
-- FOL-208: a call still open when it is claimed for settlement is billed at
-- its estimate (estimate_usd), never at a wallet bound held above it —
-- whichever release's settlement claims it (an older one does not know the
-- column, and its claim does not write cost_usd, so 0047's guard does not
-- run). The account's counters are cleared, to be filled again from the
-- rows, when the spend lock can be had at once: waiting for it here (the
-- row's lock already held) is the order that deadlocks with a close. When
-- it cannot, they keep the bound — stricter, never looser — until the next
-- clearing.
CREATE OR REPLACE FUNCTION model_usage_settle_at_estimate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.settled_key IS NULL AND NEW.settled_key IS NOT NULL AND OLD.status = 'open'
     AND NEW.estimate_usd IS NOT NULL AND NEW.estimate_usd < NEW.cost_usd THEN
    NEW.cost_usd := NEW.estimate_usd;
    IF coalesce(current_setting('foldrun.spend_counted', true), '') <> 'on'
       AND pg_try_advisory_xact_lock(hashtext('model-spend:' || NEW.tenant)) THEN
      DELETE FROM model_spend WHERE tenant = NEW.tenant;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER model_usage_settle_at_estimate BEFORE UPDATE OF settled_key ON model_usage FOR EACH ROW EXECUTE FUNCTION model_usage_settle_at_estimate();
