import { test } from "node:test";
import assert from "node:assert/strict";
import { createRepo, headId, isAncestor, reachable, resolve, run, runAll, tokenize } from "../src/git.js";
import { layout } from "../src/layout.js";
import { LEVELS, goalStatus, isComplete } from "../src/levels.js";

const exec = (s, ...cmds) => cmds.reduce((st, c) => run(st, c).state, s);

test("tokenize keeps quoted messages together", () => {
  assert.deepEqual(tokenize('git commit -m "add login page"'), ["git", "commit", "-m", "add login page"]);
  assert.deepEqual(tokenize("git commit -m 'x y'"), ["git", "commit", "-m", "x y"]);
});

test("commit adds a child of HEAD and moves the branch", () => {
  const s0 = createRepo();
  const r = run(s0, 'git commit -m "First"');
  assert.equal(r.ok, true);
  assert.equal(r.state.branches.main, "C1");
  assert.deepEqual(r.state.commits.C1.parents, ["C0"]);
  assert.equal(r.state.commits.C1.message, "First");
  assert.equal(s0.branches.main, "C0", "input state is not mutated");
  assert.equal(run(r.state, "git commit -m two words").state.commits.C2.message, "two words");
  assert.equal(run(r.state, "commit").state.commits.C2.message, "Commit C2", "git prefix optional, default message");
});

test("branch, switch and checkout -b", () => {
  let s = exec(createRepo(), "git branch feature");
  assert.equal(s.branches.feature, "C0");
  assert.equal(s.head.branch, "main");
  assert.equal(run(s, "git branch feature").ok, false, "duplicate branch");
  assert.equal(run(s, "git branch -bad").ok, false);
  s = exec(s, "git switch feature", "git commit -m A");
  assert.equal(s.branches.feature, "C1");
  assert.equal(s.branches.main, "C0");
  s = exec(s, "git checkout -b other main");
  assert.equal(s.head.branch, "other");
  assert.equal(s.branches.other, "C0");
  assert.equal(run(s, "git switch nope").ok, false);
});

test("checking out a commit detaches HEAD", () => {
  const s = exec(createRepo(), "git commit -m A", "git commit -m B", "git checkout C1");
  assert.deepEqual(s.head, { detached: "C1" });
  const after = exec(s, "git commit -m detached");
  assert.equal(after.head.detached, "C3");
  assert.equal(after.branches.main, "C2");
});

test("resolve handles HEAD, ~n, ^n, tags and case", () => {
  const s = exec(createRepo(), "git commit -m A", "git commit -m B", "git tag v1 C1");
  assert.equal(resolve(s, "HEAD"), "C2");
  assert.equal(resolve(s, "HEAD~1"), "C1");
  assert.equal(resolve(s, "main~2"), "C0");
  assert.equal(resolve(s, "HEAD^"), "C1");
  assert.equal(resolve(s, "HEAD~5"), null);
  assert.equal(resolve(s, "v1"), "C1");
  assert.equal(resolve(s, "c2"), "C2");
  assert.equal(resolve(s, "nope"), null);
});

test("merge: fast-forward, merge commit, already up to date", () => {
  let s = exec(createRepo(), "git switch -c f", "git commit -m A", "git switch main");
  let r = run(s, "git merge f");
  assert.equal(r.state.branches.main, "C1");
  assert.ok(r.explain.startsWith("Fast-forward"));
  assert.equal(run(r.state, "git merge f").lines[0].text, "Already up to date.");

  s = exec(s, "git commit -m B");
  r = run(s, "git merge f");
  const m = r.state.branches.main;
  assert.deepEqual(r.state.commits[m].parents, ["C2", "C1"]);
  assert.equal(r.state.commits[m].message, "Merge branch 'f' into main");

  r = run(exec(createRepo(), "git switch -c f", "git commit -m A", "git switch main"), "git merge --no-ff f");
  assert.equal(r.state.commits[r.state.branches.main].parents.length, 2);
});

