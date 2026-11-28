// One login, several accounts: the store's two halves (src/people.ts, FOL-464).
//
//   node --test tests/people.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { expandPeople, collapsePeople, snapshotPeople, type Stored, type PersonLike } from "../src/people.ts";

type P = PersonLike & { email: string; hash: string; mfaSecret?: string | null; prefs?: Record<string, unknown> | null };

const ana = (): Stored<P> => ({
  id: "a1", email: "ana@x.test", tenant: "ana-co", hash: "h1", createdAt: "2026-01-01T00:00:00.000Z", owner: true, admission: "free",
  also: [
    { id: "m-shop", tenant: "shop", role: "viewer", workspaces: ["desk"], createdAt: "2026-03-01T00:00:00.000Z" },
    { id: "m-lab", tenant: "lab", role: "admin", createdAt: "2026-02-01T00:00:00.000Z" },
  ],
});
const bo = (): Stored<P> => ({ id: "b1", email: "bo@x.test", tenant: "shop", hash: "h2", createdAt: "2026-01-05T00:00:00.000Z", owner: true });

test("a person with no joined account is one record, unchanged, and round-trips", () => {
  const views = expandPeople([bo()]);
  assert.deepEqual(views, [bo()]);
  assert.deepEqual(collapsePeople(views, snapshotPeople(views)), [bo()]);
});

test("one record per account: the first account's rights never show on a joined one", () => {
  const views = expandPeople([ana(), bo()]);
  assert.deepEqual(views.map((v) => `${v.id}@${v.tenant}`), ["a1@ana-co", "a1@lab", "a1@shop", "b1@shop"]);
  const [home, lab, shop] = views;
  assert.equal(home.owner, true);
  assert.equal(home.joined, undefined);
  assert.equal(lab.owner, undefined, "the owner of ana-co is not the owner of lab");
  assert.equal(lab.role, "admin");
  assert.equal(lab.workspaces, undefined);
  assert.equal(shop.owner, undefined);
  assert.equal(shop.role, "viewer");
  assert.deepEqual(shop.workspaces, ["desk"]);
  // The earliest member of shop is bo: ana's record there is dated when she joined.
  assert.equal(shop.createdAt, "2026-03-01T00:00:00.000Z");
  assert.equal(shop.joined, "2026-03-01T00:00:00.000Z");
  assert.equal(shop.email, "ana@x.test");
  assert.equal(shop.hash, "h1");
  assert.equal(home.admission, "free");
  assert.equal(shop.admission, "invite", "a joined account was not opened by their sign-up");
});

test("unchanged, the list collapses to what was stored", () => {
  const stored = [ana(), bo()];
  const views = expandPeople(stored);
  const back = collapsePeople(views, snapshotPeople(views));
  assert.deepEqual(back[1], bo());
  assert.deepEqual(back[0].also?.map((m) => m.tenant), ["lab", "shop"]);
  assert.deepEqual({ ...back[0], also: undefined }, { ...ana(), also: undefined });
});

test("a role changed on a joined record changes that membership only", () => {
  const views = expandPeople([ana()]);
  const snap = snapshotPeople(views);
  views.find((v) => v.tenant === "shop")!.role = "editor";
  const [p] = collapsePeople(views, snap);
  assert.equal(p.owner, true);
  assert.equal(p.role, undefined);
  assert.equal(p.also!.find((m) => m.tenant === "shop")!.role, "editor");
  assert.equal(p.also!.find((m) => m.tenant === "lab")!.role, "admin");
});

test("a joined record spliced out ends that membership; the person and the rest stay", () => {
  const views = expandPeople([ana()]);
  const snap = snapshotPeople(views);
  views.splice(views.findIndex((v) => v.tenant === "shop"), 1);
  const [p] = collapsePeople(views, snap);
  assert.equal(p.tenant, "ana-co");
  assert.deepEqual(p.also!.map((m) => m.tenant), ["lab"]);
});

