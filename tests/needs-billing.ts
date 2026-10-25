// For a test of what foldrun's billing does (a charge, a balance, a price):
// skipped on a checkout without billing, where billing() answers
// freeBilling and nothing is charged. Pass as `{ skip: needsBilling }`.

import { billing, freeBilling } from "../src/billing.ts";

export const needsBilling: string | false = billing() === freeBilling ? "needs foldrun's billing (foldrun-admin)" : false;
