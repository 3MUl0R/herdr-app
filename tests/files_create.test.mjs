import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Herdr loads this first-party file as a mod module, not a Node package.
const source = await readFile(new URL("../defaults/mods/files/create.js", import.meta.url), "utf8");
const { createEntry, validateNewName, windowsPath, childPath } =
  await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

test("validates safe file and directory names", () => {
  assert.equal(validateNewName(".env", true), null);
  assert.equal(validateNewName("settings.local.json", false), null);
  for (const name of ["", ".", "..", "../secret", "a/b", "a\\b", "bad\nfile"]) {
    assert.ok(validateNewName(name), name);
  }
  for (const name of ["CON", "NUL.txt", "bad:", "trailing.", "PRN"]) {
    assert.ok(validateNewName(name, true), name);
  }
});

test("detects Windows and Unix paths without depending on viewer OS", () => {
  assert.ok(windowsPath("C:\\Users\\Dev"));
  assert.ok(!windowsPath("/srv/project"));
  assert.equal(childPath("C:\\project\\", ".env"), "C:\\project/.env");
});

test("uses no-clobber private creation on SSH Unix hosts", async () => {
  const calls = [];
  const path = await createEntry({
    exec: async (...args) => { calls.push(args); return { code: 0 }; },
    on: "linux", parent: "/repo", name: ".env", kind: "file",
  });
  assert.equal(path, "/repo/.env");
  assert.equal(calls[0][0], "sh");
  assert.match(calls[0][1][1], /umask 077/);
  assert.match(calls[0][1][1], /set -C/);
  assert.equal(calls[0][1][3], "/repo/.env");
  assert.deepEqual(calls[0][2], { on: "linux" });
});

test("uses PowerShell for Windows target paths, and quotes filenames", async () => {
  const calls = [];
  await createEntry({
    exec: async (...args) => { calls.push(args); return { code: 0 }; },
    on: "windows", parent: "C:\\repo", name: "it's.env", kind: "file",
  });
  assert.equal(calls[0][0], "powershell");
  assert.match(calls[0][1][3], /it''s\\.env/);
  assert.match(calls[0][1][3], /CreateNew/);
});

test("falls back to PowerShell only when Unix shell is unavailable", async () => {
  const calls = [];
  await createEntry({
    exec: async (...args) => {
      calls.push(args);
      if (args[0] === "sh") throw new Error("cannot start sh: program not found");
      return { code: 0 };
    },
    on: "windows", parent: "/remote/project", name: "config", kind: "folder",
  });
  assert.deepEqual(calls.map((a) => a[0]), ["sh", "powershell"]);
  await assert.rejects(createEntry({
    exec: async () => ({ code: 1, stderr: "File exists" }),
    on: "linux", parent: "/repo", name: ".env", kind: "file",
  }), /File exists/);
});

test("never interpolates shell metacharacters into commands", async () => {
  const calls = [];
  await createEntry({
    exec: async (...args) => { calls.push(args); return { code: 0 }; },
    on: "mac", parent: "/repo", name: "$(touch injected).txt", kind: "file",
  });
  assert.ok(!calls[0][1][1].includes("injected"));
  assert.match(calls[0][1][3], /touch injected/);
});
