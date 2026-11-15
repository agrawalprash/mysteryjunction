# Wander

An Android app for watching YouTube with a recommendation feed built for variety instead of repetition.

## How the feed works

- **Three distances.** Every day's feed mixes *core* (your interests, new angles), *adjacent* (one step away) and *wildcard* (unrelated) picks, plus hidden gems (few views, high like ratio), older classics, a Watch again row and a separate Shorts section.
- **Finite.** About 30 videos and 10 shorts per day, then "That's today's picks". "Surprise me" adds up to 3 small wildcard rows per day.
- **No effort.** Learns only from behaviour: finishing a video is a strong yes, leaving within 20 seconds is a mild no, never opening something is a very weak no, searching is a hint. Optional "Less like this" and "Hide channel" buttons exist but aren't needed.
- **Keeps moving.** Shown videos fade fast, watched videos only reappear under Watch again, binged topics rest for a few days, max one video per channel per feed. Wildcards that land graduate into interests.
- **Claude (optional, ~30 cents/day).** With an Anthropic key, Claude:
  - plans the day's search directions from your interests and taste profile,
  - describes each candidate video (subject, format, pace, depth, clickbait), so the app learns which *kinds* of video you like and keeps formats varied,
  - writes a weekly taste profile from your full history (visible in Settings).
  Without a key, a built-in topic list is used. Organization-wide keys also need a workspace ID.
- **TV mode.** On Android TV the app shows up on the home screen, uses a larger layout, and works with the remote (arrows move, OK opens; in the player OK pauses, left/right skip 10 seconds, down shows details). Can be forced on or off in Settings.

Code map: `src/engine/` (interest model and feed assembly, unit tested), `src/lib/` (YouTube, Claude, storage), `src/ui/` (screens), `android/` (Capacitor project, incl. fullscreen video support in `MainActivity.java`).

## Develop

```sh
npm install
npm test          # engine unit tests
npm run dev       # web preview at localhost:5173
npm run build && npx cap sync android   # then build with Android Studio or ./gradlew
```

## Releases

Every push that touches `app/` runs `.github/workflows/android.yml`, which builds a signed APK and publishes it on the repository's Releases page. Each build has a higher version code, so installing it updates the app in place and keeps your keys and history.

**Signing key:** `android/wander-release.jks` is committed so every build is signed with the same key without any setup. Because this repository is public, someone could in principle sign a fake update; only install APKs from this repo's Releases page.

## Installing on Android TV

Install the free "Downloader" app from the TV's app store, allow it to install unknown apps, and open
`https://github.com/agrawalprash/mysteryjunction/releases/latest/download/Wander.apk`.
To enter API keys without typing on the remote, use the Google TV app on your phone as a keyboard and paste them.

## Keys

Entered once on first launch and stored in Android's encrypted storage (Android Keystore). They are never in the code or the repository.
