/**
 * Demo frontend (Node / Express). Serves a tiny page and the status contract.
 *   GET /api/status -> { service, version }   (version = deployed SHA)
 *   GET /          -> a page that fetches the backend greeting
 *
 * The backend-status line on the page is gated by the multivariate flag
 * "enable-backend-status": "control" renders the page exactly as before,
 * "v1" adds the status line. LaunchDarkly is optional — without LD_SDK_KEY
 * (or if LaunchDarkly is unreachable) evaluation falls back to "control",
 * mirroring the backend's graceful degradation.
 */

import express from "express";
import { pathToFileURL } from "node:url";
import { init } from "@launchdarkly/node-server-sdk";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";
const SDK_KEY = process.env.LD_SDK_KEY;

export const BACKEND_STATUS_FLAG = "enable-backend-status";

let _ldClient;

function defaultLdClient() {
  if (_ldClient !== undefined) return _ldClient;
  _ldClient = null;
  if (SDK_KEY) {
    try {
      _ldClient = init(SDK_KEY);
    } catch {
      _ldClient = null;
    }
  }
  return _ldClient;
}

function ldContext() {
  return { kind: "user", key: "demo-user" };
}

/**
 * Read a string variation. AutoFactory flags are multivariate strings compared
 * exactly, so anything other than a usable string degrades to "control".
 */
async function variation(client, key, defaultValue = "control") {
  if (!client) return defaultValue;
  try {
    const value = await client.variation(key, ldContext(), defaultValue);
    return typeof value === "string" ? value : defaultValue;
  } catch {
    return defaultValue;
  }
}

export function renderPage({ showBackendStatus }) {
  const backendStatusMarkup = showBackendStatus
    ? `\n  <p id="backend-status">Checking backend status…</p>`
    : "";

  const backendStatusScript = showBackendStatus
    ? `
    fetch("${BACKEND_URL}/api/status")
      .then(r => r.json())
      .then(d => { document.getElementById("backend-status").textContent =
        "Backend online: " + d.service + " version " + d.version; })
      .catch(() => { document.getElementById("backend-status").textContent = "Backend offline"; });`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${SHA}</code></p>
  <p id="greeting">Loading greeting from backend…</p>${backendStatusMarkup}
  <script>
    fetch("${BACKEND_URL}/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });${backendStatusScript}
  </script>
</body></html>`;
}

export function createApp({ ldClient = defaultLdClient() } = {}) {
  const app = express();

  app.get("/api/status", (_req, res) => {
    res.json({ service: "demo-frontend", version: SHA });
  });

  app.get("/", async (_req, res) => {
    const showBackendStatus =
      (await variation(ldClient, BACKEND_STATUS_FLAG)) === "v1";
    res.type("html").send(renderPage({ showBackendStatus }));
  });

  return app;
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`demo-frontend on :${port}`));
}
