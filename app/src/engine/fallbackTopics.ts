// Used when no Anthropic key is set or the planner call fails.
// Deliberately broad: crafts, science, history, music, places, people, ideas.

export const WILDCARD_TOPICS: string[] = [
  'deep sea creatures', 'Japanese woodblock printing', 'how bridges are built', 'origami engineering',
  'history of the printing press', 'tidal power', 'Mongolian throat singing', 'urban beekeeping',
  'restoring old watches', 'how glass is made', 'Antarctic research stations', 'the science of sourdough',
  'Byzantine empire', 'blacksmithing', 'how cartographers made old maps', 'bird migration',
  'Indian classical music ragas', 'abandoned railways', 'cave diving', 'the physics of skateboarding',
  'traditional boat building', 'Roman concrete', 'competitive memory sports', 'mushroom foraging',
  'history of typography', 'volcano monitoring', 'Persian carpets', 'how lighthouses work',
  'chess endgames explained', 'microscopic pond life', 'Silk Road trade', 'jazz improvisation',
  'stop motion animation', 'how submarines work', 'Inca road system', 'calligraphy',
  'wind tunnel testing', 'Norse sagas', 'tea ceremony', 'restoring vintage synthesizers',
  'architecture of mosques', 'the history of zero', 'bonsai', 'Arctic sled dogs',
  'mechanical computers', 'lost languages deciphered', 'street food of Vietnam', 'coral reef restoration',
  'medieval castle siege engines', 'glassblowing', 'how pianos are tuned', 'desert ecology',
  'history of the bicycle', 'paper marbling', 'radio astronomy', 'ancient Egyptian tools',
  'beatboxing', 'how maps of the ocean floor are made', 'sumo wrestling culture', 'Victorian inventions',
  'tiny house building', 'falconry', 'Andean weaving', 'how elevators work',
  'shipwreck archaeology', 'flamenco', 'insect architecture', 'repairing old books',
  'nuclear fusion experiments', 'Moroccan tilework', 'speedrunning history', 'whale songs',
];

export const SHORTS_TOPICS: string[] = [
  'satisfying craftsmanship', 'science experiments', 'nature close up', 'street food',
  'tiny art', 'amazing animals', 'history in 60 seconds', 'cooking tricks',
];

export function sampleWithout<T>(items: T[], n: number, avoid: Set<T>, rng = Math.random): T[] {
  const pool = items.filter((x) => !avoid.has(x));
  const out: T[] = [];
  while (out.length < n && pool.length > 0) {
    out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  }
  return out;
}
