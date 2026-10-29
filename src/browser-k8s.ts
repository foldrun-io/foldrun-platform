// The account's own browser, as a pod that exists only while the account
// is browsing — the second instance of the account-pod mechanism
// (account-pod.ts holds the why and the shared mechanics; search-k8s.ts is
// the first).
//
// Until 2026-09-15 the gallery `browser` tool launched Chromium inside the
// run pod: a fresh process per call, dying with the step, its memory on the
// step's reservation. That stays the local path (the CLI, a compose
// install, and the fallback here). On a cluster the worker now starts one
// browser pod per account the first time a step that grants `browser` is
// about to run, hands the step its address as FOLDRUN_BROWSER_WS, keeps the
// pod while steps keep using it, and reaps it after an idle window — the
// search pod's lifecycle, for the browser.
//
// What is in the pod: a Playwright server (`playwright run-server`) on the
// RUNNER IMAGE. Not a browser-farm image, and not a bare Chromium speaking
// CDP, for three reasons that took a day to learn the first time round:
//
//   - The Playwright wire protocol is version-locked between client and
//     server. The run pod's client is the runner image's Playwright; the
//     one image that is guaranteed to carry the same version is the runner
//     image itself. FOLDRUN_BROWSER_IMAGE exists for a deliberate override
//     and defaults to FOLDRUN_RUNNER_IMAGE, so the two can never drift.
//   - A server launches a browser PER CONNECTION with the launch options
//     the client sends — so the tool's Chromium flags (the full build, not
//     the headless shell; AutomationControlled off — Medium's Cloudflare
//     403s the shell on every POST) and its proxy keep working exactly as
//     they did in-pod, and one run's crash never takes another's browser.
//     Over raw CDP those are process flags, fixed for every caller.
//   - Uploads, downloads, video, trace and screenshots cross the wire by
//     design of `browserType.connect` (files stream to the client). Over
//     CDP a download lands on the browser's own disk and an upload reads a
//     path that exists only on the client's.
//
// So FOLDRUN_BROWSER_WS is a ws:// endpoint the tool connects to with
// `chromium.connect(url, { headers: { "x-playwright-launch-options" } })`.
// Firefox and WebKit are served by the same pod. The server launches a
// browser per connection from the name the client connects with, so one
// rule covers all three: the browser runs in the account's pod, whichever
// engine was asked for. The split was worse than the duplication — when
// Medium broke on 2026-09-17, "did the pod do this?" could only be answered
// by running the same page through an engine that took a different path.
//
// Test runs get NO browser pod. The run namespace's deny-world policy
// selects the run pod; a browser pod the test run drove would fetch the
// world on its behalf and hand it back through the door the policy left
// open. Refusing the address is the airtight version: the tool falls back
// to in-pod Chromium, which the run policy already denies the internet,
// so a browser call in a test run fails closed like every other outward
// call (run-k8s.ts, accountServiceEnv).
//
//   FOLDRUN_BROWSER_PER_ACCOUNT=1    turn it on (k8s isolation only)
//   FOLDRUN_BROWSER_IMAGE            the image; defaults to FOLDRUN_RUNNER_IMAGE
//   FOLDRUN_BROWSER_IDLE_MS          delete after this long unused (15 min)
//   FOLDRUN_BROWSER_STEPS_PER_POD    steps one pod serves before the pool grows (2)
//   FOLDRUN_BROWSER_MAX_PODS         the pool's ceiling per account (4)
//   FOLDRUN_RUNNER_RUNTIME           the RuntimeClass, the same as run pods

import {
  ACCOUNT_LABEL,
  LAST_USED,
  deleteAccountPod,
  ensureAccountPod,
  namespace,
  podName,
  policyManifests,
  reapIdleAccountPods,
  serviceHost,
  serviceManifest,
  type AccountPodKind,
} from "./account-pod.ts";
import { settingText } from "./settings.ts";

export const BROWSER_APP = "foldrun-browser";
export const BROWSER_PORT = 3000;
/** The runner image's agent user: the browsers under /opt/browser are
 *  readable by it, and nothing in the pod needs to be root. */
const AGENT_UID = 10001;

/** The virtual screen a windowed (`headless: false`) browser draws on. */
const BROWSER_DISPLAY = ":99";
const idleMs = () => Number(process.env.FOLDRUN_BROWSER_IDLE_MS) || 15 * 60_000;
// The pool: a browser pod renders whole pages, and two steps browsing at
// once is what one 3Gi pod comfortably holds; a third step gets a second
// pod. Four pods is 12Gi of Chromium for one account, which is the ceiling
// until plans say otherwise.
const stepsPerPod = () => Number(process.env.FOLDRUN_BROWSER_STEPS_PER_POD) || 2;
const maxPods = () => Number(settingText("FOLDRUN_BROWSER_MAX_PODS")) || 4;

export function perAccountBrowserEnabled(): boolean {
  return process.env.FOLDRUN_BROWSER_PER_ACCOUNT === "1" && process.env.FOLDRUN_RUN_ISOLATION === "k8s";
}

/** The image the browser pod runs — the runner image unless told otherwise,
 *  so the client in the run pod and the server in this one are the same
 *  Playwright. Empty when neither is set; the executor refuses earlier. */
export const browserImage = () => process.env.FOLDRUN_BROWSER_IMAGE ?? process.env.FOLDRUN_RUNNER_IMAGE ?? "";

/** Seconds between a delete's SIGTERM and its SIGKILL (see the pod spec). */
export const BROWSER_GRACE_SECONDS = 2;

