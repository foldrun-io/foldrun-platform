// The ORM, as the web package sees it.
//
// The platform owns the database: the pool, the schema, the migrations and
// the Drizzle instance over them. The web server writes queries too — for
// sessions, audit and people — and it must write them against the SAME
// Drizzle, not a second copy from its own node_modules: two copies disagree
// about every type and about `instanceof` at runtime. So web imports the
// operators from here, and never lists drizzle-orm as a dependency at all.

export { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";
export { orm, ormRequired, tx, databaseEnabled, databaseReady, type Db } from "./db.ts";
export * as schema from "./schema.ts";
export { auditLog, invites, ledger, queue, sessions, tenantKeys, users } from "./schema.ts";
