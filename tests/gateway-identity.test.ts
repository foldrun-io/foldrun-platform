import { test } from "node:test";
import assert from "node:assert/strict";
import { GATEWAY_USER_AGENT, gatewayUserId, modelRequestHeaders, modelRequestIdentity } from "../src/gateway-identity.ts";
import { providerUserId } from "../../foldrun-core/src/customer.ts";

test("different devices and sessions use the same gateway account identity without changing the conversation", () => {
  const normalize = (device: string) => JSON.parse(modelRequestIdentity(Buffer.from(JSON.stringify({
    model: "claude-x", messages: [{ role: "user", content: "hello" }],
    metadata: { user_id: `user_${device}_session_${device}`, device_id: device, session_id: device },
  })), "acme", null, "anthropic")!.toString());
  const first = normalize("mac");
  assert.deepEqual(first, normalize("windows"));
  assert.deepEqual(first.metadata, { user_id: gatewayUserId("acme", null) });
  assert.match(first.metadata.user_id, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.messages, [{ role: "user", content: "hello" }]);
  assert.notEqual(first.metadata.user_id, gatewayUserId("other-account", null));
});

test("configured customer identities remain distinct and replace caller-provided identities", () => {
  const body = Buffer.from('{"metadata":{"user_id":"device-session","device_id":"mac"}}');
  const normalize = (customer: string) => JSON.parse(modelRequestIdentity(body, "acme", customer, "anthropic")!.toString()).metadata;
  assert.deepEqual(normalize("one"), { user_id: providerUserId("acme", "one") });
  assert.notDeepEqual(normalize("one"), normalize("two"));
});

test("native OpenAI requests discard all caller metadata and cache ids, and use only proxy-owned attribution", () => {
  const body = Buffer.from(JSON.stringify({ user: "old-session", safety_identifier: "old-device", prompt_cache_key: "laptop-id", metadata: { device_id: "mac", session_id: "abc", client_id: "sdk", deviceId: "mac", sessionId: "abc", userAgent: "sdk", ip: "1.2.3.4", tag: "invoice", arbitraryName: "a user's name" } }));
  for (const shape of ["responses", "chat"] as const) {
    const parsed = JSON.parse(modelRequestIdentity(body, "acme", null, shape)!.toString());
    assert.equal(parsed.user, shape === "chat" ? gatewayUserId("acme", null) : undefined);
    assert.equal(parsed.safety_identifier, shape === "responses" ? gatewayUserId("acme", null) : undefined);
    assert.equal(parsed.metadata, undefined);
    assert.equal(parsed.prompt_cache_key, undefined);
  }
});

test("token counting strips metadata without adding unsupported attribution fields", () => {
  const messages = [{ role: "user", content: "count this" }];
  const body = Buffer.from(JSON.stringify({ messages, metadata: { user_id: JSON.stringify({ device_id: "mac", account_uuid: "user-account", session_id: "session" }) }, user: "user", safety_identifier: "device", prompt_cache_key: "laptop" }));
  assert.deepEqual(JSON.parse(modelRequestIdentity(body, "acme", null, "count-tokens")!.toString()), { messages });
});

test("malformed bodies stay malformed for the normal request validator", () => {
  for (const text of ["not-json", "null", "[]", '"string"']) {
    const body = Buffer.from(text);
    assert.equal(modelRequestIdentity(body, "acme", null, "anthropic"), body);
  }
  assert.equal(modelRequestIdentity(null, "acme", null, "anthropic"), null);
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
  assert.deepEqual(modelRequestHeaders(incoming, { authorization: "Bearer upstream" }), {
    authorization: "Bearer upstream", "user-agent": GATEWAY_USER_AGENT,
    "anthropic-beta": "some-beta", "content-type": "application/json", accept: "text/event-stream",
  });
  assert.equal(modelRequestHeaders({})["user-agent"], GATEWAY_USER_AGENT);
});
