// Where the gallery copy lives (12 Nov 2026, a FOL-126 gap): node-local
// scratch in Kubernetes, the data root anywhere else.
//
//   node --test tests/gallery-root.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { galleryRootFor } from "../src/index.ts";

test("in Kubernetes the gallery is the pod's own, off the shared disk; elsewhere it stays under the data root", () => {
  assert.equal(galleryRootFor({ KUBERNETES_SERVICE_HOST: "10.43.0.1" } as NodeJS.ProcessEnv, () => "/data"), path.join(os.tmpdir(), "foldrun-gallery"));
  assert.equal(galleryRootFor({} as NodeJS.ProcessEnv, () => "/data"), "/data/gallery", "Compose and a laptop: run containers mount host paths");
});
