// Offline simulation of map-page video retrieval designs. Run: node app/tools/retrieval-sim.mjs
// (JUDGE_ERR=2 doubles Claude's grading mistakes; BAD_CHANNELS=0.5 makes half the named channels wrong.)
// Design H (designG with clear-only showing) is what the app uses: see src/engine/retrieval.ts.
// A synthetic YouTube: a topic tree, channels that mostly (not only) post in one subtree,
// search that is good at the top and noisy further down, and descriptions full of boilerplate.
// Each design runs the same browsing sessions; we measure quota, relevant videos shown,
// precision (share of shown videos that truly belong to the page), Claude calls and wait time.

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];

// ---------------------------------------------------------------- the world
const AREAS = 14, MIDS = 6, LEAVES = 6;
const JUDGE_ERR = Number(process.env.JUDGE_ERR ?? 1); // multiplies the judge's mistake rates
const BAD_CHANNELS = Number(process.env.BAD_CHANNELS ?? 0); // share of named channels that are wrong
const nodes = []; // {id, path:[a,m,l], name, depth}
const word = (...p) => 'w' + p.join('_');
for (let a = 0; a < AREAS; a++) {
  nodes.push({ id: `${a}`, path: [a], name: word(a), depth: 1 });
  for (let m = 0; m < MIDS; m++) {
    nodes.push({ id: `${a}.${m}`, path: [a, m], name: word(a, m), depth: 2 });
    for (let l = 0; l < LEAVES; l++) nodes.push({ id: `${a}.${m}.${l}`, path: [a, m, l], name: word(a, m, l), depth: 3 });
  }
}
const byId = new Map(nodes.map((n) => [n.id, n]));
const leaves = nodes.filter((n) => n.depth === 3);
const within = (videoLeaf, node) => videoLeaf.startsWith(node.id + '.') || videoLeaf === node.id;

let vid = 0;
function makeVideo(leafId, channel) {
  const leaf = byId.get(leafId);
  const [a, m] = leaf.path;
  const t = [];
  if (rnd() < 0.55) t.push(leaf.name); // titles often, not always, name the specific topic
  if (rnd() < 0.3) t.push(word(a, m));
  if (rnd() < 0.15) t.push(word(a));
  // Descriptions: boilerplate that mentions broad areas (sponsors, playlists, "more history videos")
  const d = [];
  for (let k = 0; k < 3; k++) if (rnd() < 0.35) d.push(word(Math.floor(rnd() * AREAS)));
  if (rnd() < 0.5) d.push(word(a));
  return { id: `v${vid++}`, leaf: leafId, title: t.join(' '), desc: d.join(' '), channel, short: rnd() < 0.15 };
}

// Channels: each focuses on a mid-level subtree; 70% of uploads there, 30% anywhere.
const channels = [];
for (const mid of nodes.filter((n) => n.depth === 2)) {
  for (let c = 0; c < 4; c++) {
    const ch = { id: `c${channels.length}`, focus: mid.id, uploads: [] };
    for (let i = 0; i < 50; i++) {
      const leafId = rnd() < 0.7 ? `${mid.id}.${Math.floor(rnd() * LEAVES)}` : pick(leaves).id;
      ch.uploads.push(makeVideo(leafId, ch.id));
    }
    channels.push(ch);
  }
}
// The long tail: lots of videos per leaf from many small channels (what search finds).
const tail = new Map(leaves.map((l) => [l.id, Array.from({ length: 120 }, () => makeVideo(l.id, 'tail'))]));

