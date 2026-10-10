import { createRepo, headId, run, runAll } from "./git.js";
import { createGraph } from "./graph.js";
import { LEVELS, goalStatus, isComplete } from "./levels.js";

const $ = (sel) => document.querySelector(sel);
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const graph = createGraph($("#graph"));
const termOut = $("#term-out");
const input = $("#cmd");

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

let mode = "lessons";
let levelIndex = 0;
let repo = createRepo();
let undoStack = [];
let sandboxLog = []; // successful commands, for share links
let lastGoals = [];
const typed = []; // terminal history for ↑/↓
let typedIndex = 0;

const PROGRESS_KEY = "git-playground:done";
let completed = new Set();
try {
  completed = new Set(JSON.parse(localStorage.getItem(PROGRESS_KEY) || "[]"));
} catch {}
const saveProgress = () => {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify([...completed]));
  } catch {}
};

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

function print(kind, html) {
  const line = document.createElement("div");
  line.className = kind;
  line.innerHTML = html;
  termOut.appendChild(line);
  termOut.scrollTop = termOut.scrollHeight;
}

function updatePrompt() {
  $("#prompt").textContent = `(${repo.head.branch || headId(repo)}) $`;
}

function explain(text, isError = false) {
  const box = $("#explain");
  $("#explain-text").textContent = text;
  box.classList.toggle("error", isError);
  box.classList.remove("flash");
  void box.offsetWidth;
  box.classList.add("flash");
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function scrollToCommit(id) {
  const node = graph.lastLayout?.nodes.find((n) => n.id === id);
  if (!node) return;
  const box = $("#graph-scroll");
  box.scrollTo({ left: Math.max(0, node.x - box.clientWidth * 0.6), behavior: reducedMotion() ? "auto" : "smooth" });
}

function render(focus) {
  graph.lastLayout = graph.render(repo);
  updatePrompt();
  updateChips();
  $("#undo").disabled = undoStack.length === 0;
  $("#share").hidden = mode !== "sandbox";
  if (focus) requestAnimationFrame(() => scrollToCommit(focus));
  if (mode === "lessons") updateGoals();
}

function updateChips() {
  const others = Object.keys(repo.branches).filter((b) => b !== repo.head.branch);
  const suggestions = ['git commit -m "Add feature"'];
  if (!repo.branches.feature) suggestions.push("git switch -c feature");
  for (const b of others.slice(0, 2)) suggestions.push(`git switch ${b}`, `git merge ${b}`);
  if (others[0]) suggestions.push(`git rebase ${others[0]}`);
  suggestions.push("git reset --hard HEAD~1", "git log", "undo");
  const chips = $("#chips");
  chips.innerHTML = "";
  for (const s of [...new Set(suggestions)].slice(0, 8)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.textContent = s;
    b.addEventListener("click", () => {
      input.value = s;
      input.focus();
      // Put the cursor inside the quotes so it's easy to type a message.
      const q = s.indexOf('"');
      if (q >= 0) input.setSelectionRange(q + 1, s.length - 1);
    });
    chips.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

function renderLessonNav() {
  const nav = $("#lesson-nav");
  nav.innerHTML = "";
  LEVELS.forEach((level, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = i + 1;
    b.title = level.title;
    b.className = `${i === levelIndex ? "active" : ""} ${completed.has(level.id) ? "complete" : ""}`;
    b.addEventListener("click", () => startLesson(i));
    nav.appendChild(b);
  });
}

function updateGoals() {
  const level = LEVELS[levelIndex];
  const status = goalStatus(level, repo);
  const list = $("#goals");
  list.innerHTML = "";
  level.goals.forEach((g, i) => {
    const li = document.createElement("li");
    li.textContent = g.text;
    if (status[i]) li.classList.add("met");
    if (status[i] && !lastGoals[i]) li.classList.add("just-met");
    list.appendChild(li);
  });
  lastGoals = status;

  const done = isComplete(level, repo);
  $("#done").hidden = !done;
  $("#next-lesson").textContent = levelIndex < LEVELS.length - 1 ? "Next lesson →" : "Try the sandbox →";
  if (done && !completed.has(level.id)) {
    completed.add(level.id);
    saveProgress();
    renderLessonNav();
    celebrate();
    explain(`${$("#explain-text").textContent} 🎉 You completed "${level.title}"!`);
  }
}

function startLesson(i) {
  mode = "lessons";
  levelIndex = Math.max(0, Math.min(LEVELS.length - 1, i));
  const level = LEVELS[levelIndex];
  repo = runAll(createRepo(), level.setup);
  undoStack = [];
  lastGoals = goalStatus(level, repo);
  setModeUI();
  $("#lesson-kicker").textContent = `Lesson ${levelIndex + 1} of ${LEVELS.length} · ${level.concept}`;
  $("#lesson-title").textContent = level.title;
  $("#lesson-intro").textContent = level.intro;
  $("#hint").hidden = true;
  $("#hint-btn").textContent = "Need a hint?";
  $("#hint-btn").dataset.step = "0";
  renderLessonNav();
  termOut.innerHTML = "";
  print("muted", esc(`# Lesson ${levelIndex + 1}: ${level.title}`));
  explain(level.intro);
  history.replaceState(null, "", `#lesson-${levelIndex + 1}`);
  render(headId(repo));
}

$("#hint-btn").addEventListener("click", (e) => {
  const level = LEVELS[levelIndex];
  const step = Number(e.currentTarget.dataset.step || 0);
  const hint = $("#hint");
  hint.hidden = false;
  if (step === 0) {
    hint.textContent = level.hint;
    e.currentTarget.textContent = "Show the answer";
  } else {
    hint.textContent = level.solution.join("\n");
    hint.style.whiteSpace = "pre-line";
    e.currentTarget.textContent = "";
  }
  e.currentTarget.dataset.step = String(step + 1);
});

$("#next-lesson").addEventListener("click", () => (levelIndex < LEVELS.length - 1 ? startLesson(levelIndex + 1) : startSandbox()));

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

function startSandbox(commands = []) {
  mode = "sandbox";
  repo = createRepo();
  sandboxLog = [];
  for (const c of commands) {
    const r = run(repo, c);
    if (r.ok && r.state !== repo) {
      repo = r.state;
      sandboxLog.push(c);
    }
  }
  undoStack = [];
  setModeUI();
  termOut.innerHTML = "";
  print("muted", "# Sandbox: try anything. Type help to see every command.");
  if (commands.length) print("muted", esc(`# Replayed ${sandboxLog.length} shared command${sandboxLog.length === 1 ? "" : "s"}`));
  explain(commands.length ? "This is a shared history. Keep going from here, or press Reset to start fresh." : "Free play! Create branches, merge, rebase and reset. Undo is always one click away.");
  history.replaceState(null, "", location.pathname + (commands.length ? location.hash : ""));
  render(headId(repo));
}

// Compact cheat sheet: click to put a ready-to-run example in the terminal.
const CHEATS = [
  ['commit -m "…"', 'git commit -m "Add feature"', "Save a new commit"],
  ["switch -c <name>", "git switch -c feature", "Create a branch and switch to it"],
  ["switch <name>", "git switch main", "Move to a branch"],
  ["merge <branch>", "git merge feature", "Bring another branch into this one"],
  ["rebase <branch>", "git rebase main", "Replay your commits on top of another branch"],
  ["reset --hard <ref>", "git reset --hard HEAD~1", "Move this branch back"],
  ["cherry-pick <id>", "git cherry-pick C1", "Copy one commit onto this branch"],
  ["revert <id>", "git revert HEAD", "Add a commit that undoes another"],
  ["checkout <id>", "git checkout C0", "Look at an old commit (detached HEAD)"],
  ["tag <name>", "git tag v1.0", "Label a commit permanently"],
  ["branch -d <name>", "git branch -d feature", "Delete a branch label"],
  ["log", "git log", "List the history"],
];
const cheats = $("#cheats");
for (const [label, example, desc] of CHEATS) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cheat";
  b.textContent = label;
  b.title = `${desc} · e.g. ${example}`;
  b.addEventListener("click", () => {
    input.value = example;
    input.focus();
  });
  cheats.appendChild(b);
}
const note = document.createElement("p");
note.className = "cheat-note";
note.textContent = "Click one to try it. Type help in the terminal for the full list.";
cheats.after(note);

function setModeUI() {
  document.querySelectorAll(".modes button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.mode === mode)));
  $("#lesson-panel").hidden = mode !== "lessons";
  $("#sandbox-panel").hidden = mode !== "sandbox";
}

document.querySelectorAll(".modes button").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.mode === mode) return;
    if (b.dataset.mode === "sandbox") startSandbox();
    else startLesson(LEVELS.findIndex((l) => !completed.has(l.id)) === -1 ? 0 : LEVELS.findIndex((l) => !completed.has(l.id)));
  })
);

