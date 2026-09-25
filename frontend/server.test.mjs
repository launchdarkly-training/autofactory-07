/**
 * Flag-path tests for "enable-backend-status".
 *
 * Every case drives a real LaunchDarkly client backed by TestData so the
 * string-variation evaluation is exercised for real, not stubbed away.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { init, integrations } from "@launchdarkly/node-server-sdk";

import {
  createApp,
  renderPage,
  BACKEND_STATUS_FLAG,
  BEACON_PATH,
} from "./server.mjs";

const SHA = process.env.RAILWAY_GIT_COMMIT_SHA || "dev";
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8000";

/**
 * The page exactly as the base branch rendered it, before this change. The
 * control variation must keep producing this byte for byte.
 */
const BASELINE_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Auto-Factory Demo</title></head>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto">
  <h1>LaunchDarkly Auto-Factory — Demo</h1>
  <p>Frontend deployed SHA: <code>${SHA}</code></p>
  <p id="greeting">Loading greeting from backend…</p>
  <script>
    fetch("${BACKEND_URL}/api/greeting")
      .then(r => r.json())
      .then(d => { document.getElementById("greeting").textContent =
        d.greeting + "  (new-greeting flag: " + d.flag_new_greeting + ")"; })
      .catch(() => { document.getElementById("greeting").textContent = "backend unavailable"; });
  </script>
</body></html>`;

async function ldClientServing(variationValue) {
  const td = new integrations.TestData();
  td.update(
    td
      .flag(BACKEND_STATUS_FLAG)
      .variations("control", "v1", "v2")
      .variationForAll(["control", "v1", "v2"].indexOf(variationValue)),
  );
  const client = init("sdk-key-unused-by-testdata", {
    updateProcessor: td.getFactory(),
    sendEvents: false,
    diagnosticOptOut: true,
  });
  await client.waitForInitialization({ timeout: 5 });
  return client;
}

/** Runs `fn` against a live app, recording every track() the request emits. */
async function withApp(ldClient, fn) {
  const tracked = [];
  if (ldClient) {
    const original = ldClient.track.bind(ldClient);
    ldClient.track = (key, context, data, metricValue) => {
      tracked.push({ key, contextKey: context?.key, metricValue });
      return original(key, context, data, metricValue);
    };
  }

  const server = createApp({ ldClient }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://localhost:${server.address().port}`;

  try {
    return await fn({ base, tracked });
  } finally {
    server.close();
    if (ldClient) await ldClient.close();
  }
}

test("control renders the page exactly as the base branch did", async () => {
  const client = await ldClientServing("control");
  await withApp(client, async ({ base }) => {
    const body = await (await fetch(`${base}/`)).text();
    assert.equal(body, BASELINE_PAGE);
  });
});

test("v1 adds the backend status line and its status fetch", async () => {
  const client = await ldClientServing("v1");
  await withApp(client, async ({ base }) => {
    const body = await (await fetch(`${base}/`)).text();
    assert.match(body, /<p id="backend-status">Checking backend status…<\/p>/);
    assert.ok(body.includes(`fetch("${BACKEND_URL}/api/status")`));
    assert.match(body, /"Backend online: " \+ d\.service \+ " version " \+ d\.version/);
    assert.match(body, /"Backend offline"/);
  });
});

test("v1 keeps everything the control page already rendered", async () => {
  const client = await ldClientServing("v1");
  await withApp(client, async ({ base }) => {
    const body = await (await fetch(`${base}/`)).text();
    for (const line of BASELINE_PAGE.split("\n")) {
      assert.ok(body.includes(line), `v1 page dropped baseline line: ${line}`);
    }
  });
});

test("an unrecognized variation falls back to control", async () => {
  const client = await ldClientServing("v2");
  await withApp(client, async ({ base }) => {
    const body = await (await fetch(`${base}/`)).text();
    assert.equal(body, BASELINE_PAGE);
  });
});

test("no LaunchDarkly client means control", async () => {
  await withApp(null, async ({ base }) => {
    const body = await (await fetch(`${base}/`)).text();
    assert.equal(body, BASELINE_PAGE);
  });
});

test("a failing flag evaluation falls back to control", async () => {
  const broken = {
    variation: async () => {
      throw new Error("LaunchDarkly unreachable");
    },
    track: () => {},
    close: async () => {},
  };
  await withApp(broken, async ({ base }) => {
    const body = await (await fetch(`${base}/`)).text();
    assert.equal(body, BASELINE_PAGE);
  });
});

test("a successful status check tracks the success and latency events", async () => {
  const client = await ldClientServing("v1");
  await withApp(client, async ({ base, tracked }) => {
    const res = await fetch(`${base}${BEACON_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, durationMs: 42 }),
    });

    assert.equal(res.status, 204);
    assert.deepEqual(
      tracked.map((t) => t.key),
      ["enable-backend-status-success", "enable-backend-status-latency"],
    );
    assert.equal(tracked[1].metricValue, 42);
    assert.ok(tracked.every((t) => t.contextKey === "demo-user"));
  });
});

test("a failed status check tracks the error and latency events", async () => {
  const client = await ldClientServing("v1");
  await withApp(client, async ({ base, tracked }) => {
    const res = await fetch(`${base}${BEACON_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, durationMs: 1830 }),
    });

    assert.equal(res.status, 204);
    assert.deepEqual(
      tracked.map((t) => t.key),
      ["enable-backend-status-error", "enable-backend-status-latency"],
    );
    assert.equal(tracked[1].metricValue, 1830);
  });
});

test("a beacon without a usable duration skips the latency event", async () => {
  const client = await ldClientServing("v1");
  await withApp(client, async ({ base, tracked }) => {
    const res = await fetch(`${base}${BEACON_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });

    assert.equal(res.status, 204);
    assert.deepEqual(tracked.map((t) => t.key), ["enable-backend-status-success"]);
  });
});

test("a tracking failure never fails the beacon request", async () => {
  const brokenTrack = {
    variation: async () => "v1",
    track: () => {
      throw new Error("event processor exploded");
    },
    close: async () => {},
  };
  await withApp(brokenTrack, async ({ base }) => {
    const res = await fetch(`${base}${BEACON_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, durationMs: 5 }),
    });
    assert.equal(res.status, 204);
  });
});

test("the status contract is unaffected by the flag", async () => {
  for (const value of ["control", "v1"]) {
    const client = await ldClientServing(value);
    await withApp(client, async ({ base }) => {
      const body = await (await fetch(`${base}/api/status`)).json();
      assert.deepEqual(body, { service: "demo-frontend", version: SHA });
    });
  }
});

test("renderPage is pure with respect to the flag decision", () => {
  assert.equal(renderPage({ showBackendStatus: false }), BASELINE_PAGE);
  assert.notEqual(renderPage({ showBackendStatus: true }), BASELINE_PAGE);
});
