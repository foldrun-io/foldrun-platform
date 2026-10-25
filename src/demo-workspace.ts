// The demo workspace: a working pipeline you can watch, one click after
// signing up.
//
// It is a sanitised copy of the first real pipeline built on this platform
// (NSW conveyancer leads): extract → enrich in parallel with verify → an
// approval gate → upload. Every step is real — real agents, a real script
// tool, a real gate — and nothing external: the "CRM" is a script that
// validates and reports instead of POSTing, the source list is a knowledge
// file, and the whole run costs cents. Watching it teaches the grammar
// faster than any page describing it.

import type { DeployFile } from "../../foldrun-core/src/store.ts";

export const DEMO_WORKSPACE = "demo-pipeline";

export function demoWorkspaceFiles(): DeployFile[] {
  return [
    {
      path: "AGENTS.md",
      content: `---
name: ${DEMO_WORKSPACE}
description: A working demo — extract leads from the knowledge file, enrich and verify in parallel, then an approval gate before a pretend CRM import.
budget: 5
---

This workspace is safe to play in: the crm-upload tool here only VALIDATES
and reports — it never sends anything anywhere. The budget: line caps the
month at $5 so experiments cannot run away.

Delete this workspace freely; the "New workspace → demo" button recreates it.
`,
    },
    {
      path: "knowledge/sample-firms.md",
      content: `---
type: Reference
---

# Sample firms (fictional)

| firm | suburb | phone | email |
|---|---|---|---|
| Harbour Conveyancing | Manly | 02 9977 1001 | info@harbourconv.example |
| Southern Settlements | Wollongong | 4225 3002 | hello@southernsett.example |
| Westfield Property Law | Penrith | 02 4731 9003 | office@wpl.example |
| Clearline Conveyancers | Newcastle | 4951 4004 | team@clearline.example |
| Coastal Transfers | Kiama | 0412 345 005 | mail@coastaltransfers.example |

All names, numbers and addresses are invented; every domain is .example,
which can never resolve.
`,
    },
    {
      path: "agents/extractor/agent.md",
      content: `---
name: extractor
description: Reads the sample firm list and writes it as a CSV.
tools: [write]
---

Read \`workspace/knowledge/sample-firms.md\` and write the firms as
\`workspace/storage/leads.csv\` with the header:

    firm,suburb,phone,email

One row per firm, values exactly as the table has them. Then reply with how
many rows you wrote.
`,
    },
    {
      path: "agents/enricher/agent.md",
      content: `---
name: enricher
description: Normalises phone numbers to E.164 in the extracted CSV.
tools: [write]
---

Read \`workspace/storage/leads.csv\`. Rewrite the phone column into E.164
(+61…): a leading 04 is a mobile, a leading 02 is a Sydney landline, an
8-digit number with no area code takes 2 for NSW coastal suburbs. Write the
result to \`workspace/storage/leads-enriched.csv\` and reply with what you changed.
`,
    },
    {
      path: "agents/checker/agent.md",
      content: `---
name: checker
description: Flags rows whose email domain is obviously undeliverable.
tools: [write]
---

Read \`workspace/storage/leads.csv\`. Every address here ends in .example, which
never resolves — flag each row accordingly. Write
\`workspace/storage/leads-checked.md\` listing every email and the verdict
"undeliverable (.example)". Reply with the counts. This mirrors what a real
bounce-checking step does with live domains.
`,
    },
    {
      path: "agents/uploader/agent.md",
      content: `---
name: uploader
description: Runs the pretend CRM import and reports its summary.
tools: [crm-upload]
---

Call the crm-upload tool ONCE with csv=workspace/storage/leads-enriched.csv.
Report its summary verbatim, and say clearly that nothing left this
workspace — the tool validates and reports, it does not send.
`,
    },
    {
      path: "tools/crm-upload.md",
      content: `---
transport: script
name: crm-upload
description: A pretend CRM import — validates the CSV and reports what a real import WOULD do. Sends nothing, anywhere.
args:
  csv: The CSV to "import" (e.g. workspace/storage/leads-enriched.csv)
timeout: 120
---

The demo's stand-in for a real CRM importer. Same shape as the real thing —
parse, dedupe by email, summarise — with the network call replaced by a
report. Copy this file and add the fetch to make it real.

\`\`\`js
import fs from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { csv: { type: "string" } } });
if (!values.csv) { console.error("need --csv"); process.exit(1); }

const lines = fs.readFileSync(values.csv, "utf8").trim().split("\\n");
const header = lines[0].split(",");
const emailAt = header.indexOf("e" + "mail");
const seen = new Set();
let dupes = 0;
for (const line of lines.slice(1)) {
  const email = (line.split(",")[emailAt] ?? "").trim().toLowerCase();
  if (!email) continue;
  if (seen.has(email)) dupes += 1;
  else seen.add(email);
}
console.log(\`DRY IMPORT (demo — nothing was sent):\`);
console.log(\`  rows: \${lines.length - 1}\`);
console.log(\`  unique contacts: \${seen.size}\`);
console.log(\`  in-batch duplicates: \${dupes}\`);
console.log(\`  would import as: run \${process.env.FOLDRUN_RUN_ID ?? "?"} on \${process.env.FOLDRUN_DATE ?? "?"}\`);
\`\`\`
`,
    },
    {
      path: "flows/extract-and-import.md",
      content: `---
name: extract-and-import
description: The demo pipeline — extract, enrich and check in parallel, approve, pretend-import.
trigger: manual
overlap: skip
---

1. [[extractor]] — write the sample firms to workspace/storage/leads.csv
   verify: file: workspace/storage/leads.csv
2. [[enricher]] — normalise the phone numbers to E.164
   verify: file: workspace/storage/leads-enriched.csv
2. [[checker]] — flag undeliverable email domains
   verify: file: workspace/storage/leads-checked.md
3! [[uploader]] — run the pretend CRM import and report the summary
   preview: workspace/storage/leads-enriched.csv
   timeout: 300
`,
    },
  ];
}
