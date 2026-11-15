export function formatDuration(sec: number): string {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

export function formatAge(iso: string, now = Date.now()): string {
  if (!iso) return '';
  const days = (now - new Date(iso).getTime()) / 86_400_000;
  if (days < 1) return 'today';
  if (days < 30) return `${Math.floor(days)} day${days >= 2 ? 's' : ''} ago`;
  if (days < 365) return `${Math.floor(days / 30)} month${days >= 60 ? 's' : ''} ago`;
  const y = Math.floor(days / 365);
  return `${y} year${y > 1 ? 's' : ''} ago`;
}

/** YouTube titles come HTML-escaped from some endpoints. */
export function decodeEntities(s: string): string {
  const el = document.createElement('textarea');
  el.innerHTML = s;
  return el.value;
}