test("removed from the first account: the earliest joined one becomes the first, with ITS rights", () => {
  const views = expandPeople([ana()]);
  const snap = snapshotPeople(views);
  views.splice(views.findIndex((v) => v.tenant === "ana-co"), 1);
  const [p] = collapsePeople(views, snap);
  assert.equal(p.tenant, "lab");
  assert.equal(p.owner, undefined, "owning ana-co does not carry over");
  assert.equal(p.role, "admin");
  assert.equal(p.createdAt, "2026-02-01T00:00:00.000Z");
  assert.equal((p as { joined?: string }).joined, undefined);
  assert.deepEqual(p.also!.map((m) => m.tenant), ["shop"]);
  assert.equal(p.hash, "h1", "the login is the same one");
  assert.equal(p.admission, "invite", "what their own sign-up earned stays with the account they left");
});

test("every record gone: the person is gone", () => {
  const views = expandPeople([ana(), bo()]);
  const snap = snapshotPeople(views);
  const left = views.filter((v) => v.id !== "a1");
  assert.deepEqual(collapsePeople(left, snap), [bo()]);
});

test("a record pushed for a second account joins it", () => {
  const views = expandPeople([bo()]);
  const snap = snapshotPeople(views);
  views.push({ ...views[0], tenant: "lab", owner: undefined, role: "editor", createdAt: "2026-05-01T00:00:00.000Z", joined: "2026-05-01T00:00:00.000Z", membership: "m-new" });
  const [p] = collapsePeople(views, snap);
  assert.equal(p.tenant, "shop");
  assert.equal(p.owner, true);
  assert.deepEqual(p.also, [{ id: "m-new", tenant: "lab", role: "editor", createdAt: "2026-05-01T00:00:00.000Z" }]);
});

test("the person's own fields: changed on the first record, or on a joined one, they are the person's", () => {
  const a = expandPeople([ana()]);
  const sa = snapshotPeople(a);
  a[0].hash = "new";
  assert.equal(collapsePeople(a, sa)[0].hash, "new");

  const b = expandPeople([ana()]);
  const sb = snapshotPeople(b);
  const shop = b.find((v) => v.tenant === "shop")!;
  shop.hash = "from-shop";
  shop.mfaSecret = "sealed";
  const pb = collapsePeople(b, sb)[0];
  assert.equal(pb.hash, "from-shop", "a password set while working in a joined account is not lost");
  assert.equal(pb.mfaSecret, "sealed");

  // Both changed: the first record's wins.
  const c = expandPeople([ana()]);
  const sc = snapshotPeople(c);
  c[0].hash = "first";
  c.find((v) => v.tenant === "shop")!.hash = "joined";
  assert.equal(collapsePeople(c, sc)[0].hash, "first");
});

test("lists no caller should make are refused, not stored", () => {
  const views = expandPeople([bo()]);
  assert.throws(() => collapsePeople([...views, { ...views[0], tenant: "lab" }]), /two first accounts/);
  assert.throws(() => collapsePeople([...views, { ...views[0], joined: "2026-05-01T00:00:00.000Z" }]), /twice/);
});

test("a stored list that names an account twice shows it once", () => {
  const p = ana();
  p.also!.push({ tenant: "ana-co", role: "viewer", createdAt: "2026-04-01T00:00:00.000Z" }, { tenant: "lab", role: "viewer", createdAt: "2026-04-02T00:00:00.000Z" });
  const views = expandPeople([p]);
  assert.deepEqual(views.map((v) => v.tenant), ["ana-co", "lab", "shop"]);
  assert.equal(views[0].owner, true, "a stray row never replaces the first account's rights");
  assert.equal(views[1].role, "admin", "the earlier membership is the one");
});

test("each stay has its own id: the account they signed up into has none, a joined one carries its own, and a promoted one keeps it", () => {
  const views = expandPeople([ana()]);
  assert.equal(views[0].membership, undefined, "the first account, never left");
  assert.deepEqual(views.slice(1).map((v) => v.membership), ["m-lab", "m-shop"]);
  const snap = snapshotPeople(views);
  views.splice(0, 1); // removed from their first account
  const [p] = collapsePeople(views, snap);
  assert.equal(p.tenant, "lab");
  assert.equal(p.membership, "m-lab", "the stay is the same stay; it only became their first");
  assert.equal(expandPeople([p])[0].membership, "m-lab");
  // A joined record with no id is a caller's mistake.
  const b = expandPeople([bo()]);
  assert.throws(() => collapsePeople([...b, { ...b[0], tenant: "lab", joined: "2026-05-01T00:00:00.000Z" }]), /membership id/);
});
