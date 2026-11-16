import { useEffect, useState } from 'react';
import { claudeAuth, type ApiKeys } from '../lib/keys.ts';
import { goodbyeIdea } from '../lib/claude.ts';
import { currentProfile, getState } from '../lib/wander.ts';
import { addMinutes } from '../lib/screenTime.ts';
import { requestPin } from '../lib/pinGate.ts';
import { load, localDate, save } from '../lib/store.ts';
import { sayAloud } from '../lib/voice.ts';

/** TV time is used up for today: a calm goodbye and something to do next. */
export function Goodbye({ keys, onSwitchProfile }: { keys: ApiKeys; onSwitchProfile: () => void }) {
  const me = currentProfile();
  const cacheKey = `goodbye:${me.id}`;
  const cached = load<{ date: string; idea: string }>(cacheKey, { date: '', idea: '' });
  const [idea, setIdea] = useState(cached.date === localDate() ? cached.idea : '');

  useEffect(() => {
    const said = `That’s TV for today, ${me.name}. See you tomorrow!`;
    if (me.options.readAloud) sayAloud(idea ? `${said} ${idea}` : said);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idea]);

  useEffect(() => {
    if (idea) return;
    const auth = claudeAuth(keys);
    if (!auth) return;
    const today = getState().history.filter((h) => localDate(h.at) === localDate()).map((h) => h.title);
    goodbyeIdea(auth, today.slice(-8))
      .then((i) => {
        if (!i) return;
        save(cacheKey, { date: localDate(), idea: i });
        setIdea(i);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="screen goodbye">
      <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
      <h1>
        That’s TV for today, {me.name}.
        <br />
        See you tomorrow!
      </h1>
      {idea && (
        <div className="goodbye-idea">
          <div className="goodbye-label">Something to try now</div>
          <p>{idea}</p>
        </div>
      )}
      <div className="end-actions">
        <button
          className="btn btn-ghost"
          onClick={async () => {
            if (await requestPin(`Add 15 more minutes for ${me.name} today.`)) addMinutes(me.id, 15);
          }}
        >
          Grown-up: +15 min
        </button>
        <button className="btn btn-ghost" onClick={onSwitchProfile}>
          Switch profile
        </button>
      </div>
    </div>
  );
}
