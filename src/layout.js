// Turns repo state into positions for the graph. Pure, so it's unit-tested.
//
// Commits are laid out left to right in the order they were created, and each
// one sits in the row ("lane") of the branch it was made on.

import { headId, reachable } from "./git.js";

export const GAP_X = 96;
export const GAP_Y = 84;
const PAD_X = 56;
const LABEL_H = 26;

export function layout(s) {
  const ids = Object.keys(s.commits).sort((a, b) => s.commits[a].seq - s.commits[b].seq);
  const live = reachable(s);
  const head = headId(s);

  // Only lanes that actually hold commits get a row, in lane order.
  const rows = [...new Set(ids.map((id) => s.commits[id].lane))].sort((a, b) => a - b);
  const rowOf = new Map(rows.map((lane, i) => [lane, i]));

  // Labels per commit: branches (current one first), tags, and a bare HEAD when detached.
  const labels = new Map(ids.map((id) => [id, []]));
  for (const [name, id] of Object.entries(s.branches)) {
    labels.get(id).push({ key: `b:${name}`, text: name, kind: "branch", lane: s.lanes[name] ?? 0, current: s.head.branch === name });
  }
  for (const [name, id] of Object.entries(s.tags)) labels.get(id).push({ key: `t:${name}`, text: name, kind: "tag" });
  if (!s.head.branch) labels.get(head).push({ key: "head", text: "HEAD", kind: "head", current: true });
  for (const list of labels.values()) list.sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0) || a.text.localeCompare(b.text));

  const maxStack = Math.max(1, ...[...labels.values()].map((l) => l.length));
  const padTop = 30 + maxStack * LABEL_H;

  const pos = new Map();
  const nodes = ids.map((id, i) => {
    const c = s.commits[id];
    const x = PAD_X + i * GAP_X;
    const y = padTop + rowOf.get(c.lane) * GAP_Y;
    pos.set(id, { x, y });
    return {
      id,
      x,
      y,
      lane: c.lane,
      message: c.message,
      merge: c.parents.length > 1,
      copy: Boolean(c.copyOf),
      reachable: live.has(id),
      head: id === head,
      labels: labels.get(id),
    };
  });

  const edges = [];
  for (const node of nodes) {
    for (const parent of s.commits[node.id].parents) {
      const a = pos.get(parent);
      const b = { x: node.x, y: node.y };
      const mid = a.x + (b.x - a.x) * 0.55;
      const d = a.y === b.y ? `M ${a.x} ${a.y} L ${b.x} ${b.y}` : `M ${a.x} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${b.x} ${b.y}`;
      edges.push({ key: `${parent}>${node.id}`, from: parent, to: node.id, d, lane: node.lane, reachable: node.reachable });
    }
  }

  return {
    nodes,
    edges,
    width: PAD_X * 2 + Math.max(0, ids.length - 1) * GAP_X,
    height: padTop + (rows.length - 1) * GAP_Y + 64,
  };
}
