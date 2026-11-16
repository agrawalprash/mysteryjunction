# Wander

An Android app for watching YouTube with a recommendation feed built for variety instead of repetition.

## How the feed works

- **Three distances.** Every day's feed mixes *core* (your interests, new angles), *adjacent* (one step away) and *wildcard* (unrelated) picks, plus hidden gems (few views, high like ratio), older classics, a Watch again row and a separate Shorts section.
- **A pool on the device.** About 1,200 candidate videos are kept on the device and topped up in the background while the app is open (after you watch, on resume, every 20 minutes), mostly from cheap channel reads Claude chooses. New sets (↻, or pull down on the phone) are ranked from the pool instantly with no API calls: Claude's concept tags give a taste match, a small on-device model learns what you finish, and Thompson sampling decides which uncertain topics to explore.
- **Finite.** About 30 videos and 10 shorts per day, then "That's today's picks". "Surprise me" adds up to 3 small wildcard rows per day.
- **No effort.** Learns only from behaviour: finishing a video is a strong yes, leaving within 20 seconds is a mild no, never opening something is a very weak no, searching is a hint. Optional "Less like this" and "Hide channel" buttons exist but aren't needed.
- **Keeps moving.** Shown videos fade fast, watched videos only reappear under Watch again, binged topics rest for a few days, max one video per channel per feed. Wildcards that land graduate into interests.
- **Claude (optional, ~30 cents/day).** With an Anthropic key, Claude:
  - plans the day's search directions from your interests and taste profile,
  - describes each candidate video (subject, format, pace, depth, clickbait), so the app learns which *kinds* of video you like and keeps formats varied,
  - writes a weekly taste profile from your full history (visible in Settings).
  Without a key, a built-in topic list is used. Organization-wide keys also need a workspace ID.
- **New sets on demand.** Besides the daily set, "New set" makes another (YouTube's free quota allows about three a day). The next set is prepared in the background, so it usually appears instantly.
- **Ask Wander.** Speak or type: a mood for now ("music today"), a lasting row ("add a row for live jazz"), an interest to remember, or a rule ("no true crime"). Claude applies it; everything remembered is listed in Settings and can be removed.
- **In-app updates.** The app checks this repo's latest release and installs it with one tap (Android asks once for permission, then confirms each install).
- **Phone as the TV's microphone.** Link the phone app to the TV app with a 6-digit code (same Wi-Fi, no third-party server). Ask on the phone and choose "📺 TV"; the phone can also send the API keys to the TV and sync rows, interests and rules.
- **Diagnose with Claude.** Settings collects a read-only report of the device's voice setup (speech services, permissions, default assistant, remotes, DNS/HTTPS reachability of Google hosts, a live speech test with Android's error code) and Claude explains the likely cause.
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
