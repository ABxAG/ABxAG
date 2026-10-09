import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const serverSource = readFileSync(path.join(root, "server.ts"), "utf8");
const appSource = readFileSync(path.join(root, "src", "App.tsx"), "utf8");
const registrySource = readFileSync(path.join(root, "desktop_agent", "registry.py"), "utf8");

test("only the Windows default-browser tool family is exposed", () => {
  for (const removedTool of [
    "browserOpen",
    "browserSearch",
    "browserClick",
    "browserMediaControl",
    "browserTabAction",
    "desktopBrowser",
  ]) {
    assert.equal(serverSource.includes(removedTool), false, `${removedTool} remains in server.ts`);
    assert.equal(registrySource.includes(removedTool), false, `${removedTool} remains in registry.py`);
  }

  for (const realPcTool of ["openWebsite", "searchYouTube", "viewScreen", "clickText", "typeText"]) {
    assert.equal(serverSource.includes(`name: "${realPcTool}"`), true, `${realPcTool} is missing`);
  }
});

test("the renderer has no embedded browser component", () => {
  assert.equal(appSource.includes("BrowserAgent"), false);
  assert.equal(appSource.includes("activeProjectorUrl"), false);
  assert.equal(existsSync(path.join(root, "src", "components", "BrowserAgent.tsx")), false);
  assert.equal(existsSync(path.join(root, "local-agent.js")), false);
  assert.equal(existsSync(path.join(root, "desktop_agent", "tools_browser.py")), false);
});
