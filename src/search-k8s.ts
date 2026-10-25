// The account's own search engine, as a pod that exists only while the
// account is searching — one instance of the account-pod mechanism
// (account-pod.ts holds the why and the shared mechanics).
//
// SearXNG began as one shared deployment (searxng.yaml): every account's
// queries through one process, its CPU and egress on nobody's bill. Since
// 2026-09-06 it is one pod per account in the run namespace, started by the
// worker the first time a step that grants `websearch` is about to run,
// kept while steps keep using it, and deleted after an idle window. Since
// 2026-09-15 that is the ONLY path: the shared deployment is scaled to zero
// and a step that cannot get its account's pod fails rather than searching
// through a process every account shares (run-k8s.ts, accountServiceEnv).
//
//   FOLDRUN_SEARCH_PER_ACCOUNT=1     turn it on (k8s isolation only)
//   FOLDRUN_SEARCH_IMAGE             the SearXNG image, by digest
//   FOLDRUN_SEARCH_IDLE_MS           delete after this long unused (15 min)
//   FOLDRUN_SEARCH_STEPS_PER_POD     steps one pod serves before the pool grows (8)
//   FOLDRUN_SEARCH_MAX_PODS          the pool's ceiling per account (3)
//   FOLDRUN_RUNNER_RUNTIME           the RuntimeClass, the same as run pods

import crypto from "node:crypto";
import {
  ACCOUNT_LABEL,
  LAST_USED,
  accountSegment,
  deleteAccountPod,
  ensureAccountPod,
  idleAccountPods,
  namespace,
  podName,
  policyManifests,
  reapIdleAccountPods,
  serviceHost,
  serviceManifest,
  type AccountPodInfo,
  type AccountPodKind,
} from "./account-pod.ts";

export { ACCOUNT_LABEL, accountSegment };

export const SEARCH_APP = "foldrun-search";
const SETTINGS_CONFIGMAP = "foldrun-search-settings";
const DEFAULT_IMAGE =
  "docker.io/searxng/searxng@sha256:b36af7984b87191b595bc5301418ed6432c047668a4547ab531a7439b816fac3"; // 2026.8.29

const idleMs = () => Number(process.env.FOLDRUN_SEARCH_IDLE_MS) || 15 * 60_000;
// The pool: a query is cheap and a search pod is small, so one serves many
// steps; the pool exists for an account that fans out.
const stepsPerPod = () => Number(process.env.FOLDRUN_SEARCH_STEPS_PER_POD) || 8;
const maxPods = () => Number(process.env.FOLDRUN_SEARCH_MAX_PODS) || 3;

export function perAccountSearchEnabled(): boolean {
  return process.env.FOLDRUN_SEARCH_PER_ACCOUNT === "1" && process.env.FOLDRUN_RUN_ISOLATION === "k8s";
}

// The same settings the shared deployment carried, so a query answers the
// same way whichever pod takes it. Kept here rather than in a manifest so
// the worker can create it in the run namespace on first use — a ConfigMap
// is namespaced, and the platform's own lives in `foldrun`.
export const SETTINGS_YML = `use_default_settings: true
general:
  instance_name: "foldrun search"
  debug: false
server:
  bind_address: "0.0.0.0"
  port: 8080
  secret_key: "replaced-by-env"
  limiter: false
  image_proxy: false
search:
  safe_search: 0
  autocomplete: ""
  default_lang: "en-AU"
  formats:
    - html
    - json
ui:
  static_use_hash: true
engines:
  # Measured from the box on 2026-09-15, each engine queried alone: DuckDuckGo,
  # Startpage and Google CSE refuse this box, and Brave answers the search
  # image's client about half the time. Yandex and Naver answered every query
  # with relevant Australian results. Bing returned unrelated pages, and the
  # small-web indexes (wiby, searchmysite) returned hobby blogs, so they stay
  # off: a junk engine puts bad links into every agent's results.
  - name: yandex
    disabled: false
  - name: naver
    disabled: false
`;

