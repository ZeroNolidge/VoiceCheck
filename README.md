# VoiceCheck

A test bot that uses your apps the way a person does, out loud. It opens the app in Chrome, taps through it, **talks into a fake microphone**, and then reports what the app heard, what it said, and what went wrong.

Apps: **xThera** (Tagalog therapist), **xScribe** (live voice HPI) and **PlainSpeak** (AI patient).

## What it checks

- The mic turns on when it should, and off again.
- What you said shows up on screen (the transcript).
- The app talks back, and how long it took to start.
- **Choppy audio**: holes in the app's voice where the sound drops to nothing. Each thing the app said is saved as a WAV you can listen to.
- Talking over the app: does it stop and listen?
- The browser's backup voice being used instead of the real one.
- Console errors, failed requests, and what came over the live connection.

Each run writes `runs/<time>-<app>-<scenario>/report.html` with the problems found, every step, pictures and recordings.

## Two modes

- **Fake AI (default, free).** VoiceCheck plays the AI, the server and the sign-in, so nothing costs money and no account is needed. It tests your app's own voice code: mic, recording, playback, transcript, timing. Run it after every change.
- **Live (`--live`, costs AI credits).** The real AI hears real speech clips. Use it to check the real voice and real speech-to-text. You need clips (`npm run clips`) and, for xScribe and PlainSpeak, a saved test sign-in.

| App | Fake AI | Live |
| --- | --- | --- |
| xThera | yes | yes, against your local copy with keys in `server/.env` |
| xScribe | yes | yes, https://x-scribe-client.vercel.app |
| PlainSpeak | not yet (its voice goes straight to OpenAI over WebRTC) | yes, https://xsims-7ea9f.web.app |

## Set up (once, on your computer)

Needs Node 22+.

```
git clone https://github.com/ZeroNolidge/VoiceCheck && cd VoiceCheck
npm install
npx playwright install chromium
```

## Run

Start the app you're testing (in its own repo), then:

```
npm run check -- xthera                 # every xThera scenario, fake AI
npm run check -- xscribe visit          # one scenario
npm run check -- xscribe all --headed   # watch it happen
npm run list                            # all apps and scenarios
```

Local addresses it expects (change with `--url`):

- **xThera:** `npm run dev` in VirtualTherapist, at http://localhost:5173.
- **xScribe, fake AI:** in xScribe's `client` folder, start it pointed at VoiceCheck's fake sign-in:

  ```
  VITE_SUPABASE_URL=https://xscribefake.supabase.co VITE_SUPABASE_ANON_KEY=fake npx vite --port 5174
  ```

### Live runs

```
npm run clips                           # make the spoken clips (once)
npm run login -- xscribe                # sign in with your TEST account in the window that opens
npm run check -- xscribe visit --live
npm run login -- plainspeak
npm run check -- plainspeak --live
```

`npm run clips` reads keys from the environment or a `.env` file in this folder (git ignores it; never paste keys in chat):

```
OPENAI_API_KEY=...       # English and Spanish lines
CARTESIA_API_KEY=...     # Tagalog lines (native voice)
```

Without keys, English lines use the Mac's own voice. Tagalog needs one of the two keys. Clips are made once and cost a few cents.

Sign-ins are saved in `.auth/` (git ignores it). Use test accounts only.

## Scenarios

- **xThera:** `tagalog` (greeting, three spoken turns, end), `interrupt` (talk while she speaks), `mic-blocked` (mic refused).
- **xScribe:** `visit` (intro, Proceed, three answers, interview complete), `slow-network` (the AI's voice arrives late and unevenly), `interrupt` (talk over the AI).
- **PlainSpeak:** `conversation` (open the first patient, three spoken turns, End).

Add a scenario in `apps/<app>/index.mjs`; lines to say go in `apps/<app>/lines.json`. Steps read like this:

```js
await vc.tap('Start Tagalog test');
await vc.tap(/Magsalita|Tap to talk/);
await vc.say('tl-worry');          // a line from lines.json
await vc.tap(/Tapos na|Done talking/);
await vc.seeHeard();               // the words show on screen
await vc.listen();                 // the app answers; recorded and checked
```

## What it can't do

- Judge accent, tone or whether a reply makes sense. Listen to the saved WAVs for that.
- Find iPhone Safari bugs. It runs Chrome.
- Check the video faces (Simli); those are off in fake mode.

## How it works

`src/inject/page.js` runs inside the app before its own code. It swaps the microphone for one VoiceCheck can speak into, listens to everything the app plays (Web Audio, `<audio>`, WebRTC), and stands in for the browser's voice, which has no voices in headless Chrome. `src/session.mjs` drives the steps; `src/report.mjs` writes the report. `npm test` checks VoiceCheck itself against a small test page.
