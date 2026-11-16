# Wander: notes for Claude sessions

The repo root is a Jekyll site (unrelated). **The app lives in `app/`**: Wander, an Android app (phone + Android TV)
for variety-first YouTube, built with Capacitor 8 + React 19 + Vite + TypeScript.

## How the owner works with you

- They give feedback; you build, push, wait for CI, open a PR to `master` and merge it; they press Update on the TV.
  Each change: commit → push to the session branch → CI (`.github/workflows/android.yml`) builds a signed APK and
  publishes a GitHub release → PR → merge once CI is green. Merges to `master` don't build.
- They follow along on a phone. Keep replies short and plain; say what changed and what wasn't tested on a real device.
- Design: clean and minimal. One UI element per function: if two things do the same job, keep one and remove the other.
  Nothing hardcoded to one interest (e.g. "Minecraft" is only ever example data).
- Ask is the single way in for anything said or typed (phone remote voice, Explore's bar): Claude routes it to a place on
  the map (found or created), a search, or a change.
- The app UI is always English (the TV's system language is German).

## Build and test

```
cd app
npm ci
npm test            # node --test on src/engine/*.test.ts and src/lib/*.test.ts
npm run build       # tsc --noEmit + vite build
```
Playwright is preinstalled for UI checks against `npx vite preview` (mock YouTube and Anthropic with `context.route`).
Native code (Java, `app/android/app/src/main/java/io/github/agrawalprash/wander/`) only compiles in CI.

## Shape of the app

- `src/engine/`: pure, tested logic. Pool of ~1200 videos, ranking (concept taste, online logistic regression,
  Thompson sampling), set assembly with variety tiers (core/adjacent/wildcard/archive/shorts/focus/custom).
- `src/lib/wander.ts`: per-profile state and the pipeline (refill in the background, instant sets from the pool,
  Ask, search, reports, Explore). `profiles.ts`: profiles, presets (Grown-up, Kid), options, parent PIN.
  `claude.ts`: every Claude call (model `claude-opus-5-5`, structured outputs, `forProfile()` adds kid instructions).
  `youtube.ts`: Data API with caches and quota tracking. `link.ts`: phone ↔ TV over Wi-Fi (pairing code).
  `screenTime.ts`: daily TV time per profile.
- `src/ui/`: Home (rows, or six picks for kids), Explore (hub → map pages at any depth / results page; `lib/map.ts` keeps the map), Player, Remote (phone
  touchpad remote for the TV), Report (phone: per-profile report and instructions for Claude), Settings, Goodbye,
  PinPad. TV navigation is custom (`lib/spatialNav.ts`), sizes in rem on TV.

## Rules

- API keys are entered on the device and kept in Android encrypted storage. Never put keys in the repo.
- Profiles share one engine; differences are options on the profile. Kid safety: Claude's `kidSafe` tag must be true
  for anything a kid profile sees (searches included), strict SafeSearch, playful Claude prompts, PIN to leave.