// ---------------------------------------------------------------- the API (with quota)
function api() {
  const s = { units: 0, wait: 0, claude: 0 };
  return {
    s,
    // Claude names channels covering a place: channels whose focus is the place's mid-level ancestor (or inside an area).
    channelsFor(node) {
      const mid = node.depth === 1 ? null : `${node.path[0]}.${node.path[1]}`;
      const pool = channels.filter((c) => (mid ? c.focus === mid : c.focus.startsWith(node.id + '.')));
      return pool.slice(0, 3).map((c) => (rnd() < BAD_CHANNELS ? pick(channels).id : c.id));
    },
    uploads(chIds) {
      s.units += chIds.length + Math.ceil((chIds.length * 50) / 50); // playlist read + details per 50
      s.wait += 0.6;
      return chIds.flatMap((id) => channels.find((c) => c.id === id).uploads);
    },
    // Search: top results mostly relevant, decaying; broad nodes draw from their whole subtree.
    search(node, n = 50) {
      s.units += 100 + 1;
      s.wait += 0.8;
      const inSub = leaves.filter((l) => within(l.id, node)).flatMap((l) => tail.get(l.id));
      const out = [];
      for (let i = 0; i < n; i++) {
        const p = 0.92 - i * 0.008; // precision decays down the list
        out.push(rnd() < p ? pick(inSub) : makeVideo(pick(leaves).id, 'tail'));
      }
      return out;
    },
    // Claude Haiku judging titles: good, not perfect.
    judge(node, vids, children = []) {
      s.claude += 1;
      s.wait += 1.2;
      return vids.map((v) => {
        const truth = within(v.leaf, node);
        const keep = truth ? rnd() < 0.95 : rnd() < 0.05;
        // Graded: 2 = clearly about it, 1 = partly, 0 = not.
        const r = rnd();
        const e = JUDGE_ERR;
        const grade = truth ? (r < 1 - 0.15 * e ? 2 : r < 1 - 0.05 * e ? 1 : 0) : r < 1 - 0.07 * e ? 0 : r < 1 - 0.01 * e ? 1 : 2;
        // Assign to a child (for inheritance): right child 85% of the time if it belongs.
        let child = null;
        if (keep && children.length) {
          const right = children.find((c) => within(v.leaf, c));
          child = right && rnd() < 0.85 ? right.id : rnd() < 0.5 ? pick(children).id : null;
        }
        return { v, keep, child, grade };
      });
    },
  };
}

// ---------------------------------------------------------------- designs
const kw = (node, broad) => {
  const words = [node.name];
  if (broad) words.push(word(node.path[0])); // concepts include the broad area tag
  return words;
};
const textMatch = (v, words, useDesc) => words.some((w) => v.title.includes(w) || (useDesc && v.desc.includes(w)));
const visible = (vs) => vs.filter((v) => !v.short);
const dedupe = (vs) => [...new Map(vs.map((v) => [v.id, v])).values()];

const designs = {
  // What 0.1.52 does: channel uploads filtered by name+broad tags over title+description; search(30) if < 8.
  A_current(node, a) {
    let c = a.uploads(a.channelsFor(node)).filter((v) => textMatch(v, kw(node, true), true));
    if (c.length < 8) c = dedupe([...c, ...a.search(node, 30)]);
    return visible(c).slice(0, 18);
  },
  // Search only, 50 results, no filtering.
  B_search50(node, a) {
    return visible(a.search(node, 50)).slice(0, 18);
  },
  // Search 50 + Claude judge.
  C_search_judge(node, a) {
    const j = a.judge(node, a.search(node, 50));
    return visible(j.filter((x) => x.keep).map((x) => x.v)).slice(0, 18);
  },
  // Channels with a strict title prefilter (place name in title) + judge; search only if < 12.
  D_channels_judge(node, a) {
    const raw = a.uploads(a.channelsFor(node));
    let kept = a.judge(node, raw).filter((x) => x.keep).map((x) => x.v);
    if (visible(kept).length < 12) kept = dedupe([...kept, ...a.judge(node, a.search(node, 50)).filter((x) => x.keep).map((x) => x.v)]);
    return visible(kept).slice(0, 18);
  },
};

// E: D + inheritance: the judge also sorts kept videos into this place's children,
// so opening a child often needs no fetch at all (one fetch serves a subtree).
function designE(state) {
  return (node, a) => {
    const children = nodes.filter((n) => n.depth === node.depth + 1 && n.id.startsWith(node.id + '.'));
    const inherited = state.get(node.id) ?? [];
    let kept = [...inherited];
    const judgeAndSort = (vids) => {
      const j = a.judge(node, vids, children);
      for (const x of j) {
        if (!x.keep) continue;
        kept.push(x.v);
        if (x.child) state.set(x.child, dedupe([...(state.get(x.child) ?? []), x.v]));
      }
    };
    if (visible(kept).length < 12) judgeAndSort(a.uploads(a.channelsFor(node)));
    if (visible(dedupe(kept)).length < 12) judgeAndSort(a.search(node, 50));
    return visible(dedupe(kept)).slice(0, 18);
  };
}

// ---------------------------------------------------------------- sessions
function sessions(n) {
  seed = 99;
  const out = [];
  for (let s = 0; s < n; s++) {
    const walk = [];
    for (let k = 0; k < 3; k++) {
      const a = Math.floor(rnd() * AREAS), m = Math.floor(rnd() * MIDS);
      walk.push(`${a}`, `${a}.${m}`);
      for (let j = 0; j < 2; j++) walk.push(`${a}.${m}.${Math.floor(rnd() * LEAVES)}`); // two leaves under it
    }
    out.push(walk);
  }
  return out;
}