// ---------------------------------------------------------------------------
// Running commands
// ---------------------------------------------------------------------------

function undo() {
  if (!undoStack.length) {
    print("hint", "Nothing to undo.");
    return;
  }
  repo = undoStack.pop();
  if (mode === "sandbox") sandboxLog.pop();
  print("muted", "# undone");
  explain("Undid the last command. (This is a playground feature; real git has no undo button, which is why we practise here!)");
  render(headId(repo));
}

function restart() {
  if (mode === "lessons") startLesson(levelIndex);
  else startSandbox();
}

function execute(raw) {
  const text = raw.trim();
  if (!text) return;
  typed.push(text);
  typedIndex = typed.length;
  print("cmd", `<b>$</b> ${esc(text)}`);

  const word = text.toLowerCase();
  if (word === "clear") return void (termOut.innerHTML = "");
  if (word === "undo") return undo();
  if (word === "reset" || word === "restart") return restart();

  const r = run(repo, text);
  for (const line of r.lines) print(line.kind, esc(line.text));
  if (!r.ok) {
    explain(r.lines.map((l) => l.text).join(" "), true);
    return;
  }
  if (r.state !== repo) {
    undoStack.push(repo);
    if (undoStack.length > 100) undoStack.shift();
    repo = r.state;
    if (mode === "sandbox") sandboxLog.push(text);
  }
  if (r.explain) explain(r.explain);
  render(r.focus);
}

