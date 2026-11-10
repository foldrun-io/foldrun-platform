-- model_spend counts what model_usage holds only while every writer moves
-- it. A write the counting code did not make — the previous release during a
-- rollout or after a rollback, a hand-run fix — clears that account's
-- counters, and the next call fills them again from model_usage. The
-- counting code says it is counting with set_config('foldrun.spend_counted',
-- 'on', true) in the same transaction. A fill and this guard take one lock
-- per account, so neither can miss the other.
CREATE OR REPLACE FUNCTION model_spend_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('foldrun.spend_counted', true), '') <> 'on' THEN
    -- The lock a counter's fill takes (model-usage.ts fillCounters): a fill
    -- running now waits for this write and counts it; one already made is
    -- cleared here.
    PERFORM pg_advisory_xact_lock(hashtext('model-spend:' || NEW.tenant));
    DELETE FROM model_spend WHERE tenant = NEW.tenant;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER model_usage_spend_guard AFTER INSERT OR UPDATE OF cost_usd ON model_usage FOR EACH ROW EXECUTE FUNCTION model_spend_guard();
