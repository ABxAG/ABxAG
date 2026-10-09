import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CognitiveRuntime, type CognitiveEventInput } from "../cognition";

const defaultEvent: CognitiveEventInput = {
  type: "filesystem.file_delete_requested",
  source: "simulation",
  importance: 0.98,
  confidence: 0.95,
  projectId: "ABxAG",
  metadata: {
    path: "F:/ABxAG TO 3D/abxag-ai-assistant",
    risk: 0.99,
    urgency: 0.96,
    relevance: 0.98,
    reason: "possible accidental deletion of the active ABxAG project",
  },
};

async function main() {
  const supplied = process.argv[2];
  const input = supplied ? JSON.parse(supplied) as CognitiveEventInput : defaultEvent;
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "abxag-cognition-sim-"));
  try {
    const runtime = new CognitiveRuntime({ dataDir, projectRoot: process.cwd() });
    await runtime.initialize();
    const outcome = await runtime.process(input);
    process.stdout.write(`${JSON.stringify({
      event: outcome.event,
      situation: outcome.situation,
      attention: outcome.attention,
      initiative: outcome.decision,
      confirmationRequired: outcome.attention.factors.risk >= 0.8,
    }, null, 2)}\n`);
    await runtime.shutdown();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