/**
 * The pod: the runner image, started as the Playwright server instead of
 * the step shim, as the agent user, with the same RuntimeClass a run pod
 * asks for. A default-size hold — Chromium is what a step's memory mostly
 * goes on when it browses, and that memory now sits here.
 */
export function browserPodManifest(seg: string, now = new Date(), name = browserName(seg)): object {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name,
      namespace: namespace(),
      labels: { app: BROWSER_APP, [ACCOUNT_LABEL]: seg },
      annotations: { [LAST_USED]: now.toISOString() },
    },
    spec: {
      restartPolicy: "Always",
      // Gone means gone within seconds. Playwright's server answers SIGTERM
      // by closing every browser it launched — and nothing else: it keeps
      // its port and launches fresh browsers for whoever connects, until
      // the kubelet's SIGKILL. With the default 30s grace a deleted pod
      // went on serving new sessions for half a minute (dev, 2026-10-01: two
      // calls rendered on it after the delete, then ECONNREFUSED), so a step
      // learnt the pod was gone ~40s late. There is nothing to drain — the
      // SIGTERM has already closed every session — so a short grace loses
      // nothing and the next call sees the loss in about two seconds.
      terminationGracePeriodSeconds: BROWSER_GRACE_SECONDS,
      // Model-directed pages render in here. The token would be a bearer
      // credential the API server accepts; the pod has no business with it.
      automountServiceAccountToken: false,
      ...(process.env.FOLDRUN_RUNNER_RUNTIME ? { runtimeClassName: process.env.FOLDRUN_RUNNER_RUNTIME } : {}),
      securityContext: {
        seccompProfile: { type: "RuntimeDefault" },
        runAsNonRoot: true,
        runAsUser: AGENT_UID,
        runAsGroup: AGENT_UID,
        fsGroup: AGENT_UID,
      },
      containers: [
        {
          name: "browser",
          image: browserImage(),
          imagePullPolicy: "IfNotPresent",
          // The runner image's entrypoint is the step shim (chown, drop,
          // driver); `command` replaces it. The server binds every
          // interface because the Service is how run pods reach it; the
          // NetworkPolicy is what decides who may. --unsafe lets the client's
          // launch options carry `args`: without it Playwright's server drops
          // them, and the tool's Chromium flags (no sandbox, dev-shm, GPU,
          // AutomationControlled) silently never applied in the pod.
          // A virtual screen (Xvfb, in the image already) starts first, so an
          // agent with `headless: false` gets a browser with a window; a
          // headless browser ignores it. A screen that fails to start costs
          // only the windowed calls, which then fail and say why.
          command: [
            "sh", "-c", `Xvfb ${BROWSER_DISPLAY} -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & exec "$@"`, "browser",
            "node", "/usr/local/lib/node_modules/playwright/cli.js", "run-server", "--unsafe",
            "--host", "0.0.0.0", "--port", String(BROWSER_PORT),
          ],
          env: [{ name: "HOME", value: "/tmp/home" }, { name: "DISPLAY", value: BROWSER_DISPLAY }],
          ports: [{ containerPort: BROWSER_PORT }],
          volumeMounts: [
            // Chromium's shared memory. The tool passes --disable-dev-shm-usage
            // too, but a browser that finds a real /dev/shm renders faster.
            { name: "shm", mountPath: "/dev/shm" },
            // Profiles, downloads in flight, video scratch: Playwright's
            // artifacts live under the tmpdir and die with the pod.
            { name: "tmp", mountPath: "/tmp" },
          ],
          resources: {
            requests: { cpu: "250m", memory: "512Mi", "ephemeral-storage": "512Mi" },
            limits: { cpu: "2", memory: "3Gi", "ephemeral-storage": "4Gi" },
          },
          readinessProbe: { tcpSocket: { port: BROWSER_PORT }, initialDelaySeconds: 2, periodSeconds: 3 },
          securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
        },
      ],
      volumes: [
        { name: "shm", emptyDir: { medium: "Memory", sizeLimit: "1Gi" } },
        { name: "tmp", emptyDir: {} },
      ],
    },
  };
}

export const BROWSER: AccountPodKind = {
  kind: "browser",
  app: BROWSER_APP,
  refusesTestRuns: true,
  port: BROWSER_PORT,
  enabled: perAccountBrowserEnabled,
  idleMs,
  podManifest: browserPodManifest,
  url: (seg) => `ws://${serviceHost(BROWSER, seg)}:${BROWSER_PORT}/`,
  stepsPerPod,
  maxPods,
};

export const browserName = (seg: string) => podName(BROWSER, seg);
export const browserWs = (seg: string) => BROWSER.url(seg);
export const browserServiceManifest = (seg: string) => serviceManifest(BROWSER, seg);
export const browserPolicyManifests = (seg: string) => policyManifests(BROWSER, seg);

/** The ws:// address a run pod of this account should connect its browser
 *  tool to; null when the cluster would not give a pod — and then the tool
 *  runs Chromium inside the step, as it always could. */
export const ensureBrowserPod = (tenant: string, log?: (line: string) => void, opts?: { pod?: string }) => ensureAccountPod(BROWSER, tenant, log, opts);

export const reapIdleBrowserPods = (tenantOf?: (seg: string) => string | null, busy?: Set<string> | null) => reapIdleAccountPods(BROWSER, tenantOf, busy);

export const deleteBrowserPod = (tenant: string) => deleteAccountPod(BROWSER, tenant);
