// FOL-145 phase C (light): what the egress proxy does with a request to a
// browser vendor's API when a step's vendor browser is held to its list.
//
// The vendor's key is bound to the vendor's API host, so it never enters the
// sandbox: the egress proxy fills it, which means every call to the vendor
// passes through the proxy, opened (egress-proxy.ts intercepts a bound host).
// Here, per vendor, one call at a time:
//
//   - the call that STARTS a browser is rewritten so its only proxy is
//     foldrun's vendor door, with a credential minted for this session
//     (vendor-egress-credentials.ts) — whatever proxy the agent asked for is
//     dropped;
//   - the calls that only read or end a session (status, live view, release,
//     a saved-login profile) pass;
//   - anything else is refused: a new endpoint must be added here, on
//     purpose, before an agent can use it.
//
// The endpoints are those web browse calls (gallery.ts web/browse.mjs,
// vendorPlan, checked against each vendor's docs on 29 Sep 2026), and the
// proxy fields are the ones it already sends for a customer's own proxy.
// Pure: the proxy does the I/O.

export interface VendorDoor {
  /** The door's address as the vendor should reach it, e.g.
   *  https://vendor-egress.example.com:8443 */
  server: string;
}

export interface MintedCredential {
  username: string;
  password: string;
}

export type VendorPolicyResult =
  | { action: "pass" }
  | { action: "rewrite"; url: string; body?: Buffer }
  | { action: "refuse"; reason: string };

/** The vendor a host belongs to, among those that take a customer proxy. */
export function vendorForHost(host: string): "browserbase" | "steel" | "hyperbrowser" | "browserless" | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "api.browserbase.com") return "browserbase";
  if (h === "api.steel.dev" || h === "connect.steel.dev") return "steel";
  if (h === "api.hyperbrowser.ai") return "hyperbrowser";
  if (/^production-[a-z]+\.browserless\.io$/.test(h)) return "browserless";
  return null;
}

/** The door with the credential in it, as a proxy URL. */
export function doorUrl(door: VendorDoor, c: MintedCredential): string {
  const u = new URL(door.server);
  u.username = c.username;
  u.password = c.password;
  return u.toString().replace(/\/$/, "");
}

