---
transport: script
name: docs
run: run.mjs
# The one site its program calls. Granting the tool adds it to the step's
# network: list, so an agent on `trusted` reaches it without naming it.
network: [context7.com]
timeout: 120
description: >
  A library's or framework's CURRENT documentation and code examples, from
  Context7's index — not what the model remembers. action= picks one.
  search: a library name in (astro, next.js, tailwindcss, motion), the
  matching libraries out, each with its id (/withastro/docs), the versions
  indexed, and how well it is maintained.
  get: a library (an id from search, or a name — the best match is taken)
  and what you need to know about it in, the relevant passages and code
  examples out, newest first. version= pins one (16.2 or v16.2.9).
  Use it before writing code against any library whose API may have changed
  since the model was trained — a new major, a config file format, a CLI flag.
args:
  action: "search | get"
  library: "(search) The library's name, e.g. next.js · (get) Its id from search (/vercel/next.js), or its name — the best match is used"
  query: "(search, get) What you are doing with it, in a sentence: \"app router metadata and Open Graph images\". Ranks the results — be specific"
  version: "(get) Optional — a version to read, e.g. 16.2 or v16.2.9. Unset: the latest indexed. An exact version not indexed gets the closest, and the answer says so"
  count: "(search) How many libraries, 1-10 (default 5)"
  max_output: "(get) Optional — characters back, 2000-60000 (default 15000)"
  save: "(get) Optional — also write the whole answer to this file (a path under workspace/ or outputs/)"
---

The current docs of a library, so code is written against the API as it is
today. Two calls:

```
docs action=search library=astro query="i18n routing with a default locale"
docs action=get library=/withastro/docs query="i18n routing with a default locale" version=7
```

`get` alone also works with a name (`library=astro`); it searches first and
says which library it chose. Each answer starts with the library and
version it came from.

**Keys.** Without a key, Context7 serves a low, unpublished rate. An account
with many runs sets its own key: `foldrun secrets set CONTEXT7_API_KEY`,
then `foldrun secrets sites CONTEXT7_API_KEY context7.com` so the value never
enters a sandbox, and `secrets: [CONTEXT7_API_KEY]` on the agent. A refused
or exhausted key is reported as such, never retried silently.

**What it is not.** Not a web search (use `web`), and not the source of
truth for a library that is not indexed: when `search` finds nothing, read
the library's own docs site with `web action=fetch`.
