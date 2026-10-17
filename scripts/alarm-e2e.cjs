/**
 * End-to-end alarm check against a real backend instance.
 *
 * Verifies the exact chain the user reported broken, without needing the LLM
 * or the GUI: POST /api/utilities -> UtilityScheduler timer -> appEvents
 * publish -> /events WebSocket frame. Run against a throwaway port and data
 * dir so it can never touch the user's running ABxAG.
 *
 *   ABxAG_PORT=47999 ABxAG_DATA_DIR=<tmp> node scripts/alarm-e2e.cjs
 */
const BASE = `http://127.0.0.1:${process.env.ABxAG_PORT || 47999}`;

async function main() {
  const { WebSocket } = require("ws");

  // 1. Watch /events for the ring.
  const frames = [];
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/events`);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  });
  console.log("events socket: open");

  // 2. Schedule a short timer exactly like the setAlarm tool does.
  const created = await fetch(`${BASE}/api/utilities`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "timer", label: "e2e probe", inSeconds: 2 }),
  }).then((r) => r.json());
  console.log("created:", created.kind, `"${created.label}"`, "due in", Math.round((created.dueAt - Date.now()) / 1000) + "s");

  if (!created.id || !Number.isFinite(created.dueAt)) throw new Error("scheduler did not return a real alarm");

  // 3. It must show up in the upcoming list.
  const listed = await fetch(`${BASE}/api/utilities`).then((r) => r.json());
  if (!listed.some((u) => u.id === created.id)) throw new Error("new alarm is not in GET /api/utilities");
  console.log("listed while scheduled: yes");

  // 4. Wait for the ring.
  const deadline = Date.now() + 15_000;
  let fired;
  while (Date.now() < deadline) {
    fired = frames.find((f) => f.type === "utility.fired" && f.payload?.id === created.id);
    if (fired) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!fired) throw new Error("no utility.fired frame arrived within 15s — the ring never reached the UI");
  console.log("ringed over /events:", fired.payload.kind, `"${fired.payload.label}"`, "missed =", fired.payload.missed);

  // 5. Snooze it, and confirm it left the ring and came back later.
  await fetch(`${BASE}/api/utilities/${created.id}/snooze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ minutes: 5 }),
  }).then((r) => r.json());
  const afterSnooze = (await fetch(`${BASE}/api/utilities`).then((r) => r.json())).find((u) => u.id === created.id);
  const inFiveMin = Math.round((afterSnooze.dueAt - Date.now()) / 60_000);
  if (inFiveMin !== 5) throw new Error(`snooze did not re-arm 5 minutes out (got ${inFiveMin} min)`);
  console.log("snoozed to:", new Date(afterSnooze.dueAt).toLocaleTimeString());

  // 6. Cancel it and confirm it is gone.
  await fetch(`${BASE}/api/utilities/${created.id}`, { method: "DELETE" }).then((r) => r.json());
  const final = await fetch(`${BASE}/api/utilities`).then((r) => r.json());
  if (final.some((u) => u.id === created.id)) throw new Error("cancel did not remove the alarm");
  console.log("cancelled: gone from the list");

  ws.close();
  console.log("\nPASS - alarms schedule, ring, snooze and cancel end to end.");
}

main().catch((err) => {
  console.error("\nFAIL -", err.message);
  process.exit(1);
});