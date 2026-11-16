// Decides whether something said into the remote is a plain search or a request for Claude.
// Clear searches go straight to YouTube (fast); everything else goes to Claude, which can
// still decide it was a search after all.

export type Route = 'search' | 'ask';

const ASK_PATTERNS = [
  /^(show|give|play|find|get) me\b/,
  /^(i|i'd|i would|we|we'd) (want|like|love|feel|need|prefer|am|'m)\b/,
  /^i'?m (in the mood|into|bored|tired)\b/,
  /\bin the mood\b/,
  /^(add|remove|delete|drop|remember|forget|stop|start|make|change|refresh|surprise|suggest|recommend)\b/,
  /^(no|not|less|more|fewer|nothing|something|anything)\b/,
  /\b(new set|fresh set|another set|a row|my feed|my interests?)\b/,
  /^(can|could|would|will) you\b/,
  /^(please|let's|lets)\b/,
  /\b(today|tonight|this evening|right now|for me|i'd enjoy|i would enjoy)\b/,
  /\b(don't|do not|never) show\b/,
];

/** A quick, local guess. Long or chatty phrases go to Claude; short topic-like phrases are searches. */
export function routeUtterance(text: string): Route {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, '');
  if (!t) return 'search';
  if (ASK_PATTERNS.some((p) => p.test(t))) return 'ask';
  const words = t.split(/\s+/).length;
  // Short noun-phrase-like input ("hans zimmer live", "how to sharpen a chisel") reads as a search.
  if (words <= 6) return 'search';
  return 'ask';
}
