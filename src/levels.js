// Guided lessons. Each one starts from a prepared history (setup) and lists
// goals that are checked live after every command.

import { ancestors, isAncestor } from "./git.js";

const tip = (s, b) => s.branches[b];
const messagesOn = (s, ref) => (ref ? [...ancestors(s, ref)].map((id) => s.commits[id].message) : []);
const onBranch = (s, b) => s.head.branch === b;
const commitsAfterRoot = (s, b) => (tip(s, b) ? ancestors(s, tip(s, b)).size - 1 : 0);

export const LEVELS = [
  {
    id: "commits",
    title: "Your first commits",
    concept: "commit",
    intro: "A commit is a snapshot of your project. Each new commit points back to the one before it, which builds a history.",
    setup: [],
    goals: [
      { text: "Make a commit on main", check: (s) => commitsAfterRoot(s, "main") >= 1 },
      { text: "Make a second commit", check: (s) => commitsAfterRoot(s, "main") >= 2 },
    ],
    hint: 'Type: git commit -m "Add homepage"',
    solution: ['git commit -m "Add homepage"', 'git commit -m "Add contact page"'],
  },
  {
    id: "branch",
    title: "Branch out",
    concept: "branch",
    intro: "A branch is just a movable label on a commit. Branches let you work on something new without touching main.",
    setup: ['git commit -m "Add homepage"'],
    goals: [
      { text: "Create a branch called feature", check: (s) => Boolean(tip(s, "feature")) },
      { text: "Switch to feature", check: (s) => onBranch(s, "feature") },
      { text: "Commit on feature (main stays put)", check: (s) => tip(s, "feature") && !isAncestor(s, tip(s, "feature"), tip(s, "main")) },
    ],
    hint: "git branch feature → git switch feature → git commit -m \"Add login\"",
    solution: ["git branch feature", "git switch feature", 'git commit -m "Add login"'],
  },
  {
    id: "merge",
    title: "Merge it back",
    concept: "merge",
    intro: "Your feature is done, but main moved on too. Merging joins the two histories with a merge commit.",
    setup: ['git commit -m "Add homepage"', "git switch -c feature", 'git commit -m "Add login"', 'git commit -m "Style login form"', "git switch main", 'git commit -m "Fix typo"'],
    goals: [
      { text: "Be on main", check: (s) => onBranch(s, "main") },
      { text: "Merge feature into main", check: (s) => isAncestor(s, tip(s, "feature"), tip(s, "main")) },
      { text: "main now has a merge commit", check: (s) => s.commits[tip(s, "main")].parents.length === 2 },
    ],
    hint: "You're already on main. Run: git merge feature",
    solution: ["git merge feature"],
  },
  {
    id: "rebase",
    title: "Rebase for a clean history",
    concept: "rebase",
    intro: "Rebase moves your commits so they start from the tip of another branch. The history ends up as one straight line, with no merge commit.",
    setup: ['git commit -m "Add homepage"', "git switch -c feature", 'git commit -m "Add search"', 'git commit -m "Search filters"', "git switch main", 'git commit -m "Update footer"'],
    goals: [
      { text: "Switch to feature", check: (s) => onBranch(s, "feature") || isAncestor(s, tip(s, "main"), tip(s, "feature")) },
      { text: "Rebase feature onto main", check: (s) => isAncestor(s, tip(s, "main"), tip(s, "feature")) && !hasMerge(s, tip(s, "feature")) },
      { text: "Fast-forward main to feature", check: (s) => tip(s, "main") === tip(s, "feature") && !hasMerge(s, tip(s, "main")) },
    ],
    hint: "git switch feature → git rebase main → git switch main → git merge feature",
    solution: ["git switch feature", "git rebase main", "git switch main", "git merge feature"],
  },
  {
    id: "undo",
    title: "Undo a mistake",
    concept: "reset",
    intro: "Oops! The last commit broke everything. git reset moves your branch back to an earlier commit, as if the mistake never happened.",
    setup: ['git commit -m "Add homepage"', 'git commit -m "Good change"', 'git commit -m "Oops, broke everything"'],
    goals: [{ text: "Move main back to \"Good change\"", check: (s) => s.commits[tip(s, "main")].message === "Good change" }],
    hint: "HEAD~1 means \"one commit before HEAD\". Run: git reset --hard HEAD~1",
    solution: ["git reset --hard HEAD~1"],
  },
  {
    id: "cherry",
    title: "Cherry-pick a fix",
    concept: "cherry-pick",
    intro: "The experiment branch has one useful fix in the middle of unfinished work. Copy just that fix onto main with cherry-pick.",
    setup: ['git commit -m "Add homepage"', "git switch -c experiment", 'git commit -m "Try new layout"', 'git commit -m "Fix crash on login"', 'git commit -m "More layout ideas"', "git switch main"],
    goals: [
      { text: "Copy \"Fix crash on login\" onto main", check: (s) => messagesOn(s, tip(s, "main")).includes("Fix crash on login") },
      { text: "Leave the layout experiments out of main", check: (s) => !messagesOn(s, tip(s, "main")).some((m) => /layout/i.test(m)) },
    ],
    hint: "Find the fix's ID in the graph (it's C3), then run: git cherry-pick C3",
    solution: ["git cherry-pick C3"],
  },
];

function hasMerge(s, id) {
  return [...ancestors(s, id)].some((c) => s.commits[c].parents.length > 1);
}

export const goalStatus = (level, s) => level.goals.map((g) => Boolean(g.check(s)));
export const isComplete = (level, s) => goalStatus(level, s).every(Boolean);
