// Explore's map of everything: ~14 fixed areas, and below them places Claude draws the first time
// they're opened. Drawn levels are saved, so the map stays the same between visits.
// Kid profiles get their own copy, drawn with the kid instructions.

import { mapChildren, type ClaudeAuth, type MapPlaceInfo } from './claude.ts';
import { activeProfile } from './profiles.ts';
import { load, save } from './store.ts';

export interface MapPlace extends MapPlaceInfo {
  path: string[];
  /** Created from something the viewer asked for. */
  added?: boolean;
}

export interface MapLevel {
  children: MapPlace[];
  elsewhere: MapPlace[];
  /** Only holds places added by asking; Claude hasn't drawn the rest of this level yet. */
  partial?: boolean;
}

const place = (name: string, desc: string, query: string, concepts: string[]): MapPlace => ({ name, desc, query, concepts, path: [name] });

/** Used only until Claude has drawn the top level (or without an Anthropic key). */
export const FALLBACK_AREAS: MapPlace[] = [
  place('Science', 'How the universe, life and matter work', 'science explained documentary', ['science']),
  place('Nature & Animals', 'Wild places and the creatures in them', 'nature documentary animals', ['nature', 'animals']),
  place('History', 'Everything that happened before now', 'history documentary', ['history']),
  place('Places & Cultures', 'Countries, cities and how people live', 'culture travel documentary', ['travel', 'culture']),
  place('Arts & Making', 'Art, craft and making things by hand', 'craft making process art', ['art', 'craft']),
  place('Music', 'Playing, listening and how music works', 'live music performance', ['music']),
  place('Film & Stories', 'Cinema, animation, myths and storytelling', 'film analysis storytelling', ['film', 'stories']),
  place('Technology', 'Computers, machines and inventions', 'technology explained', ['technology']),
  place('Ideas & Society', 'Philosophy, economics, how we live together', 'philosophy ideas explained', ['ideas', 'society']),
  place('Food', 'Cooking, ingredients and food cultures', 'cooking food culture', ['food', 'cooking']),
  place('Sport & Movement', 'Sports, games of skill and the body', 'sport documentary', ['sport']),
  place('Games & Play', 'Video games, board games and puzzles', 'game design video games', ['games']),
  place('How Things Work', 'Everyday things, taken apart', 'how it works engineering', ['how it works', 'engineering']),
  place('Language', 'Words, writing and how we talk', 'language linguistics', ['language']),
];

export const pathId = (path: string[]) => path.map((p) => p.trim().toLowerCase()).join(' › ');

const treeKey = () => `map-tree:${activeProfile().options.playful ? 'kid' : 'adult'}`;
const tree = () => load<Record<string, MapLevel>>(treeKey(), {});

/** A place's own info, from wherever it was seen (an area, a parent's list, or a sideways link). */
/** The top-level areas: Claude's, once drawn, else the fallback list. */
export function topAreas(): MapPlace[] {
  return savedLevel([])?.children ?? FALLBACK_AREAS;
}

export function findPlace(path: string[]): MapPlace {
  if (path.length === 1) {
    const a = topAreas().find((x) => pathId(x.path) === pathId(path)) ?? FALLBACK_AREAS.find((x) => pathId(x.path) === pathId(path));
    if (a) return a;
  }
  const t = tree();
  const parent = t[pathId(path.slice(0, -1))];
  const want = pathId(path);
  const hit = parent?.children.find((c) => pathId(c.path) === want) ?? Object.values(t).flatMap((l) => l.elsewhere).find((c) => pathId(c.path) === want);
  const name = path[path.length - 1];
  return hit ?? { name, desc: '', query: path.slice(-2).join(' '), concepts: [name.toLowerCase()], path };
}

/** A fully drawn level (a partial one, holding only asked-for places, doesn't count). */
export function savedLevel(path: string[]): MapLevel | null {
  const l = tree()[pathId(path)];
  return l && !l.partial ? l : null;
}


const drawing = new Map<string, Promise<MapLevel>>();