export function settingsConfigMap(): object {
  return {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: SETTINGS_CONFIGMAP, namespace: namespace(), labels: { app: SEARCH_APP } },
    data: { "settings.yml": SETTINGS_YML },
  };
}

/** The pod: the shared deployment's spec, labelled for one account. */
export function searchPodManifest(seg: string, now = new Date(), name = searchName(seg)): object {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: namespace(),
      labels: { app: SEARCH_APP, [ACCOUNT_LABEL]: seg },
      annotations: { [LAST_USED]: now.toISOString() },
    },
    spec: {
      restartPolicy: "Always",
      automountServiceAccountToken: false,
      // The same RuntimeClass a run pod and a browser pod ask for. SearXNG
      // fetches model-directed URLs, so it is the run's reach into the
      // world and belongs in the run's sandbox — and the RuntimeClass
      // carries the nodeSelector, so without it this pod landed on the
      // platform's own nodes on plain runc.
      ...(process.env.FOLDRUN_RUNNER_RUNTIME ? { runtimeClassName: process.env.FOLDRUN_RUNNER_RUNTIME } : {}),
      securityContext: {
        seccompProfile: { type: "RuntimeDefault" },
        runAsNonRoot: true,
        runAsUser: 977,
        runAsGroup: 977,
        fsGroup: 977,
      },
      containers: [
        {
          name: "searxng",
          image: process.env.FOLDRUN_SEARCH_IMAGE ?? DEFAULT_IMAGE,
          env: [
            { name: "SEARXNG_SETTINGS_PATH", value: "/etc/searxng/settings.yml" },
            { name: "SEARXNG_BASE_URL", value: `${searchUrl(seg)}/` },
            // The session-signing key. Per pod, never stored: nothing
            // signed by one pod is ever presented to another.
            { name: "SEARXNG_SECRET", value: crypto.randomBytes(32).toString("hex") },
          ],
          ports: [{ containerPort: 8080 }],
          volumeMounts: [
            { name: "settings", mountPath: "/etc/searxng/settings.yml", subPath: "settings.yml" },
            { name: "cache", mountPath: "/var/cache/searxng" },
            { name: "tmp", mountPath: "/tmp" },
          ],
          // The small reservation, and priced as one at reap time.
          resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { cpu: "1", memory: "768Mi" } },
          readinessProbe: { httpGet: { path: "/healthz", port: 8080 }, initialDelaySeconds: 3, periodSeconds: 5 },
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
        },
      ],
      volumes: [
        { name: "settings", configMap: { name: SETTINGS_CONFIGMAP } },
        { name: "cache", emptyDir: {} },
        { name: "tmp", emptyDir: {} },
      ],
    },
  };
}

export const SEARCH: AccountPodKind = {
  kind: "search",
  app: SEARCH_APP,
  port: 8080,
  enabled: perAccountSearchEnabled,
  idleMs,
  podManifest: searchPodManifest,
  extraObjects: () => [settingsConfigMap()],
  url: (seg) => `http://${serviceHost(SEARCH, seg)}:8080`,
  small: true,
  stepsPerPod,
  maxPods,
};

export const searchName = (seg: string) => podName(SEARCH, seg);
export const searchUrl = (seg: string) => SEARCH.url(seg);
export const searchServiceManifest = (seg: string) => serviceManifest(SEARCH, seg);
export const searchPolicyManifests = (seg: string) => policyManifests(SEARCH, seg);

/** The URL a run pod of this account should search at; null when the
 *  cluster would not give one — and then the step does not search. */
export const ensureSearchPod = (tenant: string, log?: (line: string) => void, opts?: { pod?: string }) => ensureAccountPod(SEARCH, tenant, log, opts);

export const idleSearchPods = (pods: AccountPodInfo[], busy: Set<string>, now = Date.now(), idle = idleMs()) =>
  idleAccountPods(pods, busy, now, idle);

export const reapIdleSearchPods = (tenantOf?: (seg: string) => string | null, busy?: Set<string> | null) => reapIdleAccountPods(SEARCH, tenantOf, busy);

export const deleteSearchPod = (tenant: string) => deleteAccountPod(SEARCH, tenant);
