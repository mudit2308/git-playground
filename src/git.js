// A tiny git simulator. It models commits, branches, tags and HEAD (no files),
// which is exactly what you need to understand how git's history works.
//
// Everything here is pure: run(state, input) returns a new state plus the
// terminal output and a plain-English explanation of what happened.

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export function createRepo() {
  return {
    commits: { C0: { id: "C0", message: "Initial commit", parents: [], lane: 0, seq: 0 } },
    nextSeq: 1,
    nextNum: 1,
    branches: { main: "C0" },
    tags: {},
    lanes: { main: 0 },
    nextLane: 1,
    head: { branch: "main" },
  };
}

const clone = (s) => JSON.parse(JSON.stringify(s));

export const headId = (s) => (s.head.branch ? s.branches[s.head.branch] : s.head.detached);
export const headLabel = (s) => s.head.branch || `detached at ${s.head.detached}`;

/** All commits reachable from `id` (including itself). */
export function ancestors(s, id) {
  const seen = new Set();
  const stack = [id];
  while (stack.length) {
    const c = stack.pop();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    stack.push(...s.commits[c].parents);
  }
  return seen;
}

/** Is `a` an ancestor of (or equal to) `b`? */
export const isAncestor = (s, a, b) => ancestors(s, b).has(a);

/** Commits reachable from any branch, tag or HEAD. The rest are "lost" (shown faded). */
export function reachable(s) {
  const all = new Set();
  for (const id of [...Object.values(s.branches), ...Object.values(s.tags), headId(s)]) for (const c of ancestors(s, id)) all.add(c);
  return all;
}

/** Original commit a copy (from rebase or cherry-pick) was made from. */
const originOf = (s, id) => s.commits[id].copyOf || id;

// ---------------------------------------------------------------------------
// Resolving refs: HEAD, branch, tag, commit id, with ~n and ^n
// ---------------------------------------------------------------------------

export function resolve(s, ref) {
  if (!ref) return null;
  const m = ref.match(/^(.*?)((?:[~^]\d*)*)$/);
  const base = m[1];
  let id = null;
  if (/^head$/i.test(base) || base === "@") id = headId(s);
  else if (s.branches[base]) id = s.branches[base];
  else if (s.tags[base]) id = s.tags[base];
  else id = Object.keys(s.commits).find((k) => k.toLowerCase() === base.toLowerCase()) || null;
  if (!id) return null;
  for (const op of m[2].match(/[~^]\d*/g) || []) {
    const n = op.length > 1 ? Number(op.slice(1)) : 1;
    if (op[0] === "~") {
      for (let i = 0; i < n && id; i++) id = s.commits[id].parents[0] || null;
    } else {
      id = n === 0 ? id : s.commits[id].parents[n - 1] || null;
    }
    if (!id) return null;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Helpers that change state
// ---------------------------------------------------------------------------

const validBranch = (name) => typeof name === "string" && /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith("-") && !/^head$/i.test(name) && !name.endsWith("/");

function laneFor(s, branch) {
  if (s.lanes[branch] === undefined) s.lanes[branch] = s.nextLane++;
  return s.lanes[branch];
}

const currentLane = (s) => (s.head.branch ? laneFor(s, s.head.branch) : s.commits[s.head.detached].lane);

function addCommit(s, { parents, message, copyOf, revertOf }) {
  let id;
  if (copyOf) {
    id = `${copyOf}'`;
    while (s.commits[id]) id += "'";
  } else {
    id = `C${s.nextNum++}`;
  }
  s.commits[id] = { id, message, parents, lane: currentLane(s), seq: s.nextSeq++, ...(copyOf ? { copyOf } : {}), ...(revertOf ? { revertOf } : {}) };
  return id;
}

function moveHead(s, id) {
  if (s.head.branch) s.branches[s.head.branch] = id;
  else s.head.detached = id;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function tokenize(input) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(input))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const SUBCOMMANDS = ["commit", "branch", "checkout", "switch", "merge", "rebase", "reset", "revert", "cherry-pick", "tag", "log", "status", "help", "init", "add", "push", "pull", "fetch", "clone", "diff", "stash"];

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const out = (text) => ({ kind: "out", text });
const ok = (text) => ({ kind: "ok", text });
const err = (text) => ({ kind: "err", text });
const hint = (text) => ({ kind: "hint", text });

function fail(s, ...lines) {
  return { state: s, lines, explain: null, ok: false };
}

function cmdCommit(s, args) {
  let message = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-m" || args[i] === "-am" || args[i] === "--message") {
      message = args.slice(i + 1).filter((a) => !a.startsWith("-")).join(" ");
      break;
    }
  }
  const parent = headId(s);
  const id = addCommit(s, { parents: [parent], message: message || "" });
  if (!message) s.commits[id].message = `Commit ${id}`;
  moveHead(s, id);
  const where = s.head.branch ? `on ${s.head.branch}` : "on a detached HEAD";
  return {
    lines: [ok(`[${headLabel(s)} ${id}] ${s.commits[id].message}`)],
    explain: s.head.branch
      ? `Created commit ${id} ${where}. Its parent is ${parent}, and the "${s.head.branch}" branch moved forward to point at it.`
      : `Created commit ${id} ${where}. No branch points here, so if you switch away this commit will be lost unless you create a branch for it.`,
    focus: id,
  };
}

