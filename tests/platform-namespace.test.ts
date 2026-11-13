// The platform's namespace is a setting (14 Nov 2026): staging runs as its own
// namespaces (foldrun-staging, foldrun-staging-runs) inside the production
// cluster, so every policy that admits "the platform" must name the platform
// it belongs to — never the literal "foldrun", which would let staging's
// account pods admit production's proxies, or production's admit staging's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { platformNamespace, policyManifests } from "../src/account-pod.ts";
import { SEARCH } from "../src/search-k8s.ts";
import { extractPolicyManifest } from "../src/tool-pod.ts";

function admittedNamespaces(objs: object[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const ns = (o.namespaceSelector as { matchLabels?: Record<string, string> } | undefined)?.matchLabels?.["kubernetes.io/metadata.name"];
      if (ns) out.push(ns);
      Object.values(o).forEach(walk);
    }
  };
  walk(objs);
  return out;
}

test("the platform namespace defaults to foldrun and follows FOLDRUN_PLATFORM_NAMESPACE", () => {
  const was = process.env.FOLDRUN_PLATFORM_NAMESPACE;
  try {
    delete process.env.FOLDRUN_PLATFORM_NAMESPACE;
    assert.equal(platformNamespace(), "foldrun");
    process.env.FOLDRUN_PLATFORM_NAMESPACE = "";
    assert.equal(platformNamespace(), "foldrun", "an empty setting is the default, not an empty name");
    process.env.FOLDRUN_PLATFORM_NAMESPACE = "foldrun-staging";
    assert.equal(platformNamespace(), "foldrun-staging");
  } finally {
    if (was === undefined) delete process.env.FOLDRUN_PLATFORM_NAMESPACE;
    else process.env.FOLDRUN_PLATFORM_NAMESPACE = was;
  }
});

test("account-pod and parser-pod policies admit only this platform's namespace", () => {
  const was = process.env.FOLDRUN_PLATFORM_NAMESPACE;
  try {
    process.env.FOLDRUN_PLATFORM_NAMESPACE = "foldrun-staging";
    const search = admittedNamespaces(policyManifests(SEARCH, "acme"));
    const parser = admittedNamespaces([extractPolicyManifest("acme")]);
    assert.ok(search.length > 0 && parser.length > 0, "the policies name a namespace at all");
    for (const ns of [...search, ...parser]) assert.equal(ns, "foldrun-staging", `a policy admits namespace ${ns}`);
  } finally {
    if (was === undefined) delete process.env.FOLDRUN_PLATFORM_NAMESPACE;
    else process.env.FOLDRUN_PLATFORM_NAMESPACE = was;
  }
});