function run(name, mk) {
  const a = api();
  let pages = 0, shown = 0, rel = 0, under8 = 0;
  for (const walk of sessions(40)) {
    const fn = mk();
    const seen = new Set();
    for (const id of walk) {
      if (seen.has(id)) continue; // revisits are cached by every design
      seen.add(id);
      const node = byId.get(id);
      const before = a.s.wait;
      const vids = fn(node, a);
      pages++;
      shown += vids.length;
      const r = vids.filter((v) => within(v.leaf, node)).length;
      rel += r;
      if (r < 8) under8++;
      void before;
    }
  }
  console.log(
    name.padEnd(18),
    `units/page ${(a.s.units / pages).toFixed(0).padStart(4)}`,
    `| relevant/page ${(rel / pages).toFixed(1).padStart(4)}`,
    `| precision ${((rel / shown) * 100).toFixed(0).padStart(3)}%`,
    `| pages <8 relevant ${((under8 / pages) * 100).toFixed(0).padStart(3)}%`,
    `| claude/page ${(a.s.claude / pages).toFixed(2)}`,
    `| wait/page ${(a.s.wait / pages).toFixed(1)}s`,
  );
}

for (const [name, fn] of Object.entries(designs)) run(name, () => fn);
run('E_inherit', () => designE(new Map()));

// Iteration 2: graded judge; show clear matches first, partial ones only to fill; inherit like E.
function designF(state, minClear = 12) {
  return (node, a) => {
    const children = nodes.filter((n) => n.depth === node.depth + 1 && n.id.startsWith(node.id + '.'));
    const clear = new Map((state.get(node.id) ?? []).map((v) => [v.id, v]));
    const partial = new Map();
    const judgeAndSort = (vids) => {
      for (const x of a.judge(node, vids, children)) {
        if (x.grade === 2) clear.set(x.v.id, x.v);
        else if (x.grade === 1) partial.set(x.v.id, x.v);
        if (x.grade === 2 && x.child) state.set(x.child, dedupe([...(state.get(x.child) ?? []), x.v]));
      }
    };
    const count = () => visible([...clear.values()]).length;
    if (count() < minClear) judgeAndSort(a.uploads(a.channelsFor(node)));
    if (count() < minClear) judgeAndSort(a.search(node, 50));
    return visible([...clear.values(), ...partial.values()]).slice(0, 18);
  };
}
run('F_graded_inherit', () => designF(new Map()));
run('F8_graded_inherit', () => designF(new Map(), 8));

// Iteration 3: everything a page shows is judged against that page, in one call:
// handed-down candidates (from the parent's fetch) plus cheap channel uploads when there are few.
// Search only if fewer than `minClear` clear matches. Clear matches first, partial ones to fill.
function designG(state, minClear = 10, minInherited = 20, partialBelow = 99) {
  return (node, a) => {
    const children = nodes.filter((n) => n.depth === node.depth + 1 && n.id.startsWith(node.id + '.'));
    const clear = new Map();
    const partial = new Map();
    const judgeAll = (vids) => {
      for (const x of a.judge(node, dedupe(vids), children)) {
        if (x.grade === 2) clear.set(x.v.id, x.v);
        else if (x.grade === 1) partial.set(x.v.id, x.v);
        // Hand candidates down to children (judged again there).
        if (x.grade >= 1 && x.child) state.set(x.child, dedupe([...(state.get(x.child) ?? []), x.v]));
      }
    };
    let cands = state.get(node.id) ?? [];
    if (cands.length < minInherited) cands = [...cands, ...a.uploads(a.channelsFor(node))];
    judgeAll(cands);
    if (visible([...clear.values()]).length < minClear) judgeAll(a.search(node, 50));
    const c = visible([...clear.values()]);
    return (c.length < partialBelow ? [...c, ...visible([...partial.values()])] : c).slice(0, 18);
  };
}
run('G_rejudge', () => designG(new Map()));
run('G12_rejudge', () => designG(new Map(), 12));
run('G8_rejudge', () => designG(new Map(), 8));

run('H_clear_only', () => designG(new Map(), 10, 20, 6));
run('H12_clear_only', () => designG(new Map(), 12, 20, 6));
run('H10_inh30', () => designG(new Map(), 10, 30, 6));
