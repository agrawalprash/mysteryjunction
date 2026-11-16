import { useState } from 'react';
import { addProfile, listProfiles, needsPin, parentPin, PRESET_LABELS, setParentPin, updateProfile, type Preset, type ProfileOptions } from '../lib/profiles.ts';
import { currentProfile, removeProfile, switchProfile } from '../lib/wander.ts';
import { requestPin } from '../lib/pinGate.ts';

const COLORS = ['#e8a33d', '#5cc8be', '#f08a6c', '#8f7cf0', '#6cb4f0', '#9ccc65'];
export function profileColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function Avatar({ id, name, big = false }: { id: string; name: string; big?: boolean }) {
  return (
    <span className={`avatar${big ? ' avatar-big' : ''}`} style={{ background: profileColor(id) }} aria-hidden="true">
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

/** "Who's watching?" Picking a profile switches all of Wander to it. */
export function ProfilePicker({ onDone, onManage }: { onDone: () => void; onManage: () => void }) {
  const profiles = listProfiles();
  const active = currentProfile().id;
  return (
    <div className="screen profile-picker">
      <h1>Who’s watching?</h1>
      <div className="profile-grid">
        {profiles.map((p) => (
          <button
            key={p.id}
            className={`profile-card${p.id === active ? ' profile-current' : ''}`}
            onClick={async () => {
              if (needsPin(p) && !(await requestPin(`Switch to ${p.name}.`))) return;
              switchProfile(p.id);
              onDone();
            }}
          >
            <Avatar id={p.id} name={p.name} big />
            <span className="profile-name">{p.name}</span>
            <span className="muted small">{PRESET_LABELS[p.preset]}</span>
          </button>
        ))}
      </div>
      <button className="btn btn-ghost" onClick={onManage}>
        Add or edit profiles
      </button>
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="field">
      <span>
        {label}
        <span className="muted small block">{hint}</span>
      </span>
      <select value={checked ? 'on' : 'off'} onChange={(e) => onChange(e.target.value === 'on')}>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </label>
  );
}

/** Settings panel: the profiles on this device, and the active one's options. */
export function ProfilesPanel({ onSwitched }: { onSwitched: () => void }) {
  const [, force] = useState(0);
  const refresh = () => force((n) => n + 1);
  const [newName, setNewName] = useState('');
  const [newPreset, setNewPreset] = useState<Preset>('kid');
  const [pinDraft, setPinDraft] = useState('');
  const profiles = listProfiles();
  const me = currentProfile();
  const setOpt = (patch: Partial<ProfileOptions>) => {
    updateProfile(me.id, { options: patch });
    refresh();
  };

  return (
    <section className="panel">
      <h3>Profiles</h3>
      <p className="muted small">
        Everyone gets the same Wander. Each profile learns its own taste and keeps its own history. A preset only sets the starting options.
      </p>
      <div className="profile-list">
        {profiles.map((p) => (
          <button
            key={p.id}
            className={`chip profile-chip${p.id === me.id ? ' chip-on' : ''}`}
            onClick={() => {
              switchProfile(p.id);
              onSwitched();
              refresh();
            }}
          >
            <Avatar id={p.id} name={p.name} /> {p.name}
          </button>
        ))}
      </div>

      <h4>{me.name}’s options</h4>
      <label className="field">
        <span>Name</span>
        <input
          type="text"
          defaultValue={me.name}
          key={me.id}
          onBlur={(e) => {
            if (e.target.value.trim() && e.target.value.trim() !== me.name) {
              updateProfile(me.id, { name: e.target.value.trim() });
              refresh();
            }
          }}
        />
      </label>
      <label className="field">
        <span>
          Preset
          <span className="muted small block">Changing it resets the options below.</span>
        </span>
        <select
          value={me.preset}
          onChange={(e) => {
            updateProfile(me.id, { preset: e.target.value as Preset });
            refresh();
          }}
        >
          <option value="adult">{PRESET_LABELS.adult}</option>
          <option value="kid">{PRESET_LABELS.kid}</option>
        </select>
      </label>
      <Toggle
        label="Playful Claude"
        hint="Claude plans, suggests and replies for a young child: safe, curious, creative, simple words."
        checked={me.options.playful}
        onChange={(v) => setOpt({ playful: v })}
      />
      <Toggle
        label="Strict SafeSearch"
        hint="YouTube’s strictest filter on every search this profile makes."
        checked={me.options.strictSafeSearch}
        onChange={(v) => setOpt({ strictSafeSearch: v })}
      />
      <Toggle
        label="Read aloud on the TV"
        hint="When a video is picked out with the remote, the TV reads its “why this” line."
        checked={me.options.readAloud}
        onChange={(v) => setOpt({ readAloud: v })}
      />
      <Toggle
        label="Claude checks every video"
        hint="Only videos Claude judges clearly suitable for a young child are shown, searches included."
        checked={me.options.contentCheck}
        onChange={(v) => setOpt({ contentCheck: v })}
      />
      <Toggle
        label="Simple home"
        hint="Six big picks instead of rows, with bigger text and tiles."
        checked={me.options.simpleHome}
        onChange={(v) => setOpt({ simpleHome: v })}
      />
      <Toggle
        label="Daily TV time"
        hint="A visible timer, a notice before the last video, then a goodbye. Videos are never cut off."
        checked={me.options.timer}
        onChange={(v) => setOpt({ timer: v })}
      />
      {me.options.timer && (
        <label className="field">
          <span>Minutes a day</span>
          <select value={me.options.dailyMinutes} onChange={(e) => setOpt({ dailyMinutes: Number(e.target.value) })}>
            {[15, 20, 30, 45, 60, 75, 90, 120, 180].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      )}

      {me.id !== 'main' && (
        <button
          className="btn btn-danger"
          onClick={() => {
            if (confirm(`Delete ${me.name} and everything Wander learned for them?`)) {
              removeProfile(me.id, 'main');
              onSwitched();
              refresh();
            }
          }}
        >
          Delete {me.name}
        </button>
      )}

      <h4>Grown-up PIN</h4>
      <p className="muted small">
        {parentPin()
          ? 'Set. It’s needed to leave a kid profile, open Settings from one, or add time.'
          : 'Keeps a child in their profile: needed to switch to a grown-up profile, open Settings, or add time.'}
      </p>
      <div className="end-actions left">
        <input
          className="pin-input"
          type="password"
          inputMode="numeric"
          maxLength={4}
          placeholder="4 digits"
          value={pinDraft}
          onChange={(e) => setPinDraft(e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
        <button
          className="btn btn-ghost"
          disabled={pinDraft.length !== 4}
          onClick={() => {
            setParentPin(pinDraft);
            setPinDraft('');
            refresh();
          }}
        >
          {parentPin() ? 'Change PIN' : 'Set PIN'}
        </button>
        {parentPin() && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              setParentPin('');
              refresh();
            }}
          >
            Remove
          </button>
        )}
      </div>

      <h4>Add a profile</h4>
      <label className="field">
        <span>Name</span>
        <input type="text" value={newName} placeholder="e.g. Kid" onChange={(e) => setNewName(e.target.value)} />
      </label>
      <label className="field">
        <span>Preset</span>
        <select value={newPreset} onChange={(e) => setNewPreset(e.target.value as Preset)}>
          <option value="kid">{PRESET_LABELS.kid}</option>
          <option value="adult">{PRESET_LABELS.adult}</option>
        </select>
      </label>
      <button
        className="btn"
        onClick={() => {
          const p = addProfile(newName, newPreset);
          setNewName('');
          switchProfile(p.id);
          onSwitched();
          refresh();
        }}
      >
        Add and switch to it
      </button>
    </section>
  );
}
