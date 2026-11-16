import type { Candidate, DailyFeed } from '../engine/types.ts';
import { VideoCard } from './VideoCard.tsx';

type Pick = { video: Candidate; label: string };

const GROUPS: { label: string; tiers: Candidate['tier'][] }[] = [
  { label: 'You love this', tiers: ['core', 'custom', 'focus', 'search'] },
  { label: 'Try next', tiers: ['adjacent'] },
  { label: 'Something new', tiers: ['wildcard', 'archive'] },
];

/** Six picks from the set: two favourites, two next steps, two new things. `round` shows the next six. */
export function pickSix(feed: DailyFeed, round: number): Pick[] {
  const all = feed.rows.flatMap((r) => r.items);
  const seen = new Set<string>();
  const unique = all.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)));
  const out: Pick[] = [];
  const used = new Set<string>();
  for (const g of GROUPS) {
    const pool = unique.filter((v) => g.tiers.includes(v.tier));
    for (const v of pool.slice(round * 2, round * 2 + 2)) {
      out.push({ video: v, label: g.label });
      used.add(v.id);
    }
  }
  // Not enough of one kind: fill from the rest, in order.
  const rest = unique.filter((v) => !used.has(v.id));
  for (const v of rest.slice(round * 6)) {
    if (out.length >= 6) break;
    out.push({ video: v, label: 'Something new' });
  }
  return out;
}

export function KidHome({
  feed,
  round,
  open,
  opened,
}: {
  feed: DailyFeed;
  round: number;
  open: (v: Candidate) => void;
  opened: Set<string>;
}) {
  const picks = pickSix(feed, round);
  return (
    <main className="kid-home">
      <div className="kid-grid">
        {picks.map((p) => (
          <VideoCard key={p.video.id} video={p.video} onOpen={open} variant="kid" label={p.label} watched={opened.has(p.video.id)} />
        ))}
      </div>
    </main>
  );
}
