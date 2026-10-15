import assert from "node:assert/strict";
import test from "node:test";
import { filterCommands, fuzzyScore, moveSelection, type CommandDef } from "../src/lib/commandPalette";

const COMMANDS: CommandDef[] = [
  { id: "studio", title: "Character Studio", keywords: ["character", "pose"], run() {} },
  { id: "keys", title: "API keys", keywords: ["settings", "ai", "gemini"], run() {} },
  { id: "share", title: "Share screen", keywords: ["screen", "vision"], run() {} },
  { id: "recalls", title: "Recalls", keywords: ["memory"], run() {} },
];

test("empty query keeps original order", () => {
  assert.deepEqual(filterCommands("   ", COMMANDS).map((c) => c.id), ["studio", "keys", "share", "recalls"]);
});

test("prefix and substring matches rank first", () => {
  assert.equal(filterCommands("char", COMMANDS)[0].id, "studio");
  assert.equal(filterCommands("screen", COMMANDS)[0].id, "share");
  assert.equal(filterCommands("api", COMMANDS)[0].id, "keys");
});

test("non-matching queries return nothing", () => {
  assert.deepEqual(filterCommands("zzz-top", COMMANDS), []);
});

test("matching is case-insensitive", () => {
  assert.equal(filterCommands("STUDIO", COMMANDS)[0].id, "studio");
});

test("fuzzyScore prefers consecutive runs over scattered letters", () => {
  const tight = fuzzyScore("abc", "xxabcxx");
  const loose = fuzzyScore("abc", "axbxc");
  assert.ok(tight > loose, `tight=${tight} loose=${loose}`);
});

test("fuzzyScore returns -1 when letters are missing", () => {
  assert.equal(fuzzyScore("xyz", "abc"), -1);
});

test("moveSelection wraps around both ends and handles empties", () => {
  assert.equal(moveSelection(0, 1, 4), 1);
  assert.equal(moveSelection(3, 1, 4), 0);
  assert.equal(moveSelection(0, -1, 4), 3);
  assert.equal(moveSelection(2, -5, 4), 1);
  assert.equal(moveSelection(0, 1, 0), -1);
});