function cmdBranch(s, args) {
  const flags = args.filter((a) => a.startsWith("-"));
  const names = args.filter((a) => !a.startsWith("-"));

  if (!names.length && (!flags.length || flags.some((f) => ["-a", "--list", "-l", "-v"].includes(f)))) {
    const lines = Object.keys(s.branches)
      .sort()
      .map((b) => out(`${b === s.head.branch ? "* " : "  "}${b}`));
    if (!s.head.branch) lines.unshift(out(`* (HEAD detached at ${s.head.detached})`));
    return { lines, explain: null };
  }

  if (flags.includes("-d") || flags.includes("-D") || flags.includes("--delete")) {
    const name = names[0];
    if (!s.branches[name]) return { error: `error: branch '${name}' not found.` };
    if (name === s.head.branch) return { error: `error: Cannot delete branch '${name}' checked out. Switch to another branch first.` };
    if (!flags.includes("-D") && !isAncestor(s, s.branches[name], headId(s)))
      return { error: `error: The branch '${name}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${name}'.` };
    const at = s.branches[name];
    delete s.branches[name];
    return {
      lines: [ok(`Deleted branch ${name} (was ${at}).`)],
      explain: `Deleted the label "${name}". Deleting a branch never deletes commits; any commits only that branch pointed to are now unreachable (faded).`,
    };
  }

  if (flags.includes("-m") || flags.includes("-M")) {
    const [from, to] = names.length === 2 ? names : [s.head.branch, names[0]];
    if (!from || !s.branches[from]) return { error: `error: refname '${from}' not found.` };
    if (!validBranch(to)) return { error: `fatal: '${to}' is not a valid branch name.` };
    if (s.branches[to]) return { error: `fatal: A branch named '${to}' already exists.` };
    s.branches[to] = s.branches[from];
    s.lanes[to] = s.lanes[from];
    delete s.branches[from];
    if (s.head.branch === from) s.head.branch = to;
    return { lines: [ok(`Renamed ${from} to ${to}.`)], explain: `Renamed the branch "${from}" to "${to}". Same commits, new name.` };
  }

  const [name, start] = names;
  if (!name) return { error: `error: unknown option '${flags[0]}'\nusage: git branch <name> | git branch -d <name>` };
  if (!validBranch(name)) return { error: `fatal: '${name}' is not a valid branch name.` };
  const target = start ? resolve(s, start) : headId(s);
  if (!target) return { error: `fatal: not a valid object name: '${start}'.` };
  if (s.branches[name] && !flags.includes("-f")) return { error: `fatal: A branch named '${name}' already exists.` };
  if (s.branches[name] && name === s.head.branch) return { error: `fatal: cannot force update the current branch.` };
  const moved = Boolean(s.branches[name]);
  s.branches[name] = target;
  laneFor(s, name);
  return {
    lines: [],
    explain: moved
      ? `Forced "${name}" to point at ${target}.`
      : `Created a new branch "${name}" pointing at ${target}. A branch is just a movable label on a commit. You're still on ${headLabel(s)}; use "git switch ${name}" to move to it.`,
    focus: target,
  };
}

