// Retrieval helpers shared by Home and Explore's map. The design (see tools/retrieval-sim.mjs, which
// compares the alternatives on quota, relevance and wait time):
//   candidates from cheap sources first (handed down from a parent page, channel uploads: ~1 unit each),
//   one fast Claude grade of everything against the page, a 100-unit search only when too few are clear,
//   show clear matches, fill with partial ones only when a page would look empty.

const STOPWORDS = new Set(
  'the and for with from that this what when where which into about over your their there these those than then them they have has had were was are how why who its it\'s our out all any can not but more most some such very just only also like make made best new old part parts world'.split(' '),
);

/** Meaningful words from names and tags (no filler words, nothing shorter than 4 letters). */
export function topicWords(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts)
    for (const w of t.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length >= 4 && !STOPWORDS.has(w)) out.add(w);
  return [...out];
}

/** Does the title mention any of the words? (Titles only: descriptions are full of unrelated boilerplate.) */
export function titleMentions(title: string, words: string[]): boolean {
  const t = title.toLowerCase();
  return words.some((w) => t.includes(w));
}

/** Take n items, those whose title mentions the topic first, the rest at random. */
export function lexicalFirst<T extends { title: string }>(items: T[], words: string[], n: number, rng: () => number = Math.random): T[] {
  const shuffled = items.map((x) => ({ x, r: rng() })).sort((a, b) => a.r - b.r).map((o) => o.x);
  const hits = shuffled.filter((x) => titleMentions(x.title, words));
  const rest = shuffled.filter((x) => !titleMentions(x.title, words));
  return [...hits, ...rest].slice(0, n);
}

/** What a page shows: clear matches; partial ones only to fill a page that would otherwise look empty. */
export function pickForPage<T>(clear: T[], partial: T[], max = 18, fillBelow = 6): T[] {
  return (clear.length < fillBelow ? [...clear, ...partial] : clear).slice(0, max);
}

/** Enough clear matches that no search is needed. */
export const ENOUGH_CLEAR = 10;
/** Fewer handed-down candidates than this: read the place's channels too. */
export const ENOUGH_CANDIDATES = 20;