function json(body: Buffer | null): Record<string, unknown> | null {
  if (!body || !body.length) return {};
  try {
    const v = JSON.parse(body.toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const refuse = (reason: string): VendorPolicyResult => ({ action: "refuse", reason: `vendor browser held to network: — ${reason}` });

/**
 * One request to a vendor's API, from a step whose vendor browser is held:
 * pass it, rewrite it, or refuse it. `mint` is called only for a call that
 * starts a browser.
 */
export function enforceVendorRequest(
  r: { method: string; url: string; body: Buffer | null; upgrade?: boolean },
  door: VendorDoor,
  mint: () => MintedCredential,
  /** Was this session started through this rule (its id seen in a rewritten
   *  start's answer)? Without it, only the id's presence is checked. */
  knownSession?: (vendor: string, id: string) => boolean,
): VendorPolicyResult {
  let u: URL;
  try {
    u = new URL(r.url);
  } catch {
    return refuse("a request foldrun could not read");
  }
  const vendor = vendorForHost(u.hostname);
  if (!vendor) return refuse(`${u.hostname} is not a vendor this door serves`);
  const m = r.method.toUpperCase();
  const p = u.pathname.replace(/\/+$/, "") || "/";
  const seg = p.split("/").filter(Boolean);
  const id = (s: string | undefined) => !!s && /^[A-Za-z0-9_-]{1,128}$/.test(s);

  switch (vendor) {
    case "browserbase": {
      if (m === "POST" && p === "/v1/sessions") {
        const body = json(r.body);
        if (!body) return refuse("a session request that is not a JSON object");
        const c = mint();
        // The door is the only proxy; whatever the agent asked for goes.
        body.proxies = [{ type: "external", server: new URL(door.server).origin, username: c.username, password: c.password }];
        return { action: "rewrite", url: u.toString(), body: Buffer.from(JSON.stringify(body)) };
      }
      if (m === "POST" && p === "/v1/contexts") return { action: "pass" }; // a saved-login profile; starts no browser
      if (m === "GET" && seg[0] === "v1" && seg[1] === "sessions" && id(seg[2]) && (seg.length === 3 || (seg.length === 4 && seg[3] === "debug"))) return { action: "pass" };
      if (m === "POST" && seg[0] === "v1" && seg[1] === "sessions" && id(seg[2]) && seg.length === 3) {
        // Only a release: Browserbase ends a session with {status: "REQUEST_RELEASE"}.
        const body = json(r.body);
        return body && body.status === "REQUEST_RELEASE" && Object.keys(body).every((k) => k === "status" || k === "projectId") ? { action: "pass" } : refuse("only a release may update a session");
      }
      return refuse(`${m} ${p} is not a call this door allows to Browserbase`);
    }
    case "steel": {
      if (u.hostname === "connect.steel.dev") {
        // The browser's own connection to a session already made through the
        // API. Without a sessionId Steel starts a NEW session with its own
        // defaults — no door (Codex review) — so one is required, it must be
        // one started here, and nothing else may ride on the address.
        if (!r.upgrade) return refuse("connect.steel.dev takes the session's websocket only");
        const sid = u.searchParams.get("sessionId");
        if (!id(sid ?? undefined)) return refuse("a Steel connection must name a session started through foldrun");
        if (knownSession && !knownSession("steel", sid!)) return refuse("that Steel session was not started through foldrun's door");
        if ([...u.searchParams.keys()].some((k) => k !== "apiKey" && k !== "sessionId")) return refuse("only apiKey and sessionId may be on a Steel connection");
        return { action: "pass" };
      }
      if (m === "POST" && p === "/v1/sessions") {
        const body = json(r.body);
        if (!body) return refuse("a session request that is not a JSON object");
        delete body.useProxy;
        body.proxyUrl = doorUrl(door, mint());
        return { action: "rewrite", url: u.toString(), body: Buffer.from(JSON.stringify(body)) };
      }
      if (m === "POST" && seg[0] === "v1" && seg[1] === "sessions" && id(seg[2]) && seg[3] === "release" && seg.length === 4) return { action: "pass" };
      if (m === "GET" && seg[0] === "v1" && seg[1] === "sessions" && id(seg[2]) && seg.length === 3) return { action: "pass" };
      return refuse(`${m} ${p} is not a call this door allows to Steel`);
    }
    case "hyperbrowser": {
      if (m === "POST" && p === "/api/session") {
        const body = json(r.body);
        if (!body) return refuse("a session request that is not a JSON object");
        for (const k of ["proxyCountry", "proxyState", "proxyCity", "useProxy", "proxyServer", "proxyServerUsername", "proxyServerPassword"]) delete body[k];
        const c = mint();
        Object.assign(body, { useProxy: true, proxyServer: new URL(door.server).origin, proxyServerUsername: c.username, proxyServerPassword: c.password });
        return { action: "rewrite", url: u.toString(), body: Buffer.from(JSON.stringify(body)) };
      }
      if (m === "PUT" && seg[0] === "api" && seg[1] === "session" && id(seg[2]) && seg[3] === "stop" && seg.length === 4) return { action: "pass" };
      if (m === "GET" && seg[0] === "api" && seg[1] === "session" && id(seg[2]) && seg.length === 3) return { action: "pass" };
      if ((m === "POST" || m === "GET") && p === "/api/profile") return { action: "pass" }; // a saved-login profile; starts no browser
      return refuse(`${m} ${p} is not a call this door allows to Hyperbrowser`);
    }
    case "browserless": {
      // Everything is a query parameter on the connect address; only the
      // browser's websocket connection is allowed (Browserless's REST APIs
      // would load pages without the door), on the two routes web browse
      // uses, with the parameters it sends and nothing else: a `launch`
      // option can carry --proxy-bypass-list=* and skip the door entirely
      // (Codex review), so what is not known to be safe is refused.
      if (!(m === "GET" && r.upgrade)) return refuse("only the browser's websocket connection is allowed to Browserless");
      if (p !== "/chromium" && p !== "/stealth") return refuse(`${p} is not a Browserless route this door allows (/chromium, /stealth)`);
      const allowed = new Set(["token", "solveCaptchas", "blockAds", "timeout", "proxy", "proxyCountry", "proxyCity", "externalProxyServer"]);
      const extra = [...u.searchParams.keys()].filter((k) => !allowed.has(k));
      if (extra.length) return refuse(`Browserless option${extra.length > 1 ? "s" : ""} ${[...new Set(extra)].join(", ")} not allowed under a held list (launch arguments could skip the door)`);
      for (const k of ["proxy", "proxyCountry", "proxyCity", "externalProxyServer"]) u.searchParams.delete(k);
      u.searchParams.set("externalProxyServer", doorUrl(door, mint()));
      return { action: "rewrite", url: u.toString() };
    }
  }
}
