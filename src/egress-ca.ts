// The egress CA: what the proxy's forward door signs with when it opens a
// TLS connection to a site a secret is bound to, so it can fill `${NAME}` in
// that request's headers (egress-proxy.ts). Every other site is a tunnel the
// proxy never reads, and is never signed for.
//
// The CA is DERIVED, not stored: its P-256 key comes from the install key
// through HKDF, and its serial and dates are fixed, so every worker and
// every egress pod computes the same certificate with nothing written
// anywhere — no table, no file, no race on first use — and rotating the
// install key rotates the CA with everything else that hangs off it. A
// sandbox is handed the certificate (never the key) per step, in its lease.
//
// The certificates are built here in plain DER: node:crypto signs and
// parses X.509 but does not issue it, and the libraries that do bring a
// dependency tree for what is two fixed shapes. Both shapes carry what a
// strict verifier asks for (Python 3.13's VERIFY_X509_STRICT, OpenSSL 3):
// key usage, basic constraints, subject and authority key identifiers, and
// a subjectAltName on the leaf.

import crypto from "node:crypto";
import net from "node:net";
import { installKeyMaterial } from "../../foldrun-core/src/secrets.ts";

// ------------------------------------------------------------------ DER

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
const set = (...parts: Buffer[]) => tlv(0x31, ...parts);
function integer(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a + b];
  for (let v of rest) {
    const chunk = [v & 0x7f];
    for (v >>= 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, "utf8"));
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octets = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), b]));
function time(d: Date): Buffer {
  const iso = d.toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHMMSS
  // UTCTime through 2049, GeneralizedTime after — RFC 5280 §4.1.2.5.
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${iso}Z`));
}

const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const name = (cn: string) => seq(set(seq(oid("2.5.4.10"), utf8("foldrun"))), set(seq(oid("2.5.4.3"), utf8(cn))));
const extension = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

/** The key identifier RFC 5280 §4.2.1.2 method 1 gives: SHA-1 of the
 *  subjectPublicKey bits — for P-256 the 65-byte point that ends the SPKI. */
function keyId(spki: Buffer): Buffer {
  return crypto.createHash("sha1").update(spki.subarray(spki.length - 65)).digest();
}

function issue(args: {
  serial: Buffer;
  issuer: string;
  subject: string;
  notBefore: Date;
  notAfter: Date;
  spki: Buffer;
  issuerSpki: Buffer;
  extensions: Buffer[];
  signer: crypto.KeyObject;
}): string {
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(args.serial),
    ECDSA_SHA256,
    name(args.issuer),
    seq(time(args.notBefore), time(args.notAfter)),
    name(args.subject),
    args.spki,
    tlv(0xa3, seq(
      ...args.extensions,
      extension("2.5.29.14", false, octets(keyId(args.spki))), // subjectKeyIdentifier
      extension("2.5.29.35", false, seq(tlv(0x80, keyId(args.issuerSpki)))), // authorityKeyIdentifier
    )),
  );
  const signature = crypto.sign("sha256", tbs, args.signer); // DER ECDSA for an EC key
  const der = seq(tbs, ECDSA_SHA256, bits(signature));
  return `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n?$/, "\n")}-----END CERTIFICATE-----\n`;
}

// ------------------------------------------------------------------- CA

const CA_NAME = "foldrun egress CA";
// Fixed, so the derivation is the same everywhere. Twenty years: the CA is
// replaced by rotating the install key, not by expiring.
const CA_NOT_BEFORE = new Date("2026-01-01T00:00:00Z");
const CA_NOT_AFTER = new Date("2046-01-01T00:00:00Z");

interface Ca {
  key: crypto.KeyObject;
  spki: Buffer;
  pem: string;
}

let cached: { material: string; ca: Ca } | null = null;

/** P-256 private scalar → a key object. ECDH computes the public point,
 *  which a JWK needs beside the scalar. Throws on a scalar outside [1, n). */
function p256(d: Buffer): crypto.KeyObject {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey(); // 0x04 || x || y
  return crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: d.toString("base64url"), x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33, 65).toString("base64url") },
    format: "jwk",
  });
}

const derive = (material: string, info: string, length: number) =>
  Buffer.from(crypto.hkdfSync("sha256", Buffer.from(material, "utf8"), Buffer.from("foldrun egress ca"), Buffer.from(info), length));

/** The install's egress CA. Pure in the install key: the same on every
 *  process that holds it. */
export function egressCa(): Ca {
  const material = installKeyMaterial();
  if (cached?.material === material) return cached.ca;
  let key: crypto.KeyObject | null = null;
  // A scalar of zero or ≥ the group order is a 2^-32 event; the next
  // counter is the next deterministic try.
  for (let i = 0; !key; i++) {
    try {
      key = p256(derive(material, `key v1/${i}`, 32));
    } catch {
      if (i > 8) throw new Error("egress CA: could not derive a P-256 key from the install key");
    }
  }
  const spki = crypto.createPublicKey(key).export({ type: "spki", format: "der" });
  const serial = derive(material, "serial v1", 16);
  serial[0] &= 0x7f;
  const pem = issue({
    serial,
    issuer: CA_NAME,
    subject: CA_NAME,
    notBefore: CA_NOT_BEFORE,
    notAfter: CA_NOT_AFTER,
    spki,
    issuerSpki: spki,
    signer: key,
    extensions: [
      extension("2.5.29.19", true, seq(bool(true))), // basicConstraints: CA
      extension("2.5.29.15", true, bits(Buffer.from([0x06]), 1)), // keyUsage: keyCertSign, cRLSign
    ],
  });
  const ca = { key, spki, pem };
  cached = { material, ca };
  return ca;
}

/** The certificate a sandbox trusts, PEM. */
export function egressCaPem(): string {
  return egressCa().pem;
}

// ----------------------------------------------------------------- leaves

/** One key for every leaf this process signs: a leaf is only ever shown to
 *  the sandbox it was made for, and the key never leaves this process. */
let leafKey: { key: crypto.KeyObject; spki: Buffer } | null = null;
const leaves = new Map<string, { cert: string; key: string; expires: number }>();
const LEAF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** A certificate for `host`, signed by the egress CA, with its key, both PEM.
 *  Cached per host until a day before it expires. */
export function leafFor(host: string, now = Date.now()): { cert: string; key: string } {
  const h = host.toLowerCase();
  const hit = leaves.get(h);
  if (hit && hit.expires - now > 24 * 60 * 60 * 1000) return hit;
  if (!leafKey) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    leafKey = { key: privateKey, spki: publicKey.export({ type: "spki", format: "der" }) };
  }
  const ca = egressCa();
  const ip = net.isIP(h);
  const san = ip === 4
    ? tlv(0x87, Buffer.from(h.split(".").map(Number)))
    : tlv(0x82, Buffer.from(h, "ascii"));
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const notBefore = new Date(now - 60 * 60 * 1000); // an hour of clock skew
  const notAfter = new Date(now + LEAF_LIFE_MS);
  const cert = issue({
    serial,
    issuer: CA_NAME,
    subject: h,
    notBefore,
    notAfter,
    spki: leafKey.spki,
    issuerSpki: ca.spki,
    signer: ca.key,
    extensions: [
      extension("2.5.29.19", true, seq()), // basicConstraints: not a CA
      extension("2.5.29.15", true, bits(Buffer.from([0x80]), 7)), // keyUsage: digitalSignature
      extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))), // extKeyUsage: serverAuth
      extension("2.5.29.17", false, seq(san)), // subjectAltName
    ],
  });
  const entry = { cert, key: leafKey.key.export({ type: "pkcs8", format: "pem" }).toString(), expires: notAfter.getTime() };
  leaves.set(h, entry);
  return entry;
}
