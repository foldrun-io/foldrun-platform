// A walled run pod has no cluster DNS (FOL-128): the label the policy keys
// on, a resolver that is not there, the egress address in /etc/hosts — and
// a step that cannot have that address does not start.
//
//   node --test tests/run-dns.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { runPodManifest } from "../src/run-k8s.ts";
import { DNS_LABEL, dnsWallEnabled, egressHostAliases, resumedDnsLine, walledDnsSpec } from "../src/run-dns.ts";

type Pod = {
  metadata: { labels: Record<string, string> };
  spec: { dnsPolicy?: string; dnsConfig?: { nameservers: string[]; searches: string[]; options: { name: string; value: string }[] }; hostAliases?: { ip: string; hostnames: string[] }[] };
};

test("a walled pod: labelled, no resolver, the proxy in /etc/hosts; an unwalled one is as before", () => {
  const aliases = [{ ip: "10.43.0.12", hostnames: ["foldrun-egress.foldrun.svc.cluster.local"] }];
  const walled = runPodManifest("p", "img", "run-x", "small", undefined, "acme", false, true, undefined, null, { hostAliases: aliases }) as Pod;
  assert.equal(walled.metadata.labels[DNS_LABEL], "none");
  assert.equal(walled.metadata.labels["foldrun.io/network"], "filtered");
  assert.equal(walled.spec.dnsPolicy, "None");
  assert.deepEqual(walled.spec.dnsConfig?.nameservers, ["127.0.0.1"], "nothing listens there: a lookup fails at once, no packet leaves");
  assert.deepEqual(walled.spec.dnsConfig?.searches, []);
  assert.deepEqual(walled.spec.hostAliases, aliases);

  // Filtered without the wall, or the wall asked for an unfiltered pod: no change.
  for (const pod of [
    runPodManifest("p", "img", "run-x", "small", undefined, "acme", false, true) as Pod,
    runPodManifest("p", "img", "run-x", "small", undefined, "acme", false, false, undefined, null, { hostAliases: aliases }) as Pod,
  ]) {
    assert.equal(pod.metadata.labels[DNS_LABEL], undefined);
    assert.equal(pod.spec.dnsPolicy, undefined);
    assert.equal(pod.spec.hostAliases, undefined);
  }
  // An IP-literal proxy needs no alias, and none is written.
  assert.equal((walledDnsSpec([]) as { hostAliases?: unknown }).hostAliases, undefined);
});

test("the wall is the install's switch, set by the manifests that carry the policy", () => {
  const prev = process.env.FOLDRUN_RUN_DNS_WALL;
  try {
    delete process.env.FOLDRUN_RUN_DNS_WALL;
    assert.equal(dnsWallEnabled(), false);
    process.env.FOLDRUN_RUN_DNS_WALL = "1";
    assert.equal(dnsWallEnabled(), true);
    process.env.FOLDRUN_RUN_DNS_WALL = "true";
    assert.equal(dnsWallEnabled(), false, "only 1 turns it on");
  } finally {
    if (prev === undefined) delete process.env.FOLDRUN_RUN_DNS_WALL;
    else process.env.FOLDRUN_RUN_DNS_WALL = prev;
  }
});

test("the egress address is looked up on the worker; IP literals need none; no answer fails the step", async () => {
  const asked: string[] = [];
  const lookup = async (host: string) => {
    asked.push(host);
    return [{ address: "10.43.0.12", family: 4 }, { address: "10.43.0.12", family: 4 }, { address: "fd00::12", family: 6 }];
  };
  assert.deepEqual(await egressHostAliases("http://foldrun-egress.foldrun.svc.cluster.local:8090", { lookup }), [
    { ip: "10.43.0.12", hostnames: ["foldrun-egress.foldrun.svc.cluster.local"] },
    { ip: "fd00::12", hostnames: ["foldrun-egress.foldrun.svc.cluster.local"] },
  ]);
  assert.deepEqual(asked, ["foldrun-egress.foldrun.svc.cluster.local"]);
  assert.deepEqual(await egressHostAliases("http://10.43.0.12:8090", { lookup: async () => assert.fail("an IP needs no lookup") }), []);
  assert.deepEqual(await egressHostAliases("http://[fd00::12]:8090", { lookup: async () => assert.fail("an IP needs no lookup") }), []);

  // A flaky first answer is asked again.
  let n = 0;
  const flaky = async () => {
    if (n++ === 0) throw Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    return [{ address: "10.43.0.12", family: 4 }];
  };
  assert.equal((await egressHostAliases("http://egress:8090", { lookup: flaky })).length, 1);

  // Never an answer: refused within the deadline, saying why.
  const t0 = Date.now();
  await assert.rejects(egressHostAliases("http://egress:8090", { lookup: () => new Promise(() => {}), deadlineMs: 300 }), /could not find the egress proxy's address \(egress: no answer in .*the step is not started/);
  assert.ok(Date.now() - t0 < 2_000, "a hung lookup is bounded by the deadline");
  await assert.rejects(egressHostAliases("http://egress:8090", { lookup: async () => [], deadlineMs: 300 }), /no address/);
  await assert.rejects(egressHostAliases(undefined), /names no egress proxy/);
  await assert.rejects(egressHostAliases("not a url"), /not a URL/);
});

test("a resumed pod keeps the DNS it was made with, and the trace says when that differs", () => {
  assert.equal(resumedDnsLine(true, true), null);
  assert.equal(resumedDnsLine(false, false), null);
  assert.match(resumedDnsLine(true, false)!, /made without a resolver/);
  assert.match(resumedDnsLine(false, true)!, /can still look names up/);
});