function switchTo(s, name) {
  const from = headLabel(s);
  s.head = { branch: name };
  return {
    lines: [ok(`Switched to branch '${name}'`)],
    explain: `HEAD now points to "${name}" (it was on ${from}). New commits will be added to ${name}.`,
    focus: s.branches[name],
  };
}

function createAndSwitch(s, name, start) {
  if (!name) return { error: "error: missing branch name, e.g. git switch -c feature" };
  if (!validBranch(name)) return { error: `fatal: '${name}' is not a valid branch name.` };
  if (s.branches[name]) return { error: `fatal: A branch named '${name}' already exists.` };
  const target = start ? resolve(s, start) : headId(s);
  if (!target) return { error: `fatal: '${start}' is not a commit and a branch '${name}' cannot be created from it.` };
  s.branches[name] = target;
  laneFor(s, name);
  s.head = { branch: name };
  return {
    lines: [ok(`Switched to a new branch '${name}'`)],
    explain: `Created "${name}" at ${target} and switched to it, in one step. Commits you make now go on ${name}, leaving the other branches alone.`,
    focus: target,
  };
}

function detach(s, id) {
  s.head = { detached: id };
  return {
    lines: [hint(`Note: switching to '${id}'.`), hint("You are in 'detached HEAD' state. Make a branch if you want to keep commits made here.")],
    explain: `HEAD now points directly at commit ${id} instead of a branch. That's "detached HEAD": good for looking around, but create a branch before committing so your work isn't lost.`,
    focus: id,
  };
}

function cmdCheckout(s, args) {
  const bIdx = args.findIndex((a) => a === "-b" || a === "-B");
  if (bIdx >= 0) return createAndSwitch(s, args[bIdx + 1], args[bIdx + 2]);
  const target = args.find((a) => !a.startsWith("-"));
  if (!target) return { error: "usage: git checkout <branch> | git checkout -b <new-branch>" };
  if (s.branches[target]) {
    if (s.head.branch === target) return { lines: [out(`Already on '${target}'`)], explain: null };
    return switchTo(s, target);
  }
  const id = resolve(s, target);
  if (!id) return { error: `error: pathspec '${target}' did not match any branch or commit.` };
  return detach(s, id);
}

function cmdSwitch(s, args) {
  const cIdx = args.findIndex((a) => a === "-c" || a === "-C" || a === "--create");
  if (cIdx >= 0) return createAndSwitch(s, args[cIdx + 1], args[cIdx + 2]);
  const target = args.find((a) => !a.startsWith("-"));
  if (!target) return { error: "usage: git switch <branch> | git switch -c <new-branch>" };
  if (args.includes("--detach") || args.includes("-d")) {
    const id = resolve(s, target);
    if (!id) return { error: `fatal: invalid reference: ${target}` };
    return detach(s, id);
  }
  if (!s.branches[target]) {
    const hintText = resolve(s, target) ? ` (to look at a commit use "git switch --detach ${target}")` : ` (create it with "git switch -c ${target}")`;
    return { error: `fatal: invalid reference: ${target}${hintText}` };
  }
  if (s.head.branch === target) return { lines: [out(`Already on '${target}'`)], explain: null };
  return switchTo(s, target);
}

