-- "A workspace's heads changed" and "an account came or went", told to every
-- copy of the platform the moment the write commits (15 Nov 2026). Each pod
-- keeps its own copy of the workspaces (revisions.mirror, FOL-126) and asked
-- Postgres for every workspace's heads every 3 s; now it listens on
-- foldrun_heads (src/mirror-notify.ts) and polls only as a safety net.
--
-- A trigger, not a pg_notify beside each write: every writer of these tables
-- (commit, restore, rename, delete, a previous release mid-rollout, a hand-run
-- fix) is announced, so none can be missed. Postgres sends it on commit and
-- not on rollback, and folds identical ones within a transaction.
--
-- Payload: "tenant/workspace" for heads, "tenant" alone for an account
-- (neither name can hold "/"). Older code ignores the channel: nothing listens.
CREATE OR REPLACE FUNCTION workspace_heads_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM pg_notify('foldrun_heads', OLD.tenant || '/' || OLD.workspace);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM pg_notify('foldrun_heads', NEW.tenant || '/' || NEW.workspace);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER workspace_heads_notify AFTER INSERT OR UPDATE OR DELETE ON workspace_heads FOR EACH ROW EXECUTE FUNCTION workspace_heads_notify();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION tenant_keys_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('foldrun_heads', coalesce(NEW.tenant, OLD.tenant));
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER tenant_keys_notify AFTER INSERT OR DELETE ON tenant_keys FOR EACH ROW EXECUTE FUNCTION tenant_keys_notify();
