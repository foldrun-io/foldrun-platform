import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_BETAS, ANTHROPIC_VERSION, GATEWAY_USER_AGENT, betasFor, modelRequestHeaders, modelRequestIdentity } from "../src/gateway-identity.ts";

test("different devices and sessions leave no identifiers in metadata and retain the conversation", () => {
  const normalize = (device: string) => JSON.parse(modelRequestIdentity(Buffer.from(JSON.stringify({
    model: "claude-x", messages: [{ role: "user", content: "hello" }],
    metadata: { user_id: `user_${device}_session_${device}`, device_id: device, session_id: device },
  })))!.toString());
  const first = normalize("mac");
  assert.deepEqual(first, normalize("windows"));
  assert.equal(first.metadata, undefined);
  assert.deepEqual(first.messages, [{ role: "user", content: "hello" }]);
});

test("account and customer metadata is discarded without replacement identifiers", () => {
  for (const tenant of ["account-one", "account-two"]) {
    const body = Buffer.from(JSON.stringify({ model: "claude-x", metadata: { user_id: "customer-one", tenant, customer: "customer-one", arbitrary: { identifyingData: "private" } } }));
    assert.deepEqual(JSON.parse(modelRequestIdentity(body)!.toString()), { model: "claude-x" });
  }
});

test("native OpenAI requests discard all caller metadata and cache ids without replacement attribution", () => {
  const body = Buffer.from(JSON.stringify({ user: "old-session", safety_identifier: "old-device", prompt_cache_key: "laptop-id", metadata: { device_id: "mac", session_id: "abc", client_id: "sdk", deviceId: "mac", sessionId: "abc", userAgent: "sdk", ip: "1.2.3.4", tag: "invoice", arbitraryName: "a user's name" } }));
  for (const shape of ["responses", "chat"] as const) {
    const parsed = JSON.parse(modelRequestIdentity(body)!.toString());
    assert.equal(parsed.user, undefined, shape);
    assert.equal(parsed.safety_identifier, undefined, shape);
    assert.equal(parsed.metadata, undefined);
    assert.equal(parsed.prompt_cache_key, undefined);
  }
});

test("token counting strips metadata without adding unsupported attribution fields", () => {
  const messages = [{ role: "user", content: "count this" }];
  const body = Buffer.from(JSON.stringify({ messages, metadata: { user_id: JSON.stringify({ device_id: "mac", account_uuid: "user-account", session_id: "session" }) }, user: "user", safety_identifier: "device", prompt_cache_key: "laptop" }));
  assert.deepEqual(JSON.parse(modelRequestIdentity(body)!.toString()), { messages });
});

test("malformed bodies stay malformed for the normal request validator", () => {
  for (const text of ["not-json", "null", "[]", '"string"']) {
    const body = Buffer.from(text);
    assert.equal(modelRequestIdentity(body), body);
  }
  assert.equal(modelRequestIdentity(null), null);
});

test("upstream headers identify the gateway and never copy caller credentials or fingerprints", () => {
  assert.equal(GATEWAY_USER_AGENT, "undici", "the actual HTTP transport, without gateway branding or a fake laptop identity");
  const incoming = {
    "user-agent": "device-specific-client", "x-api-key": "caller-key", authorization: "Bearer caller",
    cookie: "session=abc", "x-real-ip": "1.2.3.4", "x-forwarded-for": "1.2.3.4", forwarded: "for=1.2.3.4",
    "x-stainless-os": "Windows", "x-device-id": "abc", "x-session-id": "def", "x-app": "cli",
    "idempotency-key": "user-device-request",
    "anthropic-beta": "some-beta", "content-type": "application/json", accept: "text/event-stream",
  };
  // "some-beta" is not on the platform's list, so no beta goes up at all.
  assert.deepEqual(modelRequestHeaders(incoming, { authorization: "Bearer upstream" }), {
    authorization: "Bearer upstream", "user-agent": GATEWAY_USER_AGENT, "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json", accept: "text/event-stream",
  });
  assert.equal(modelRequestHeaders({})["user-agent"], GATEWAY_USER_AGENT);
});

test("every upstream header is the platform's: version fixed, betas only from its list, accept and content type its own values (owner, 26 Nov 2026)", () => {
  const out = modelRequestHeaders({
    "anthropic-version": "1999-01-01",
    "anthropic-beta": "interleaved-thinking-2025-05-14, files-api-2025-04-14,request-tags-2026-08-21,CONTEXT-1M-2025-08-07,interleaved-thinking-2025-05-14,x\r\ninjected: 1",
    "openai-beta": "assistants=v2", "content-type": "text/plain; charset=evil", accept: "text/event-stream; q=1, */*",
    "x-claude-code-session-id": "abc", "anthropic-workspace-id": "ws", "anthropic-dangerous-direct-browser-access": "true",
  }, { "x-api-key": "platform", "anthropic-version": ANTHROPIC_VERSION });
  assert.deepEqual(out, {
    "x-api-key": "platform", "user-agent": GATEWAY_USER_AGENT, "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": "interleaved-thinking-2025-05-14,context-1m-2025-08-07",
    "content-type": "application/json", accept: "text/event-stream",
  });
  assert.deepEqual(betasFor({ "anthropic-beta": "files-api-2025-04-14,effort-2025-11-24,oauth-2025-04-20" }), {
    kept: ["effort-2025-11-24"], dropped: ["files-api-2025-04-14", "oauth-2025-04-20"],
  }, "the login beta is the platform's to add, never a caller's");
});

test("a provider that does not speak the Anthropic format gets no Anthropic headers, whatever the caller sent, and a plain accept is JSON", () => {
  assert.deepEqual(modelRequestHeaders({ "content-type": "application/json", accept: "*/*", "openai-beta": "x", "anthropic-version": "2023-06-01", "anthropic-beta": "effort-2025-11-24" }, { authorization: "Bearer p" }, "other"), {
    authorization: "Bearer p", "user-agent": GATEWAY_USER_AGENT, "content-type": "application/json", accept: "application/json",
  });
  // An Anthropic-format provider gets the platform's version even when the
  // caller sent none, and a credential map can never smuggle its own.
  assert.equal(modelRequestHeaders({}, { "x-api-key": "p", "anthropic-version": "1999-01-01", "anthropic-beta": "files-api-2025-04-14" })["anthropic-version"], ANTHROPIC_VERSION);
  assert.equal(modelRequestHeaders({}, { "x-api-key": "p", "anthropic-beta": "files-api-2025-04-14" })["anthropic-beta"], undefined);
});

test("the allow list holds nothing that runs on, stores on or bills the provider account, or names the caller", () => {
  for (const b of ALLOWED_BETAS) assert.doesNotMatch(b, /^(files-api|mcp-|web-search|managed-agents|environments|ccr-|agent-memory|dreaming|afk-mode|message-batches|message-threads|resumption|request-tags|user-profiles|program-use-case|oidc-federation|fallback-credit|server-side-fallback|oauth-|advisor-tool|fast-mode)/, b);
});

test("a credential map cannot carry a version, beta or user agent in any case (Codex round 2)", () => {
  const out = modelRequestHeaders({}, { "X-Api-Key": "p", "Anthropic-Beta": "files-api-2025-04-14", "Anthropic-Version": "1999", "User-Agent": "sdk" });
  assert.deepEqual(out, { "x-api-key": "p", "user-agent": GATEWAY_USER_AGENT, "anthropic-version": ANTHROPIC_VERSION });
});
