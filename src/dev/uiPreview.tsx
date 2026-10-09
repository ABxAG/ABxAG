/**
 * Dev-only preview of the Task HUD and approval dialog with sample data
 * (open /ui-preview.html on the dev server). Not part of the production
 * build: vite only bundles index.html. Nothing here starts a real task;
 * buttons call the API with sample IDs, which the backend rejects.
 */
import { createRoot } from "react-dom/client";
import "../index.css";
import { TaskHud } from "../components/TaskHud";
import type { AppEventsState } from "../lib/useAppEvents";
import type { TaskView } from "../lib/appApi";

const now = Date.now();
const iso = (offsetSec: number) => new Date(now - offsetSec * 1000).toISOString();

const running: TaskView = {
  id: "preview-running",
  goal: "Open Notepad and write a shopping list with milk, eggs and bread",
  state: "running",
  origin: "voice",
  modelId: "gemini-3.5-flash",
  currentStatus: "Typing the list into Notepad",
  plan: {
    summary: "Open Notepad, type the list, leave it open",
    steps: [
      { text: "Open Notepad", status: "done" },
      { text: "Click into the editor", status: "done" },
      { text: "Type the three items", status: "active" },
      { text: "Check the text appeared", status: "pending" },
    ],
  },
  actions: [
    { id: "a1", step: 1, at: iso(40), tool: "app.launch", summary: "Opened Notepad", status: "ok", durationMs: 900, verified: true },
    { id: "a2", step: 2, at: iso(25), tool: "mouse.click", summary: "Clicked the text area", status: "ok", durationMs: 120, verified: true },
    { id: "a3", step: 3, at: iso(10), tool: "keyboard.type", summary: "Typed \"milk\"", status: "ok", durationMs: 300, verified: null },
  ],
  files: [],
  pendingQuestion: null,
  pendingConfirmation: null,
  startedAt: iso(48),
  updatedAt: iso(2),
};

const waiting: TaskView = {
  ...running,
  id: "preview-question",
  goal: "Send the report to Riya on WhatsApp",
  state: "waiting_user",
  currentStatus: "Two contacts are called Riya",
  plan: null,
  actions: [{ id: "b1", step: 1, at: iso(15), tool: "window.focus", summary: "Switched to WhatsApp", status: "ok", durationMs: 400, verified: true }],
  pendingQuestion: { id: "q1", text: "Which Riya should I send it to?", options: ["Riya Sharma", "Riya (College)"], askedAt: iso(5) },
  updatedAt: iso(1),
};

const events: AppEventsState = {
  connected: true,
  tasks: { [running.id]: running, [waiting.id]: waiting },
  confirmations: [{
    id: "preview-confirm",
    taskId: waiting.id,
    capability: "SEND_MESSAGE",
    title: "Send a WhatsApp message to Riya Sharma?",
    description: "ABxAG wants to send the file below. Messages can't be unsent.",
    details: { recipient: "Riya Sharma", app: "WhatsApp", attachment: "report-september.pdf" },
    createdAt: iso(3),
    expiresAt: new Date(now + 55_000).toISOString(),
    allowRemember: true,
  }],
  questions: {},
  selection: null,
  notices: [{ id: 1, kind: "fallback", text: "Switched to Gemini 3.5 Flash-Lite because Gemini 3.5 Flash failed.", at: now }],
  stopped: null,
};

const params = new URLSearchParams(location.search);
const withDialog = params.get("dialog") !== "0";

createRoot(document.getElementById("root")!).render(
  <div className="relative h-screen w-full overflow-hidden bg-[#020205] text-white">
    <div className="absolute left-10 top-8 text-sm font-semibold uppercase tracking-[0.4em] text-white/50">ABxAG · UI preview</div>
    <TaskHud events={withDialog ? events : { ...events, confirmations: [] }} showHud emergencyShortcut="Control+Alt+Shift+S" />
  </div>,
);


