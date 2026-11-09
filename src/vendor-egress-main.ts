// The vendor egress door's process (FOL-145): `node src/vendor-egress-main.ts`
// in the worker image, as the egress proxy is (`src/egress.ts`). A separate
// Deployment, because it faces the internet and the egress proxy does not.
//
//   FOLDRUN_VENDOR_EGRESS_PORT        where it listens (default 8443)
//   FOLDRUN_VENDOR_EGRESS_TLS_CERT    a PEM certificate file, and
//   FOLDRUN_VENDOR_EGRESS_TLS_KEY     its key file: the door speaks TLS itself
//                                     (checked for a new certificate hourly)
//   FOLDRUN_VENDOR_EGRESS_PLAIN=1     no TLS here — only behind something that
//                                     ends TLS for it (an NLB TLS listener)
//   FOLDRUN_REDIS_URL                 credentials, revocations and caps shared
//                                     with the egress proxy (cache.ts)
//
// It refuses to start with neither TLS files nor PLAIN: a public proxy whose
// credentials crossed the internet in the clear is not one to run.

import fs from "node:fs";
import tls from "node:tls";
import type https from "node:https";
import { createVendorEgressServer } from "./vendor-egress.ts";
import { opsError, opsLog } from "../../foldrun-core/src/ops-log.ts";

const port = Number(process.env.FOLDRUN_VENDOR_EGRESS_PORT) || 8443;
const certFile = process.env.FOLDRUN_VENDOR_EGRESS_TLS_CERT;
const keyFile = process.env.FOLDRUN_VENDOR_EGRESS_TLS_KEY;
const plain = process.env.FOLDRUN_VENDOR_EGRESS_PLAIN === "1";

if (!plain && !(certFile && keyFile)) {
  opsError("vendor_egress.no_tls", new Error("set FOLDRUN_VENDOR_EGRESS_TLS_CERT and _KEY, or FOLDRUN_VENDOR_EGRESS_PLAIN=1 behind a TLS terminator — not starting"));
  process.exit(1);
}

const read = () => ({ cert: fs.readFileSync(certFile!), key: fs.readFileSync(keyFile!) });
const door = createVendorEgressServer({
  ...(plain ? {} : { tls: read() }),
  onEvent: (e) => {
    // Never the credential: the event carries its id, never the password.
    const fields = { vendor: e.vendor, host: e.host, port: e.port, reason: e.reason, bytes: e.bytes };
    if (e.kind === "refused") opsLog("info", "vendor_egress.refused", fields);
    else if (e.kind === "closed") opsLog("info", "vendor_egress.closed", fields);
  },
});

// A renewed certificate is picked up without a restart.
if (!plain) {
  let seen = fs.statSync(certFile!).mtimeMs;
  setInterval(() => {
    try {
      const m = fs.statSync(certFile!).mtimeMs;
      if (m === seen) return;
      seen = m;
      (door.server as https.Server).setSecureContext(read() as tls.SecureContextOptions);
      opsLog("info", "vendor_egress.certificate_reloaded", {});
    } catch {}
  }, 60 * 60 * 1000).unref();
}

door.server.listen(port, "0.0.0.0", () => opsLog("info", "vendor_egress.listening", { port, tls: !plain }));

const stop = () => { void door.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 10_000).unref(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
