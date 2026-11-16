import { useEffect, useState } from 'react';
import { claudeAuth, type ApiKeys } from '../lib/keys.ts';
import { linkedTv, sendToTv } from '../lib/link.ts';
import { listProfiles, PRESET_LABELS, type WanderProfile } from '../lib/profiles.ts';
import { currentProfile, guideProfile, profileReport, type ProfileReport } from '../lib/wander.ts';
import { suggestGuidance, type GuidanceIdea } from '../lib/claude.ts';
import { Avatar } from './Profiles.tsx';
import { HoldToTalk } from './HoldToTalk.tsx';
import { addMinutes } from '../lib/screenTime.ts';

interface ReportReply {
  profiles: WanderProfile[];
  active: string;
  report: ProfileReport;
}

type Source = 'tv' | 'here';
type Change = { addRule?: string; forget?: { kind: 'row' | 'interest' | 'rule'; value: string } };

function ago(ts: number) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** What a profile is into, how Claude reads them, and the instructions Claude follows for them. */
export function Report({ keys, onBack }: { keys: ApiKeys; onBack: () => void }) {
  const [source, setSource] = useState<Source>(linkedTv() ? 'tv' : 'here');
  const [profileId, setProfileId] = useState<string | undefined>(undefined);
  const [data, setData] = useState<ReportReply | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [ideas, setIdeas] = useState<GuidanceIdea[] | null>(null);
  const [ideasBusy, setIdeasBusy] = useState(false);

  const fetchReport = async (id?: string, change?: Change): Promise<ReportReply> => {
    if (source === 'tv') {
      if (change && id) return (await sendToTv({ type: 'guide', profileId: id, ...change })) as ReportReply;
      return (await sendToTv({ type: 'report', profileId: id })) as ReportReply;
    }
    const pid = id ?? currentProfile().id;
    if (change) guideProfile(pid, change);
    return { profiles: listProfiles(), active: currentProfile().id, report: profileReport(pid) };
  };

  const load = async (id?: string, change?: Change) => {
    try {
      const r = await fetchReport(id, change);
      setData(r);
      setProfileId(r.report.profile.id);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    setData(null);
    setIdeas(null);
    void load(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const r = data?.report;
  const name = r?.profile.name ?? '';
  const kid = r?.profile.preset === 'kid';

  const addRule = (text: string) => {
    const t = text.trim();
    if (!t || !profileId) return;
    setDraft('');
    setIdeas((xs) => xs?.filter((x) => x.instruction !== t) ?? null);
    void load(profileId, { addRule: t });
  };

  const extend = async (minutes: number) => {
    if (!profileId) return;
    try {
      if (source === 'tv') setData((await sendToTv({ type: 'extend', profileId, minutes })) as ReportReply);
      else {
        addMinutes(profileId, minutes);
        void load(profileId);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const getIdeas = async () => {
    const auth = claudeAuth(keys);
    if (!auth || !r) return;
    setIdeasBusy(true);
    try {
      setIdeas(
        await suggestGuidance(auth, {
          name: r.profile.name,
          kid,
          into: r.into,
          notLanding: r.notLanding,
          tasteSummary: r.taste?.summary ?? '',
          recentTitles: r.recent.map((w) => w.title),
          rules: r.told.rules,
          minutesThisWeek: r.minutesThisWeek,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIdeasBusy(false);
    }
  };

  return (
    <div className="screen report">
      <header className="topbar">
        <button className="icon-btn" aria-label="Back" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" /></svg>
        </button>
        <div className="topbar-title">Profile report</div>
      </header>

      {linkedTv() && (
        <div className="target-row">
          <button className={`chip${source === 'tv' ? ' chip-on' : ''}`} onClick={() => setSource('tv')}>
            📺 On the TV
          </button>
          <button className={`chip${source === 'here' ? ' chip-on' : ''}`} onClick={() => setSource('here')}>
            On this phone
          </button>
        </div>
      )}
      {error && <p className="small error-text report-pad">{source === 'tv' ? `Can’t reach the TV (is Wander open on it?): ${error}` : error}</p>}

      {data && data.profiles.length > 1 && (
        <div className="profile-list report-pad">
          {data.profiles.map((p) => (
            <button
              key={p.id}
              className={`chip profile-chip${p.id === profileId ? ' chip-on' : ''}`}
              onClick={() => {
                setIdeas(null);
                void load(p.id);
              }}
            >
              <Avatar id={p.id} name={p.name} /> {p.name}
            </button>
          ))}
        </div>
      )}

      {r && (
        <>
          <section className="panel">
            <div className="report-head">
              <Avatar id={r.profile.id} name={r.profile.name} big />
              <div>
                <h2>{name}</h2>
                <p className="muted small">
                  {PRESET_LABELS[r.profile.preset]} · this week: {r.videosThisWeek} videos, {r.minutesThisWeek} min · {r.watchedTotal} watched in all
                </p>
              </div>
            </div>
            {r.time && (
              <div className="report-time">
                <span>
                  TV today: <strong>{r.time.usedMin}</strong> of {r.time.budgetMin} min
                  {r.time.leftSec <= 0 ? ' · time’s up' : ` · ${Math.ceil(r.time.leftSec / 60)} left`}
                </span>
                <button className="btn btn-ghost" onClick={() => void extend(15)}>
                  +15 min today
                </button>
              </div>
            )}
          </section>

          <section className="panel">
            <h3>Into right now</h3>
            {r.into.length ? (
              <div className="chips-wrap">{r.into.map((t) => <span key={t} className="tag tag-big">{t}</span>)}</div>
            ) : (
              <p className="muted small">Nothing clear yet. This fills in after a few videos.</p>
            )}
            {r.notLanding.length > 0 && (
              <>
                <h4>Not landing lately</h4>
                <div className="chips-wrap">{r.notLanding.map((t) => <span key={t} className="tag">{t}</span>)}</div>
              </>
            )}
          </section>

          {r.taste && (
            <section className="panel">
              <h3>Claude’s read</h3>
              <p>{r.taste.summary}</p>
              {r.taste.curiousAbout.length > 0 && (
                <p className="small">
                  <strong>Curious about:</strong> {r.taste.curiousAbout.join(' · ')}
                </p>
              )}
              {r.taste.formatsLiked.length > 0 && (
                <p className="small">
                  <strong>Formats that land:</strong> {r.taste.formatsLiked.join(' · ')}
                </p>
              )}
            </section>
          )}

          <section className="panel">
            <h3>Instructions for Claude</h3>
            <p className="muted small">Claude follows these every time it plans what {name} sees.</p>
            {r.told.rules.length + r.told.pinned.length + r.told.customRows.length > 0 && (
              <ul className="told">
                {r.told.rules.map((x) => (
                  <li key={x}>
                    <span>{x}</span>
                    <button className="chip" onClick={() => void load(profileId, { forget: { kind: 'rule', value: x } })}>Remove</button>
                  </li>
                ))}
                {r.told.pinned.map((x) => (
                  <li key={x}>
                    <span><span className="tag">interest</span> {x}</span>
                    <button className="chip" onClick={() => void load(profileId, { forget: { kind: 'interest', value: x } })}>Remove</button>
                  </li>
                ))}
                {r.told.customRows.map((x) => (
                  <li key={x.id}>
                    <span><span className="tag">row</span> {x.title}</span>
                    <button className="chip" onClick={() => void load(profileId, { forget: { kind: 'row', value: x.id } })}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="ask-form"
              onSubmit={(e) => {
                e.preventDefault();
                addRule(draft);
              }}
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={kid ? 'e.g. More animals and how things work, fewer gaming videos' : 'e.g. More long documentaries on weekends'}
                enterKeyHint="done"
              />
            </form>
            <div className="end-actions left">
              <button className="btn" disabled={!draft.trim()} onClick={() => addRule(draft)}>
                Add
              </button>
              <HoldToTalk label="Hold to say it" onSaid={addRule} />
            </div>

            {keys.anthropic && (
              <>
                <h4>Ideas from Claude</h4>
                {!ideas && (
                  <button className="btn btn-ghost" disabled={ideasBusy} onClick={getIdeas}>
                    {ideasBusy ? 'Claude is reading the report…' : `✦ Suggest instructions for ${name}`}
                  </button>
                )}
                {ideas && (
                  <ul className="told">
                    {ideas.map((i) => (
                      <li key={i.instruction}>
                        <span>
                          {i.instruction}
                          <span className="muted small block">{i.why}</span>
                        </span>
                        <button className="chip" onClick={() => addRule(i.instruction)}>Add</button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>

          {r.recent.length > 0 && (
            <section className="panel">
              <h3>Recently watched</h3>
              <ul className="report-recent">
                {r.recent.map((w, i) => (
                  <li key={i}>
                    <span>{w.title}</span>
                    <span className="muted small">
                      {w.channel} · {ago(w.at)} · {Math.round(w.fraction * 100)}% watched
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {r.pool && (
            <p className="muted small report-pad">
              Video pool: {r.pool.total} ({r.pool.fresh} not shown yet, {r.pool.described} described by Claude).
            </p>
          )}
        </>
      )}
    </div>
  );
}
