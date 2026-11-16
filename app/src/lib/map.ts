// Explore's map of everything: ~14 fixed areas, and below them places Claude draws the first time
// they're opened. Drawn levels are saved, so the map stays the same between visits.
// Kid profiles get their own copy, drawn with the kid instructions.

import { mapChildren, type ClaudeAuth, type MapPlaceInfo } from './claude.ts';
import { activeProfile } from './profiles.ts';
import { load, save } from './store.ts';

export interface MapPlace extends MapPlaceInfo {
  path: string[];
}

export interface MapLevel {
  children: MapPlace[];
  elsewhere: MapPlace[];
}

const place = (name: string, desc: string, query: string, concepts: string[]): MapPlace => ({ name, desc, query, concepts, path: [name] });

export const AREAS: MapPlace[] = [
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
export function findPlace(path: string[]): MapPlace {
  if (path.length === 1) {
    const a = AREAS.find((x) => pathId(x.path) === pathId(path));
    if (a) return a;
  }
  const t = tree();
  const parent = t[pathId(path.slice(0, -1))];
  const want = pathId(path);
  const hit = parent?.children.find((c) => pathId(c.path) === want) ?? Object.values(t).flatMap((l) => l.elsewhere).find((c) => pathId(c.path) === want);
  const name = path[path.length - 1];
  return hit ?? { name, desc: '', query: path.slice(-2).join(' '), concepts: [name.toLowerCase()], path };
}

export function savedLevel(path: string[]): MapLevel | null {
  return tree()[pathId(path)] ?? null;
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
    AREAS.map((a) => a.name),
  )
    .then((r) => {
      const level: MapLevel = {
        children: r.children.map((c) => ({ ...c, path: [...path, c.name] })),
        elsewhere: r.elsewhere.filter((e) => e.path.length > 0 && pathId(e.path) !== pathId(path)).map((e) => ({ ...e, path: e.path })),
      };
      const t = load<Record<string, MapLevel>>(key, {});
      t[pathId(path)] = level;
      save(key, t);
      return level;
    })
    .finally(() => drawing.delete(id));
  drawing.set(id, p);
  return p;
}