/** The places inside `path`: saved, or drawn by Claude now. */
export function levelOf(auth: ClaudeAuth, path: string[]): Promise<MapLevel> {
  const saved = savedLevel(path);
  if (saved) return Promise.resolve(saved);
  const id = pathId(path) + treeKey();
  const running = drawing.get(id);
  if (running) return running;
  const key = treeKey();
  const p = mapChildren(
    auth,
    path,
    topAreas().map((a) => a.name),
  )
    .then((r) => {
      const t = load<Record<string, MapLevel>>(key, {});
      const before = t[pathId(path)];
      const drawn = r.children.map((c) => ({ ...c, path: [...path, c.name] }));
      // Keep places added by asking, unless Claude drew the same one.
      const added = (before?.children ?? []).filter((c) => !drawn.some((d) => pathId(d.path) === pathId(c.path)));
      const level: MapLevel = {
        children: [...drawn, ...added],
        elsewhere: [
          ...(before?.elsewhere ?? []),
          ...r.elsewhere.filter((e) => e.path.length > 0 && pathId(e.path) !== pathId(path)).map((e) => ({ ...e, path: e.path })),
        ],
      };
      t[pathId(path)] = level;
      save(key, t);
      return level;
    })
    .finally(() => drawing.delete(id));
  drawing.set(id, p);
  return p;
}

// ---------------------------------------------------------------- drawing ahead

const queue: { auth: ClaudeAuth; path: string[] }[] = [];
let active = 0;
const AHEAD_AT_ONCE = 3;

function pump() {
  while (active < AHEAD_AT_ONCE && queue.length) {
    const job = queue.shift()!;
    if (savedLevel(job.path)) continue;
    active += 1;
    levelOf(job.auth, job.path)
      .catch(() => undefined)
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

/** Quietly draw what's inside these places, so opening one is instant. Newest requests go first. */
export function drawAhead(auth: ClaudeAuth, paths: string[][]) {
  const todo = paths.filter((p) => !savedLevel(p) && !queue.some((q) => pathId(q.path) === pathId(p)));
  queue.unshift(...todo.map((path) => ({ auth, path })));
  queue.splice(24); // forget stale requests from pages left long ago
  pump();
}

// ---------------------------------------------------------------- places added by asking

/** Places already on the map whose names share a word with the text (to avoid duplicates). */
export function similarPlaces(text: string, limit = 25): string[][] {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
  if (!words.length) return [];
  const all = [...topAreas(), ...Object.values(tree()).flatMap((l) => [...l.children, ...l.elsewhere])];
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const p of all) {
    const name = p.name.toLowerCase();
    const id = pathId(p.path);
    if (seen.has(id) || !words.some((w) => name.includes(w) || w.includes(name))) continue;
    seen.add(id);
    out.push(p.path);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Put an asked-for place on the map (if it isn't there yet), with any missing levels above it,
 * and leave a sideways link from the place the viewer asked from.
 */
export function addPlace(place: MapPlace, from?: string[]) {
  const key = treeKey();
  const t = load<Record<string, MapLevel>>(key, {});
  const path = place.path;
  for (let i = 1; i <= path.length; i++) {
    const parentId = pathId(path.slice(0, i - 1));
    const childPath = path.slice(0, i);
    const level = t[parentId] ?? { children: [], elsewhere: [], partial: true };
    if (!level.children.some((c) => pathId(c.path) === pathId(childPath))) {
      const last = i === path.length;
      level.children.push(
        last
          ? { ...place, added: true }
          : { name: path[i - 1], desc: '', query: path.slice(Math.max(0, i - 2), i).join(' '), concepts: [path[i - 1].toLowerCase()], path: childPath },
      );
    }
    t[parentId] = level;
  }
  if (from?.length && pathId(from) !== pathId(path) && pathId(from) !== pathId(path.slice(0, -1))) {
    const here = t[pathId(from)] ?? { children: [], elsewhere: [], partial: true };
    if (!here.elsewhere.some((e) => pathId(e.path) === pathId(path))) here.elsewhere.unshift({ ...place, added: true });
    t[pathId(from)] = here;
  }
  save(key, t);
}