function cmdMerge(s, args) {
  const noFF = args.includes("--no-ff");
  const ref = args.find((a) => !a.startsWith("-"));
  if (!ref) return { error: "usage: git merge <branch>" };
  const target = resolve(s, ref);
  if (!target) return { error: `merge: ${ref} - not something we can merge` };
  const h = headId(s);
  const here = headLabel(s);
  if (isAncestor(s, target, h)) return { lines: [out("Already up to date.")], explain: `${ref} is already part of ${here}'s history, so there's nothing to merge.` };
  if (isAncestor(s, h, target) && !noFF) {
    moveHead(s, target);
    return {
      lines: [out(`Updating ${h}..${target}`), ok("Fast-forward")],
      explain: `Fast-forward! ${here} was simply behind ${ref}, so git moved ${here} forward to ${target}. No merge commit needed because the histories never split.`,
      focus: target,
    };
  }
  const id = addCommit(s, { parents: [h, target], message: `Merge ${s.branches[ref] ? `branch '${ref}'` : ref} into ${here}` });
  moveHead(s, id);
  return {
    lines: [ok(`Merge made by the 'ort' strategy.`), out(`[${here} ${id}] ${s.commits[id].message}`)],
    explain: `The two histories had split, so git created merge commit ${id} with two parents: ${h} (${here}) and ${target} (${ref}). Everything from ${ref} is now part of ${here}.`,
    focus: id,
  };
}

function cmdRebase(s, args) {
  const ref = args.find((a) => !a.startsWith("-"));
  if (!ref) return { error: "usage: git rebase <branch>" };
  const base = resolve(s, ref);
  if (!base) return { error: `fatal: invalid upstream '${ref}'` };
  const h = headId(s);
  const here = headLabel(s);
  if (isAncestor(s, base, h)) return { lines: [out(`Current branch ${here} is up to date.`)], explain: `${here} already sits on top of ${ref}, so there's nothing to rebase.` };
  if (isAncestor(s, h, base)) {
    moveHead(s, base);
    return { lines: [ok(`Successfully rebased and updated ${here}.`)], explain: `${here} had no commits of its own, so it was simply moved forward to ${base}.`, focus: base };
  }
  const baseSet = ancestors(s, base);
  const upstreamOrigins = new Set([...baseSet].map((id) => originOf(s, id)));
  const toReplay = [...ancestors(s, h)]
    .filter((id) => !baseSet.has(id) && s.commits[id].parents.length < 2 && !upstreamOrigins.has(originOf(s, id)))
    .sort((a, b) => s.commits[a].seq - s.commits[b].seq);
  let prev = base;
  const copies = [];
  for (const id of toReplay) {
    const copy = addCommit(s, { parents: [prev], message: s.commits[id].message, copyOf: originOf(s, id) });
    copies.push(`${id} → ${copy}`);
    prev = copy;
  }
  moveHead(s, prev);
  return {
    lines: [ok(`Successfully rebased and updated ${here}.`)],
    explain: `Rebase replayed ${toReplay.length} commit${toReplay.length === 1 ? "" : "s"} from ${here} on top of ${ref} (${copies.join(", ")}). The copies get new IDs; the originals are faded because no branch points to them anymore. The result is a straight, linear history.`,
    focus: prev,
  };
}

function cmdReset(s, args) {
  const mode = args.find((a) => ["--hard", "--soft", "--mixed"].includes(a)) || "--mixed";
  const ref = args.find((a) => !a.startsWith("-")) || "HEAD";
  const target = resolve(s, ref);
  if (!target) return { error: `fatal: ambiguous argument '${ref}': unknown revision.` };
  const before = headId(s);
  moveHead(s, target);
  const lost = [...ancestors(s, before)].filter((id) => !reachable(s).has(id));
  const modeNote = {
    "--hard": "With --hard, real git would also throw away your uncommitted changes.",
    "--soft": "With --soft, real git keeps the undone changes staged, ready to commit again.",
    "--mixed": "By default (--mixed), real git keeps the undone changes in your files, unstaged.",
  }[mode];
  return {
    lines: [out(`HEAD is now at ${target} ${s.commits[target].message}`)],
    explain: `Moved ${headLabel(s)} back to ${target}.${lost.length ? ` ${lost.join(", ")} ${lost.length === 1 ? "is" : "are"} no longer on any branch (faded).` : ""} ${modeNote}`,
    focus: target,
  };
}