$("#term-form").addEventListener("submit", (e) => {
  e.preventDefault();
  execute(input.value);
  input.value = "";
});

input.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" && typed.length) {
    typedIndex = Math.max(0, typedIndex - 1);
    input.value = typed[typedIndex];
    e.preventDefault();
  } else if (e.key === "ArrowDown" && typed.length) {
    typedIndex = Math.min(typed.length, typedIndex + 1);
    input.value = typed[typedIndex] || "";
    e.preventDefault();
  }
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && document.activeElement !== input) {
    e.preventDefault();
    undo();
  }
});

$("#undo").addEventListener("click", undo);
$("#restart").addEventListener("click", restart);
$("#share").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}#play=${encodeURIComponent(JSON.stringify(sandboxLog))}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied! Anyone who opens it sees this exact history.");
  } catch {
    toast("Couldn't copy the link.");
  }
});
$(".board").addEventListener("click", (e) => {
  if (!e.target.closest("button")) input.focus({ preventScroll: true });
});

// ---------------------------------------------------------------------------
// Little extras
// ---------------------------------------------------------------------------

function celebrate() {
  if (reducedMotion()) return;
  const colors = ["#f05032", "#2f6fed", "#12a37a", "#9b51e0", "#d99a00", "#e0457b"];
  for (let i = 0; i < 70; i++) {
    const c = document.createElement("i");
    c.className = "confetti";
    c.style.left = `${Math.random() * 100}vw`;
    c.style.background = colors[i % colors.length];
    c.style.setProperty("--t", `${1.2 + Math.random() * 1.2}s`);
    c.style.setProperty("--dx", `${(Math.random() - 0.5) * 200}px`);
    c.style.setProperty("--r", `${(Math.random() - 0.5) * 1080}deg`);
    c.style.animationDelay = `${Math.random() * 0.3}s`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), 3000);
  }
}

function toast(message) {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2400);
}

// ---------------------------------------------------------------------------
// Start: shared sandbox link, a specific lesson, or the first unfinished lesson
// ---------------------------------------------------------------------------

const hash = location.hash;
if (hash.startsWith("#play=")) {
  let cmds = [];
  try {
    cmds = JSON.parse(decodeURIComponent(hash.slice(6)));
  } catch {}
  startSandbox(Array.isArray(cmds) ? cmds.filter((c) => typeof c === "string").slice(0, 200) : []);
} else if (/^#lesson-\d+$/.test(hash)) {
  startLesson(Number(hash.slice(8)) - 1);
} else {
  const next = LEVELS.findIndex((l) => !completed.has(l.id));
  startLesson(next === -1 ? 0 : next);
}
