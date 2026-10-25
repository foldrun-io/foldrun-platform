// The runtime's tables and the gallery's wrappers describe the same APIs
// from two sides: providers.ts says which names `web: {search}` and
// `web: {fetch}` accept and which vault key each needs; the program is what
// actually calls them. They live in different repos and nothing joins them
// at build time, so this is the join — a name the runtime accepts that the
// wrapper cannot answer would fail only inside a run, as "names no API this
// tool knows".
import test from "node:test";
import assert from "node:assert/strict";
import { GALLERY } from "../src/gallery.ts";
import { SEARCH_APIS, FETCH_APIS, BROWSER_APIS, readSearchSettings, searchSettingsEnv } from "../../foldrun-core/src/providers.ts";

const web = GALLERY.find((t) => t.name === "web")!;
/** web's program for one action: web/search.mjs, web/fetch.mjs, web/browse.mjs. */
const wrapper = (action: string) => web.extra!.find((f) => f.file === `web/${action}.mjs`)!.content;

test("every search API the runtime accepts, web search can call, with the same key name and host", () => {
  const src = wrapper("search");
  for (const api of SEARCH_APIS) {
    assert.match(src, new RegExp(`\\b${api.name}: \\{`), `${api.name}: an adapter`);
    assert.ok(src.includes(api.secret), `${api.name}: reads ${api.secret}`);
    assert.ok(src.includes(api.host), `${api.name}: calls ${api.host}`);
  }
});

test("every fetch API the runtime accepts, web fetch can call, with the same key name, host and batch size", () => {
  const src = wrapper("fetch");
  for (const api of FETCH_APIS) {
    assert.match(src, new RegExp(`\\b${api.name}: \\{`), `${api.name}: an adapter`);
    assert.ok(src.includes(api.secret), `${api.name}: reads ${api.secret}`);
    assert.ok(src.includes(api.host), `${api.name}: calls ${api.host}`);
    assert.match(src, new RegExp(`${api.name}: \\{[^}]*batch: ${api.batch}\\b`), `${api.name}: batch ${api.batch}`);
  }
});

test("both wrappers send through the egress proxy and read the vault name the runner hands them", () => {
  for (const [name, env] of [["search", "FOLDRUN_WEB_SEARCH_SECRET"], ["fetch", "FOLDRUN_WEB_FETCH_SECRET"]] as const) {
    const src = wrapper(name);
    assert.ok(src.includes("FOLDRUN_EGRESS"), `${name}: proxy`);
    assert.ok(src.includes(env), `${name}: ${env}`);
  }
});

test("the one optional key is Jina's reader, and the wrapper treats it so", () => {
  assert.deepEqual(FETCH_APIS.filter((a) => a.secretOptional).map((a) => a.name), ["jina"]);
  assert.match(wrapper("fetch"), /apiKey\("JINA_API_KEY", true\)/);
  assert.equal(SEARCH_APIS.find((a) => a.name === "jina")!.secretOptional, undefined, "s.jina.ai refuses without a key");
});

test("every remote browser the runtime accepts, web browse can open, with the same key name", () => {
  const src = wrapper("browse");
  for (const b of BROWSER_APIS) {
    assert.match(src, new RegExp(`\\b${b.name}: \\{`), `${b.name}: a vendor entry`);
    assert.ok(src.includes(b.secret), `${b.name}: reads ${b.secret}`);
    // Browserless's host carries the region (session.region), sfo unless asked.
    const host = b.name === "browserless" ? "production-${s.region ?? \"sfo\"}.browserless.io" : b.host;
    assert.ok(src.includes(host), `${b.name}: reaches ${b.host}`);
  }
  assert.ok(src.includes("connectOverCDP"), "a vendor is reached over CDP, not Playwright's own protocol");
  assert.ok(src.includes("FOLDRUN_BROWSER_VENDOR") && src.includes("FOLDRUN_BROWSER_SECRET"), "the runner's two env names");
});

test("no locale is hardcoded: all three read the agent's language, and the search derives region from the tag", () => {
  for (const name of ["search", "fetch", "browse"]) {
    assert.ok(wrapper(name).includes("FOLDRUN_LANGUAGE"), `${name} reads FOLDRUN_LANGUAGE`);
  }
  const search = wrapper("search");
  assert.doesNotMatch(search, /"en-AU"|gl: "au"|hl: "en"|language_code: "en"/, "the country defaults are gone");
  assert.match(search, /const gl = tagM\?\.\[2\]/, "region comes from the tag");
  assert.match(search, /location_name: countryName\(gl\)/, "DataForSEO gets a country when the tag has one");
  assert.match(wrapper("fetch"), /"Accept-Language": acceptLanguage\(\)/);
  assert.match(wrapper("browse"), /else if \(process\.env\.FOLDRUN_LANGUAGE\) contextOptions\.locale/);
});

test("every web.search setting the runtime passes on, web search reads; and SearXNG gets every parameter", () => {
  const src = wrapper("search");
  const all = readSearchSettings({
    engines: ["bing"], exclude_engines: ["yandex"], categories: ["news"], safesearch: 1, time_range: "week",
    timeout: 5, plugins: ["calculator"], exclude_plugins: ["hash_plugin"], doi_resolver: "doi.org",
  });
  assert.equal(all.error, undefined);
  const env = Object.keys(searchSettingsEnv(all.settings));
  assert.equal(env.length, 9, "one env name per setting");
  for (const name of env) assert.ok(src.includes(`process.env.${name}`), `the wrapper reads ${name}`);
  // The request parameters SearXNG actually reads (searx/webadapter.py,
  // searx/preferences.py) — a renamed one would be dropped without a word.
  for (const param of ["engines", "categories", "safesearch", "time_range", "timeout_limit", "pageno", "disabled_plugins", "enabled_plugins", "doi_resolver"]) {
    assert.ok(src.includes(`"${param}"`), `the wrapper sends ${param}`);
  }
});