function cmdRevert(s, args) {
  const ref = args.find((a) => !a.startsWith("-"));
  const target = resolve(s, ref);
  if (!target) return { error: `fatal: bad revision '${ref || ""}'` };
  const id = addCommit(s, { parents: [headId(s)], message: `Revert "${s.commits[target].message}"`, revertOf: target });
  moveHead(s, id);
  return {
    lines: [ok(`[${headLabel(s)} ${id}] Revert "${s.commits[target].message}"`)],
    explain: `Created ${id}, a new commit that undoes ${target}. Unlike reset, revert doesn't rewrite history, so it's the safe way to undo something already shared with others.`,
    focus: id,
  };
}

function cmdCherryPick(s, args) {
  const refs = args.filter((a) => !a.startsWith("-"));
  if (!refs.length) return { error: "usage: git cherry-pick <commit>..." };
  const made = [];
  for (const ref of refs) {
    const target = resolve(s, ref);
    if (!target) return { error: `fatal: bad revision '${ref}'` };
    const h = headId(s);
    if (isAncestor(s, target, h)) return { error: `error: ${target} is already in your history, nothing to cherry-pick.` };
    if (s.commits[target].parents.length > 1) return { error: `error: commit ${target} is a merge, which this playground can't cherry-pick.` };
    const id = addCommit(s, { parents: [h], message: s.commits[target].message, copyOf: originOf(s, target) });
    moveHead(s, id);
    made.push([target, id]);
  }
  const last = made[made.length - 1][1];
  return {
    lines: made.map(([, id]) => ok(`[${headLabel(s)} ${id}] ${s.commits[id].message}`)),
    explain: `Copied ${made.map(([from, to]) => `${from} as ${to}`).join(", ")} onto ${headLabel(s)}. Cherry-pick takes just the commits you choose, without merging the rest of their branch.`,
    focus: last,
  };
}

function cmdTag(s, args) {
  const names = args.filter((a) => !a.startsWith("-"));
  if (args.includes("-d")) {
    if (!s.tags[names[0]]) return { error: `error: tag '${names[0]}' not found.` };
    delete s.tags[names[0]];
    return { lines: [ok(`Deleted tag '${names[0]}'`)], explain: null };
  }
  if (!names.length) return { lines: Object.keys(s.tags).sort().map(out), explain: null };
  const [name, ref] = names;
  if (s.tags[name]) return { error: `fatal: tag '${name}' already exists` };
  if (!validBranch(name)) return { error: `fatal: '${name}' is not a valid tag name.` };
  const target = ref ? resolve(s, ref) : headId(s);
  if (!target) return { error: `fatal: Failed to resolve '${ref}' as a valid ref.` };
  s.tags[name] = target;
  return { lines: [], explain: `Tagged ${target} as "${name}". Unlike a branch, a tag never moves. Teams use tags to mark releases like v1.0.`, focus: target };
}

function decorations(s, id) {
  const refs = [];
  if (!s.head.branch && s.head.detached === id) refs.push("HEAD");
  for (const [b, c] of Object.entries(s.branches)) if (c === id) refs.push(b === s.head.branch ? `HEAD -> ${b}` : b);
  for (const [t, c] of Object.entries(s.tags)) if (c === id) refs.push(`tag: ${t}`);
  refs.sort((a, b) => (b.startsWith("HEAD") ? 1 : 0) - (a.startsWith("HEAD") ? 1 : 0));
  return refs.length ? ` (${refs.join(", ")})` : "";
}

