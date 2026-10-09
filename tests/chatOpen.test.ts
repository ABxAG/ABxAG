import assert from "node:assert/strict";
import test from "node:test";
import { nameMatch } from "../agent/actions/chatOpen";

test("chat names match the person, tolerating small spelling slips", () => {
  assert.ok(nameMatch("Priya Sharmaa", "Priya Sharma Yesterday in Myra bol rahi hun.") > 0.55);
  assert.ok(nameMatch("PRIYA SHARMA", "Priya Sharma") === 1);
  assert.ok(nameMatch("papa", "Papa ❤️ 10:30 pm ok") > 0.9);
  // A group row or another person is not her chat.
  assert.equal(nameMatch("Priya Sharma", "Family group 12:02 pm Missed video call"), 0);
  assert.equal(nameMatch("Priya", "Shyam Verma Yesterday"), 0);
});

test("chat row titles drop the time and last message", async () => {
  const { rowTitle } = await import("../agent/actions/chatOpen");
  assert.equal(rowTitle("Priya Sharma Yesterday in Myra bol rahi hun."), "Priya Sharma");
  assert.equal(rowTitle("Papa 12:56 pm Missed voice call"), "Papa");
  assert.equal(rowTitle("Priya ke papa 16/08/2026 👌🏻"), "Priya ke papa");
});

test("kinship and respect words are not part of the saved name", async () => {
  const { withoutHonorifics, nameMatch } = await import("../agent/actions/chatOpen");
  assert.equal(withoutHonorifics("Priya Dii"), "Priya");
  assert.equal(withoutHonorifics("Rahul Bhaiya"), "Rahul");
  assert.equal(withoutHonorifics("Papa"), "Papa");
  assert.equal(withoutHonorifics("Priya Sharma"), "Priya Sharma");
  assert.ok(nameMatch(withoutHonorifics("Priya Dii"), "Priya Sharma") > 0.55);
});
