// The hosted boundary, first (FOL-121). Imported FIRST by each hosted entry
// point — worker.ts, egress.ts, assistant-worker.ts, gateway.ts — so it is evaluated
// before any module that might print: from here on this process's stdout
// and stderr carry only the lines core src/ops-log.ts builds from shaped
// fields, never an account's prompts, replies, files, tool arguments or
// error text (those stay in the run's own trace).
//
// Only when the entry point IS the process: a test that imports egress.ts
// for one function is not a hosted pod and keeps its console.

import path from "node:path";
import { installOpsBoundary } from "../../foldrun-core/src/ops-log.ts";

// gateway.ts too (12 Nov 2026): it became its own process on 10 Nov and
// imported this file without being listed, so its stdout was outside the
// boundary — readable lines the ops store's agent rightly refused.
const ENTRIES = new Set(["worker.ts", "egress.ts", "assistant-worker.ts", "gateway.ts"]);
const main = process.argv[1] ? path.basename(path.resolve(process.argv[1])) : "";
if (ENTRIES.has(main)) installOpsBoundary({ exitOnUncaught: true });
