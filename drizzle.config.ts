// drizzle-kit: turns a change to src/schema.ts into the next migration file.
//
//   npm run db:generate      write drizzle/NNNN_<name>.sql from the schema diff
//   npm run db:check         is the schema ahead of the migrations?
//
// The runner in src/db.ts applies drizzle/*.sql in name order at boot, under
// an advisory lock, recording each by name — drizzle-kit writes the files,
// the platform applies them. `push` is deliberately not offered: a schema
// change reaches production as a reviewed file, never as a diff applied
// from a laptop.

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
  // Only for `db:generate` diffs against a live database in development;
  // the runner never reads this.
  dbCredentials: { url: process.env.FOLDRUN_DATABASE_URL ?? "postgres://foldrun@localhost:5432/foldrun" },
  strict: true,
  verbose: true,
});
