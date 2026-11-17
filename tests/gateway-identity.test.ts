import { test } from "node:test";
import assert from "node:assert/strict";
import { GATEWAY_USER_AGENT, modelRequestHeaders, modelRequestIdentity } from "../src/gateway-identity.ts";

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
  assert.deepEqual(modelRequestHeaders(incoming, { authorization: "Bearer upstream" }), {
    authorization: "Bearer upstream", "user-agent": GATEWAY_USER_AGENT,
    "anthropic-beta": "some-beta", "content-type": "application/json", accept: "text/event-stream",
  });
  assert.equal(modelRequestHeaders({})["user-agent"], GATEWAY_USER_AGENT);
});