function cmdLog(s, args) {
  const ref = args.find((a) => !a.startsWith("-"));
  const start = ref ? resolve(s, ref) : headId(s);
  if (!start) return { error: `fatal: ambiguous argument '${ref}'` };
  const ids = [...ancestors(s, start)].sort((a, b) => s.commits[b].seq - s.commits[a].seq);
  const lines = ids.slice(0, 25).map((id) => out(`${id}${decorations(s, id)} ${s.commits[id].message}`));
  if (ids.length > 25) lines.push(hint(`… and ${ids.length - 25} more`));
  return { lines, explain: null };
}

function cmdStatus(s) {
  return {
    lines: [out(s.head.branch ? `On branch ${s.head.branch}` : `HEAD detached at ${s.head.detached}`), out("nothing to commit, working tree clean")],
    explain: null,
  };
}

export const HELP = [
  ["git commit -m \"message\"", "save a new commit"],
  ["git branch <name>", "create a branch (git branch -d <name> deletes)"],
  ["git switch <name>", "move to a branch (or git checkout <name>)"],
  ["git switch -c <name>", "create a branch and switch to it"],
  ["git checkout <commit>", "look at an old commit (detached HEAD)"],
  ["git merge <branch>", "bring another branch into this one"],
  ["git rebase <branch>", "replay your commits on top of another branch"],
  ["git reset --hard <ref>", "move this branch back (e.g. HEAD~1)"],
  ["git revert <commit>", "add a commit that undoes another"],
  ["git cherry-pick <commit>", "copy one commit onto this branch"],
  ["git tag <name>", "label a commit permanently"],
  ["git log / git status", "see where you are"],
  ["undo · clear · reset", "playground shortcuts"],
];

function cmdHelp() {
  return { lines: HELP.map(([c, d]) => out(`${c.padEnd(28)} ${d}`)), explain: null };
}

const NOT_SIMULATED = {
  add: "There are no files in this playground, so there's nothing to stage. Just run git commit -m \"message\".",
  diff: "There are no files in this playground, so there's nothing to diff.",
  stash: "There are no files in this playground, so there's nothing to stash.",
  init: "This playground is already a repository.",
  push: "Remotes aren't simulated here. Everything happens in your local history.",
  pull: "Remotes aren't simulated here. Try git merge to see how integrating changes works.",
  fetch: "Remotes aren't simulated here.",
  clone: "Remotes aren't simulated here. You already have a repository to play with.",
};

const COMMANDS = {
  commit: cmdCommit,
  branch: cmdBranch,
  checkout: cmdCheckout,
  switch: cmdSwitch,
  merge: cmdMerge,
  rebase: cmdRebase,
  reset: cmdReset,
  revert: cmdRevert,
  "cherry-pick": cmdCherryPick,
  tag: cmdTag,
  log: cmdLog,
  status: cmdStatus,
  help: cmdHelp,
};

/**
 * Run one command. Returns { state, lines, explain, focus, ok }.
 * The input state is never mutated.
 */
export function run(state, input) {
  const tokens = tokenize(input.trim());
  if (!tokens.length) return { state, lines: [], explain: null, ok: true };
  if (tokens[0] === "git") tokens.shift();
  const [sub, ...args] = tokens;
  if (!sub) return fail(state, hint("Type a git command, like git commit -m \"first commit\". Type help to see them all."));
  if (NOT_SIMULATED[sub]) return { state, lines: [hint(NOT_SIMULATED[sub])], explain: null, ok: true };
  const fn = COMMANDS[sub];
  if (!fn) {
    const guess = SUBCOMMANDS.find((c) => c.startsWith(sub.slice(0, 3)));
    return fail(state, err(`git: '${sub}' is not a git command.${guess ? ` Did you mean '${guess}'?` : ""} Type help to see what's supported.`));
  }
  const next = clone(state);
  const result = fn(next, args);
  if (result.error) return fail(state, ...result.error.split("\n").map(err));
  return { state: next, lines: result.lines, explain: result.explain, focus: result.focus || null, ok: true };
}

/** Run several commands in a row (used for lesson setups and shared links). */
export function runAll(state, inputs) {
  let s = state;
  for (const input of inputs) s = run(s, input).state;
  return s;
}
