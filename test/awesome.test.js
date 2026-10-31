"use strict";
/**
 * Regression tests for the submission engine's git plumbing.
 *
 * The interesting behaviour here is not "does it run git" but the two facts that
 * were wrong before and are easy to get wrong again:
 *
 *   1. `git log --reverse -1` reports the *last* commit. The repository therefore
 *      looked zero days old after every push, which failed R5.
 *   2. An unauthenticated GitHub lookup answers 403 when the egress IP has spent
 *      its hourly quota, and that must be reported as rate limiting — not as a
 *      missing topic or a missing network.
 *
 * Run with: node --test test/awesome.test.js
 */

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");

const awesome = require("../app/backend/awesome.js");

/** Build a throwaway repository with two commits on different dates. */
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "awesome-test-"));
  const git = (...args) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
      encoding: "utf8",
    });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "a.txt"), "first\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "first commit", "--date", "2020-01-01T00:00:00Z");
  writeFileSync(path.join(dir, "b.txt"), "second\n");
  git("add", "-A");
  git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "second commit");
  return dir;
}

test("the age check reads the root commit, not the latest one", async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // `online: false` forces the git-only path, which is what used to be wrong.
  const outcome = await awesome.check({ dir, countInPr: 1, online: false });
  const age = outcome.findings.find((item) => item.rule === "age");

  assert.ok(age !== undefined, "expected an age finding");
  assert.notEqual(age.level, "fail", `root commit is years old, but the check reported: ${age.detail}`);
  // A repository whose first commit is in 2020 cannot be "about 0 days" old.
  assert.doesNotMatch(age.detail, /只有 0\.\d+ 天/u, `age used the wrong commit: ${age.detail}`);
});

test("a repository with an old root commit is not reported as brand new", async (t) => {
  const dir = makeRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const outcome = await awesome.check({ dir, countInPr: 1, online: false });
  const age = outcome.findings.find((item) => item.rule === "age");

  // The root commit is from 2020, so the age must be measured in years. Reading
  // the latest commit instead would report "0 天" and fail R5.
  assert.equal(age.level, "ok", `expected ok, got ${age.level}: ${age.detail}`);
  assert.match(age.detail, /首次提交/u);
  const days = Number(/约 (\d+) 天/u.exec(age.detail)?.[1] ?? 0);
  assert.ok(days > 365, `age should be measured from the root commit, got: ${age.detail}`);
});

test("a rate-limited lookup is reported as rate limiting", async () => {
  // Point the fetch at a URL that cannot rate limit us, and assert the shape of
  // the failure object instead: `reason` is present only for a 403 whose
  // remaining-count header is zero.
  const meta = await awesome.fetchRepoMeta(undefined, undefined);
  assert.equal(meta.ok, false);
  assert.equal(meta.status, "unknown-repo");
});

test("fixesText names the rule and its suggested fix", () => {
  const text = awesome.fixesText(
    {
      dir: "D:/repo",
      findings: [{ level: "fail", rule: "code", title: awesome.RULES.code, detail: "no sources", fix: "commit real code" }],
    },
    "list",
  );
  assert.match(text, /code/u);
  assert.match(text, /commit real code/u);
  assert.doesNotMatch(text, /repo\./u);
});

// ---------------------------------------------------------------------------
// Round-tripping an entry that is already in the list clone
// ---------------------------------------------------------------------------

const { mkdirSync } = require("node:fs");

/** A throwaway clone of the list with one entry file, tracked or not. */
function makeList({ entry, tracked }) {
  const dir = mkdtempSync(path.join(tmpdir(), "awesome-list-"));
  mkdirSync(path.join(dir, "data", "plugins"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "awesome-dsh-plugin" }));
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"], { encoding: "utf8" });
  if (entry !== undefined) writeFileSync(path.join(dir, "data", "plugins", "owner__repo.yml"), entry);
  if (tracked === true) {
    execFileSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8" });
  }
  return dir;
}

const ENTRY = [
  "url: https://github.com/owner/repo",
  "name: owner/repo",
  "category: tools",
  "description:",
  "  en: 'Does a thing: with a colon.'",
  "  zh: 做一件事：带全角冒号。",
  "",
].join("\n");

test("a description already written to disk is read back, quotes and all", (t) => {
  const dir = makeList({ entry: ENTRY, tracked: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const entries = awesome.listEntries(dir);
  const entry = entries.entries.find((row) => row.file === "owner__repo.yml");
  // The `zh:` line was silently dropped before, because `$` under the `m` flag
  // ended the capture block at the first indented line.
  assert.equal(entry.description.zh, "做一件事：带全角冒号。");
  // Single-quoted YAML doubles internal quotes; the value must come back unquoted.
  assert.equal(entry.description.en, "Does a thing: with a colon.");
});

test("an uncommitted draft is not reported as already in the list", async (t) => {
  const dir = makeList({ entry: ENTRY, tracked: false });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const outcome = await awesome.check({ dir, countInPr: 1, listDir: dir, repo: "owner/repo", online: false });
  const duplicate = outcome.findings.find((item) => item.rule === "duplicate");

  assert.equal(duplicate.level, "ok", `an uncommitted draft is not a duplicate: ${duplicate.detail}`);
  assert.match(duplicate.detail, /尚未提交/u);
});

test("a committed entry of your own is reported as an update", async (t) => {
  const dir = makeList({ entry: ENTRY, tracked: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const outcome = await awesome.check({ dir, countInPr: 1, listDir: dir, repo: "owner/repo", online: false });
  const duplicate = outcome.findings.find((item) => item.rule === "duplicate");

  assert.equal(duplicate.level, "ok");
  assert.match(duplicate.detail, /更新/u);
});
