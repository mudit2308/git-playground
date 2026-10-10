// Draws the commit graph as SVG. Elements are kept by key between renders, so
// when a branch label moves to another commit it slides there instead of
// jumping, and only genuinely new commits and edges animate in.

import { layout } from "./layout.js";

const NS = "http://www.w3.org/2000/svg";
const LANES = 8;
const color = (lane) => `var(--lane-${lane % LANES})`;

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

const place = (node, x, y) => (node.style.transform = `translate(${x}px, ${y}px)`);
const labelWidth = (text) => Math.round(text.length * 7.2 + 18);

export function createGraph(svg) {
  const layers = { edges: el("g", {}, svg), stems: el("g", {}, svg), nodes: el("g", {}, svg), labels: el("g", {}, svg) };
  const live = { edges: new Map(), stems: new Map(), nodes: new Map(), labels: new Map() };
  let firstRender = true;

  // Create, update and remove keyed elements in one layer.
  function sync(kind, items, keyOf, create, update) {
    const seen = new Set();
    for (const item of items) {
      const key = keyOf(item);
      seen.add(key);
      let node = live[kind].get(key);
      const isNew = !node;
      if (isNew) {
        node = create(item);
        live[kind].set(key, node);
      }
      update(node, item, isNew);
      if (isNew) {
        layers[kind].appendChild(node);
        if (!firstRender) {
          node.classList.add("enter");
          setTimeout(() => node.classList.remove("enter"), 900);
        }
      }
    }
    for (const [key, node] of live[kind]) {
      if (!seen.has(key)) {
        node.remove();
        live[kind].delete(key);
      }
    }
  }

  function render(state) {
    const L = layout(state);
    svg.setAttribute("width", L.width);
    svg.setAttribute("height", L.height);
    svg.setAttribute("viewBox", `0 0 ${L.width} ${L.height}`);

    sync(
      "edges",
      L.edges,
      (e) => e.key,
      () => el("path", { class: "edge", pathLength: "1" }),
      (node, e) => {
        node.setAttribute("d", e.d);
        node.style.stroke = color(e.lane);
        node.classList.toggle("faded", !e.reachable);
      }
    );

    sync(
      "nodes",
      L.nodes,
      (n) => n.id,
      (n) => {
        const g = el("g", { class: "node" });
        const pop = el("g", { class: "pop" }, g);
        el("circle", { class: "ring", r: 24 }, pop);
        el("circle", { class: "bubble", r: 18 }, pop);
        el("text", {}, pop).textContent = n.id;
        el("title", {}, g);
        return g;
      },
      (g, n) => {
        place(g, n.x, n.y);
        const bubble = g.querySelector(".bubble");
        bubble.style.fill = color(n.lane);
        bubble.style.stroke = color(n.lane);
        g.querySelector(".ring").style.stroke = color(n.lane);
        g.querySelector("text").textContent = n.id;
        g.querySelector("title").textContent = `${n.id}: ${n.message}${n.reachable ? "" : " (not on any branch)"}`;
        g.classList.toggle("merge", n.merge);
        g.classList.toggle("copy", n.copy && !n.merge);
        g.classList.toggle("faded", !n.reachable);
        g.classList.toggle("head", n.head);
      }
    );

    // Dotted stem from each commit up to its stack of labels.
    sync(
      "stems",
      L.nodes.filter((n) => n.labels.length),
      (n) => n.id,
      () => el("line", { class: "stem" }),
      (line, n) => {
        line.setAttribute("x1", n.x);
        line.setAttribute("x2", n.x);
        line.setAttribute("y1", n.y - 20);
        line.setAttribute("y2", n.y - 32);
      }
    );

    const labels = L.nodes.flatMap((n) =>
      n.labels.map((label, i) => ({ ...label, x: n.x, y: n.y - 44 - i * 26, text: label.current && label.kind === "branch" ? `HEAD → ${label.text}` : label.text }))
    );
    sync(
      "labels",
      labels,
      (l) => l.key,
      () => {
        const g = el("g", { class: "label" });
        el("rect", { rx: 7, height: 22, y: -11 }, g);
        el("text", {}, g);
        return g;
      },
      (g, l) => {
        const w = labelWidth(l.text);
        const rect = g.querySelector("rect");
        rect.setAttribute("width", w);
        rect.setAttribute("x", -w / 2);
        const text = g.querySelector("text");
        text.textContent = l.text;
        text.setAttribute("x", -w / 2 + 9);
        g.classList.remove("branch", "tag", "head", "current");
        g.classList.add(l.kind);
        if (l.current) g.classList.add("current");
        if (l.kind === "branch") {
          rect.style.stroke = color(l.lane);
          rect.style.fill = l.current ? color(l.lane) : "#fff";
          text.style.fill = l.current ? "#fff" : color(l.lane);
        } else {
          rect.style.stroke = rect.style.fill = text.style.fill = "";
        }
        place(g, l.x, l.y);
      }
    );

    firstRender = false;
    return L;
  }

  return { render };
}