test("rebase replays commits as copies and leaves originals unreachable", () => {
  const s = exec(createRepo(), "git switch -c f", "git commit -m A", "git commit -m B", "git switch main", "git commit -m M", "git switch f");
  const r = run(s, "git rebase main");
  const f = r.state.branches.f;
  assert.equal(f, "C2'");
  assert.deepEqual(r.state.commits["C2'"].parents, ["C1'"]);
  assert.deepEqual(r.state.commits["C1'"].parents, ["C3"]);
  assert.ok(isAncestor(r.state, "C3", f));
  const live = reachable(r.state);
  assert.ok(!live.has("C1") && !live.has("C2"));
  assert.equal(run(r.state, "git rebase main").lines[0].text, "Current branch f is up to date.");
});

test("rebase skips commits already cherry-picked upstream", () => {
  const s = exec(createRepo(), "git switch -c f", "git commit -m A", "git commit -m B", "git switch main", "git cherry-pick C1", "git switch f");
  const r = run(s, "git rebase main");
  assert.deepEqual(r.state.commits[r.state.branches.f].parents, ["C1'"], "only B is replayed on top of the cherry-picked A");
});

test("reset, revert, cherry-pick, tag and branch delete", () => {
  let s = exec(createRepo(), "git commit -m A", "git commit -m B");
  s = exec(s, "git reset --hard HEAD~1");
  assert.equal(s.branches.main, "C1");
  assert.ok(!reachable(s).has("C2"));

  s = exec(s, "git revert C1");
  assert.equal(s.commits[s.branches.main].message, 'Revert "A"');

  s = exec(s, "git switch -c side C0", "git commit -m X", "git switch main");
  assert.equal(run(s, "git branch -d side").ok, false, "unmerged branch needs -D");
  assert.equal(run(s, "git branch -d main").ok, false, "can't delete current branch");
  s = exec(s, "git cherry-pick side");
  assert.equal(s.commits[s.branches.main].message, "X");
  assert.equal(run(s, "git cherry-pick C1").ok, false, "already in history");
  s = exec(s, "git tag v1", "git branch -D side");
  assert.equal(s.tags.v1, s.branches.main);
  assert.equal(s.branches.side, undefined);
});

test("unknown and non-simulated commands give helpful messages", () => {
  const s = createRepo();
  const r = run(s, "git comit -m x");
  assert.equal(r.ok, false);
  assert.match(r.lines[0].text, /Did you mean 'commit'/);
  assert.match(run(s, "git push").lines[0].text, /Remotes aren't simulated/);
  assert.equal(run(s, "git add .").state, s);
});

test("layout puts branches in their own rows and stacks labels", () => {
  const s = exec(createRepo(), "git commit -m A", "git switch -c f", "git commit -m B", "git branch g");
  const l = layout(s);
  const byId = Object.fromEntries(l.nodes.map((n) => [n.id, n]));
  assert.equal(byId.C0.y, byId.C1.y);
  assert.ok(byId.C2.y > byId.C1.y, "feature commit is in a lower row");
  assert.ok(byId.C2.x > byId.C1.x);
  assert.deepEqual(byId.C2.labels.map((x) => x.text), ["f", "g"], "current branch first");
  assert.equal(byId.C2.labels[0].current, true);
  assert.equal(l.edges.length, 2);
  assert.ok(l.width > 0 && l.height > 0);
  const detached = layout(exec(s, "git checkout C0"));
  assert.ok(detached.nodes.find((n) => n.id === "C0").labels.some((x) => x.kind === "head"));
});

test("every lesson starts incomplete and its solution completes it", () => {
  for (const level of LEVELS) {
    const start = runAll(createRepo(), level.setup);
    assert.equal(isComplete(level, start), false, `${level.id} starts incomplete`);
    let s = start;
    for (const cmd of level.solution) {
      const r = run(s, cmd);
      assert.equal(r.ok, true, `${level.id}: "${cmd}" should work`);
      s = r.state;
    }
    assert.deepEqual(goalStatus(level, s), level.goals.map(() => true), `${level.id} solution completes every goal`);
  }
});

test("merging instead of rebasing does not pass the rebase lesson", () => {
  const level = LEVELS.find((l) => l.id === "rebase");
  const s = runAll(runAll(createRepo(), level.setup), ["git merge feature"]);
  assert.equal(isComplete(level, s), false);
});

test("headId follows the current branch", () => {
  assert.equal(headId(exec(createRepo(), "git commit -m A")), "C1");
});
