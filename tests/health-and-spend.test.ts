// Whether a key still works, and what each desk costs.
//
//   node --test tests/health-and-spend.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkProvider, providersInUse } from "../../foldrun-core/src/provider-health.ts";
import { parseProvider } from "../../foldrun-core/src/store.ts";
import { attributeToAgents } from "../src/ledger.ts";
import { spendHistory } from "../src/usage.ts";

function withAccount(files: Record<string, string>, body: () => Promise<void> | void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "foldrun-health-"));
  const prev = process.env.FOLDRUN_DATA;
  process.env.FOLDRUN_DATA = root;
  const done = () => {
    if (prev === undefined) delete process.env.FOLDRUN_DATA;
    else process.env.FOLDRUN_DATA = prev;
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    const out = body();
    if (out && typeof (out as Promise<void>).then === "function") return (out as Promise<void>).finally(done);
    done();
  } catch (err) {
    done();
    throw err;
  }
}

/** A throwaway HTTP server answering one status, so a check can be made
 *  against a real socket rather than a stubbed fetch. */
async function serving(status: number, body: string): Promise<{ url: string; close: () => void }> {
  const http = await import("node:http");
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// ------------------------------------------------------ provider checks

test("a provider that answers is healthy; one that refuses the key names the key", async () => {
  const ok = await serving(200, "{}");
  const dead = await serving(401, '{"error":{"message":"invalid x-api-key"}}');
  try {
    await withAccount({}, async () => {
      const spec = parseProvider({ base_url: ok.url, token: "sk-test", format: "anthropic" })!;
      const good = await checkProvider("acme", null, spec, "claude-haiku-4-5-20251001");
      assert.equal(good.ok, true);
      assert.equal(good.verdict, "ok");

      const badSpec = parseProvider({ base_url: dead.url, token: "sk-test", format: "anthropic" })!;
      const bad = await checkProvider("acme", null, badSpec, "claude-haiku-4-5-20251001");
      assert.equal(bad.ok, false);
      assert.equal(bad.verdict, "credential");
      assert.match(bad.detail, /no longer accepted/);
      // The provider's own words survive: they are the difference between
      // "fix the key" and "fix the model id".
      assert.match(bad.detail, /invalid x-api-key/);
    });
  } finally {
    ok.close();
    dead.close();
  }
});

test("a busy provider is healthy — the key worked, it is simply full", async () => {
  const busy = await serving(429, '{"error":"slow down"}');
  try {
    await withAccount({}, async () => {
      const spec = parseProvider({ base_url: busy.url, token: "sk-test", format: "anthropic" })!;
      const check = await checkProvider("acme", null, spec, "m");
      assert.equal(check.verdict, "busy");
      assert.equal(check.ok, true, "reporting a rate limit as broken trains people to ignore the alert");
    });
  } finally {
    busy.close();
  }
});

test("a 404 points at the endpoint and the model id, not the credential", async () => {
  const missing = await serving(404, "{}");
  try {
    await withAccount({}, async () => {
      const spec = parseProvider({ base_url: missing.url, token: "sk-test", format: "openai" })!;
      const check = await checkProvider("acme", null, spec, "gpt-nope");
      assert.equal(check.verdict, "not-found");
      assert.match(check.detail, /base_url and models:/);
    });
  } finally {
    missing.close();
  }
});

test("a token whose secret is not in the vault fails before any request is made", () =>
  withAccount({}, async () => {
    const spec = parseProvider({ base_url: "https://example.invalid", token: "${NOT_IN_VAULT}" })!;
    const check = await checkProvider("acme", null, spec, "m");
    assert.equal(check.verdict, "credential");
    assert.match(check.detail, /not in this account's vault/);
  }));

test("providers are read from the account, its workspaces and its agents, and deduplicated", () =>
  withAccount(
    {
      "acme/AGENTS.md": "---\nname: acme\nprovider:\n  base_url: https://gw.example.com\n  token: ${GW}\n---\n",
      "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n",
      // Two agents sharing one gateway are one credential: checking it twice
      // spends twice to learn the same fact.
      "acme/workspaces/desk/agents/a/agent.md": "---\nname: a\nprovider:\n  base_url: https://own.example.com\n  token: ${OWN}\n---\n",
      "acme/workspaces/desk/agents/b/agent.md": "---\nname: b\nprovider:\n  base_url: https://own.example.com\n  token: ${OWN}\n---\n",
    },
    () => {
      const found = providersInUse("acme");
      assert.deepEqual(found.map((p) => p.declaredIn).sort(), ["account", "desk/a"]);
    },
  ));

// ---------------------------------------------------- cost attribution

test("a run's charge splits across its agents in proportion to what they used", () => {
  const shares = attributeToAgents(
    [
      { agent: "writer", costUsd: 0.75, computeSecs: 0, status: "completed" },
      { agent: "editor", costUsd: 0.25, computeSecs: 0, status: "completed" },
    ],
    1,
  );
  assert.equal(shares.writer, 0.75);
  assert.equal(shares.editor, 0.25);
  // The column has to add up to the invoice, or nobody can use it.
  assert.equal(Number((shares.writer + shares.editor).toFixed(6)), 1);
});

test("steps that never ran own nothing", () => {
  const shares = attributeToAgents(
    [
      { agent: "writer", costUsd: 1, status: "completed" },
      { agent: "skipped", costUsd: 0, status: "skipped" },
      { agent: "waiting", costUsd: 0, status: "pending" },
    ],
    2,
  );
  assert.deepEqual(Object.keys(shares), ["writer"]);
  assert.equal(shares.writer, 2);
});

test("a run that priced to nothing still attributes, by how many steps each agent ran", () => {
  const shares = attributeToAgents(
    [
      { agent: "a", costUsd: 0, computeSecs: 0, status: "completed" },
      { agent: "a", costUsd: 0, computeSecs: 0, status: "completed" },
      { agent: "b", costUsd: 0, computeSecs: 0, status: "completed" },
    ],
    3,
  );
  assert.equal(shares.a, 2);
  assert.equal(shares.b, 1);
});

test("two steps by one agent are one share", () => {
  const shares = attributeToAgents(
    [
      { agent: "writer", costUsd: 0.5, status: "completed" },
      { agent: "writer", costUsd: 0.5, status: "failed" },
    ],
    1,
  );
  assert.deepEqual(shares, { writer: 1 });
});

// -------------------------------------------------------- spend history

test("spend history reads the ledger, buckets it, and admits what it cannot attribute", () =>
  withAccount({ "acme/AGENTS.md": "---\nname: acme\n---\n" }, async () => {
    const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400_000).toISOString();
    const lines = [
      { t: iso(3), kind: "run", usd: -2, workspace: "desk", runId: "r1", flow: "rankings", agents: { writer: 1.5, editor: 0.5 } },
      { t: iso(10), kind: "run", usd: -1, workspace: "desk", runId: "r2", flow: "rankings", agents: { writer: 1 } },
      // An old line from before charges recorded their flow.
      { t: iso(11), kind: "run", usd: -0.5, workspace: "desk", runId: "r3" },
      // Money in is not spend.
      { t: iso(4), kind: "topup", usd: 20 },
    ];
    fs.writeFileSync(
      path.join(process.env.FOLDRUN_DATA!, "acme", "ledger.jsonl"),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );

    const h = await spendHistory("acme", 56);
    assert.equal(h.totalUsd, 3.5);
    assert.equal(h.unattributedUsd, 0.5, "a breakdown that does not add up to the invoice is worse than one that admits a remainder");
    // Named by workspace: two desks each with a `daily` flow are two flows.
    assert.deepEqual(h.byFlow.map((f) => [f.name, f.totalUsd]), [["desk/rankings", 3]]);
    assert.deepEqual(h.byAgent.map((a) => [a.name, a.totalUsd]), [["desk/writer", 2.5], ["desk/editor", 0.5]]);
    assert.equal(h.bucket, "week");
    assert.equal(h.byFlow[0].runs, 2);
  }));

test("a window with no charges is empty rather than an error", () =>
  withAccount({ "acme/AGENTS.md": "---\nname: acme\n---\n" }, async () => {
    const h = await spendHistory("acme", 7);
    assert.equal(h.totalUsd, 0);
    assert.deepEqual(h.byFlow, []);
  }));

// ---------------------------------------- the account's own budget cap

test("the account budget refuses at admission, and is separate from a workspace's", async () => {
  const { accountBudgetUsd, accountMonthSpendUsd, assertAccountBudget } = await import("../src/limits.ts");
  await withAccount(
    { "acme/AGENTS.md": "---\nname: acme\nbudget: 10\n---\n" },
    async () => {
      assert.equal(accountBudgetUsd("acme"), 10);

      const iso = new Date().toISOString();
      const fs2 = await import("node:fs");
      const p = await import("node:path");
      const ledger = p.join(process.env.FOLDRUN_DATA!, "acme", "ledger.jsonl");
      // Under the cap: a run may start.
      fs2.writeFileSync(ledger, JSON.stringify({ t: iso, kind: "run", usd: -4, workspace: "a" }) + "\n");
      assert.equal(await accountMonthSpendUsd("acme"), 4);
      await assertAccountBudget("acme");

      // Over it: refused, with the number and the file that set it.
      fs2.appendFileSync(ledger, JSON.stringify({ t: iso, kind: "run", usd: -7, workspace: "b" }) + "\n");
      await assert.rejects(
        () => assertAccountBudget("acme"),
        (err: Error & { status?: number }) => {
          assert.equal(err.status, 402);
          assert.match(err.message, /account is at its budget — \$11\.00 spent this month of \$10\/month/);
          assert.match(err.message, /account's AGENTS\.md/);
          return true;
        },
      );
    },
  );
});

test("a top-up does not raise the ceiling", () =>
  withAccount({ "acme/AGENTS.md": "---\nname: acme\nbudget: 10\n---\n" }, async () => {
    const { accountMonthSpendUsd } = await import("../src/limits.ts");
    const iso = new Date().toISOString();
    fs.writeFileSync(
      path.join(process.env.FOLDRUN_DATA!, "acme", "ledger.jsonl"),
      [
        JSON.stringify({ t: iso, kind: "run", usd: -6, workspace: "a" }),
        // Paying us must not let someone spend past their own cap.
        JSON.stringify({ t: iso, kind: "topup", usd: 100 }),
      ].join("\n") + "\n",
    );
    assert.equal(await accountMonthSpendUsd("acme"), 6);
  }));

test("an account with no budget: is uncapped, as before", () =>
  withAccount({ "acme/AGENTS.md": "---\nname: acme\n---\n" }, async () => {
    const { accountBudgetUsd, assertAccountBudget } = await import("../src/limits.ts");
    assert.equal(accountBudgetUsd("acme"), null);
    await assertAccountBudget("acme");
  }));

// ------------------------------------------ manual-run idempotency key

test("a retried start call is answered with the first run, not a second one", async () => {
  const { claimRequestKey, noteRequestRun, resetTriggerState } = await import("../src/trigger-gate.ts");
  await withAccount({ "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n" }, async () => {
    resetTriggerState();
    // First call: nobody has this key, so it starts a run.
    assert.equal(await claimRequestKey("acme", "desk", "run:orders", "req-1", ""), null);
    await noteRequestRun("acme", "desk", "run:orders", "req-1", "run-abc");
    // The retry finds the claim and is told which run it already got.
    assert.equal(await claimRequestKey("acme", "desk", "run:orders", "req-1", ""), "run-abc");
    // A different key, or a different flow, is a different request.
    assert.equal(await claimRequestKey("acme", "desk", "run:orders", "req-2", ""), null);
    assert.equal(await claimRequestKey("acme", "desk", "run:other", "req-1", ""), null);
  });
});

test("a claim whose start failed is handed back; one that started a run is not", async () => {
  const { claimRequestKey, noteRequestRun, releaseRequestKey, resetTriggerState } = await import("../src/trigger-gate.ts");
  await withAccount({ "acme/workspaces/desk/AGENTS.md": "---\nname: desk\n---\n" }, async () => {
    resetTriggerState();
    assert.equal(await claimRequestKey("acme", "desk", "run:orders", "k", ""), null);
    // The start threw (over budget). Without the release, every retry for a
    // day would be told "duplicate" with no run behind it.
    await releaseRequestKey("acme", "desk", "run:orders", "k");
    assert.equal(await claimRequestKey("acme", "desk", "run:orders", "k", ""), null, "claimable again");
    await noteRequestRun("acme", "desk", "run:orders", "k", "run-1");
    await releaseRequestKey("acme", "desk", "run:orders", "k");
    assert.equal(await claimRequestKey("acme", "desk", "run:orders", "k", ""), "run-1", "a claim with a run is kept");
  });
});
