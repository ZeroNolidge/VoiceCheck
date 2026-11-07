// xScribe: live voice HPI capture. Voice loop: optional spoken intro
// (MediaRecorder -> /api/transcribe-intro), then Proceed opens the
// live-voice-relay WebSocket: mic goes up as 24 kHz PCM16 chunks, the AI's
// voice comes back as PCM16 deltas plus transcript deltas.
//
// Without --live, VoiceCheck plays every part the app talks to: a signed-in
// test user (Supabase), the API, and the relay (a fake GPT-Live that hears
// when you stop talking and answers with speech-like sound).
import { babble } from '../../src/audio.mjs';
import lines from './lines.json' with { type: 'json' };

const FAKE_SUPABASE = 'https://xscribefake.supabase.co';
const USER = { id: '00000000-0000-4000-8000-00000000c0de', email: 'voicecheck@example.test' };

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (exp) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: USER.id, email: USER.email, role: 'authenticated', aud: 'authenticated', exp })}.voicecheck`;

const PROFILE = {
  user_id: USER.id,
  display_name: 'Dr. Test',
  ai_name: 'Vera',
  ai_introduction: null,
  conversation_tone: 'warm',
  conversation_detail_level: 'standard',
  conversation_custom_instructions: '',
  interview_areas_new: null,
  interview_areas_followup: null,
  symptom_triggers: [],
  summary_attestation_enabled: false,
  summary_attestation_text: null,
  consent_enabled: false, // VoiceCheck tests the interview, not the consent question
  auto_start_after_intro: false,
  live_voice_enabled: true,
};

/** Speech-like PCM16 at 24 kHz, as base64 chunks of `chunkMs`. */
function pcmChunks(seconds, seed, chunkMs = 100) {
  const f = babble(seconds, { rate: 24000, pitch: 200, seed });
  const per = (24000 * chunkMs) / 1000;
  const out = [];
  for (let i = 0; i < f.length; i += per) {
    const s = new Int16Array(Math.min(per, f.length - i));
    for (let k = 0; k < s.length; k++) s[k] = Math.max(-1, Math.min(1, f[i + k])) * 32767;
    out.push(Buffer.from(s.buffer).toString('base64'));
  }
  return out;
}

/**
 * A stand-in for the server's GPT-Live relay.
 * net: 'good' sends audio a little faster than real time (like GPT-Live);
 * 'slow' sends it at real time with random late pieces, to test the app's
 * playback cushion (the cause of choppy audio before).
 */
function fakeRelay(vc, { net = 'good', turnsBeforeDone = 3, wordEveryMs = Number(process.env.VC_WORD_MS) || 200 } = {}) {
  const AI = [
    'Hi, I am Vera, an AI assistant. What brings you in today?',
    'I am sorry to hear that. When did it start, and has it been getting better or worse?',
    'Thank you. Does anything make it better or worse, and have you taken anything for it?',
    'Thanks, that is everything I need. The doctor will be right with you.',
  ];
  return async (ws) => {
    const t0 = Date.now();
    const clock = () => Date.now() - t0;
    let turn = 0;
    let speaking = false; // the AI
    let heardMs = 0; // patient speech in this turn
    let quietMs = 0;
    let busy = false;
    const stats = [];
    vc.relay = { stats, frames: { configure: 0, audio: 0 } };
    vc.extra = { relay: vc.relay }; // xScribe's own audio stats (gaps, lag) show in the report

    const speak = async (text) => {
      if (process.env.VC_DEBUG) console.log('relay: speak start', clock());
      speaking = true;
      const words = text.split(' ');
      const chunks = pcmChunks(Math.max(1.5, words.length / 2.7), turn + 1);
      const start = clock();
      const perWord = Math.max(1, Math.floor(chunks.length / words.length));
      for (let i = 0; i < chunks.length; i++) {
        if (ws.closed) return;
        ws.send(JSON.stringify({ type: 'session.output_audio.delta', delta: chunks[i] }));
        if (i % perWord === 0 && words.length) {
          const w = words.shift();
          ws.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: (i ? ' ' : '') + w, start_ms: start + i * 100, end_ms: start + (i + 1) * 100 }));
        }
        const wait = net === 'slow' ? 100 + (Math.random() < 0.15 ? 250 : 0) : 70;
        await new Promise((r) => setTimeout(r, wait));
      }
      if (words.length) ws.send(JSON.stringify({ type: 'session.output_transcript.delta', delta: ' ' + words.join(' '), start_ms: clock(), end_ms: clock() + 100 }));
      speaking = false;
      if (process.env.VC_DEBUG) console.log('relay: speak sent', clock());
    };

    // Like GPT-Live: the patient's words come back while they talk, a word per ~350 ms of speech.
    let pending = [];
    let lastWordAt = 0;
    const sendWords = (n) => {
      const at = clock();
      const w = pending.splice(0, n);
      if (process.env.VC_DEBUG && w.length) console.log('relay: heard', clock(), w.join(' '), 'aiSpeaking', speaking);
      if (w.length) ws.send(JSON.stringify({ type: 'session.input_transcript.delta', delta: (sentAny ? ' ' : '') + w.join(' '), start_ms: at - 300, end_ms: at }));
      sentAny = sentAny || w.length > 0;
    };
    let sentAny = false;
    const answer = async () => {
      busy = true;
      sendWords(pending.length);
      sentAny = false;
      await new Promise((r) => setTimeout(r, 500));
      turn++;
      if (turn >= turnsBeforeDone) {
        ws.send(JSON.stringify({ type: 'app.interview_complete' }));
        await speak(AI[AI.length - 1]);
      } else {
        await speak(AI[Math.min(turn, AI.length - 2)]);
      }
      busy = false;
    };

    ws.onMessage(async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'client.configure') {
        vc.relay.frames.configure++;
        vc.relay.configure = { language: msg.language, tone: msg.tone, complaintType: msg.complaintType };
        ws.send(JSON.stringify({ type: 'session.started' }));
        setTimeout(() => speak(AI[0]), 300);
      } else if (msg.type === 'session.input_audio.append' && msg.audio) {
        vc.relay.frames.audio++;
        const b = Buffer.from(msg.audio, 'base64');
        const s = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
        let sum = 0;
        for (const v of s) sum += (v / 32768) ** 2;
        const rms = Math.sqrt(sum / (s.length || 1));
        const ms = (s.length / 24000) * 1000;
        if (rms > 0.02) {
          if (heardMs === 0) pending = (vc.lastSaid?.text ?? '').split(' ').filter(Boolean);
          heardMs += ms;
          quietMs = 0;
          if (clock() - lastWordAt >= wordEveryMs) {
            lastWordAt = clock();
            sendWords(1);
          }
        } else quietMs += ms;
        if (!busy && heardMs >= 400 && quietMs >= 700) {
          heardMs = 0;
          void answer();
        }
      } else if (msg.type === 'client.audio_stats') {
        stats.push(msg.stats);
      } else if (msg.type === 'session.close') {
        ws.send(JSON.stringify({ type: 'session.closed' }));
        ws.close();
      }
    });
    ws.onClose(() => {
      ws.closed = true;
    });
  };
}

export default {
  name: 'xscribe',
  title: 'xScribe (live voice HPI)',
  urls: { local: 'http://localhost:5174', live: 'https://x-scribe-client.vercel.app' },
  loginPath: '/login',
  needsLogin: true,
  lines,
  async signedIn(page, timeout) {
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout });
  },

  async fakes(vc) {
    const exp = Math.floor(Date.now() / 1000) + 3600 * 24;
    const session = { access_token: fakeJwt(exp), token_type: 'bearer', expires_in: 86400, expires_at: exp, refresh_token: 'voicecheck', user: { ...USER, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' } };
    await vc.context.addInitScript(
      ([key, s]) => {
        localStorage.setItem(key, JSON.stringify(s));
        localStorage.setItem('xscribe_tour_seen_v1', '1');
      },
      ['sb-xscribefake-auth-token', session],
    );

    // Supabase: auth and the few tables the interview screen reads.
    await vc.fake(`${FAKE_SUPABASE}/**`, (req) => {
      const u = new URL(req.url());
      const one = /vnd\.pgrst\.object/.test(req.headers()['accept'] ?? '');
      const rows = (r) => (one ? r[0] ?? null : r);
      if (u.pathname.startsWith('/auth/v1/user')) return session.user;
      if (u.pathname.startsWith('/auth/v1/token')) return session;
      if (u.pathname === '/rest/v1/rpc/get_entitlements') return [{ tier: 'pro', status: 'active' }];
      if (u.pathname === '/rest/v1/profiles') return req.method() === 'GET' ? rows([PROFILE]) : { status: 204, json: null };
      if (u.pathname === '/rest/v1/entitlements') return rows([{ trial_ends_at: null, stripe_subscription_id: 'sub_voicecheck', cancel_at: null }]);
      if (u.pathname === '/rest/v1/live_voice_sessions') return rows([]);
      if (u.pathname.startsWith('/rest/v1/')) return rows([]);
      return {};
    });

    // The API server.
    vc.ignore.push(/\[api\]/);
    await vc.fake('**/api/transcribe-intro**', () => ({ text: vc.lastSaid?.text ?? '' }));
    await vc.fake('**/api/classify-complaint-type', () => ({ complaintType: 'new' }));
    await vc.fake('**/api/billing/overage-rate', () => ({ centsPerMinute: null, currency: 'usd' }));
    await vc.fake('**/api/clinical-chat', () => ({ summary: 'HPI: VoiceCheck test visit. Patient reports a cough for three days.', hpi: 'Cough for three days.' }));
    await vc.fake('**/api/**', () => ({}));

    // The live voice relay.
    await vc.context.routeWebSocket(/live-voice-relay/, fakeRelay(vc, vc.relayOptions));
    await vc.context.routeWebSocket(/voice-preview-relay/, (ws) => ws.onMessage(() => {}));
  },

  scenarios: {
    /** A full voice visit: intro, Proceed, three answers, interview complete. */
    async visit(vc) {
      await vc.open('/interview');
      await vc.see(/Proceed/, { timeout: 20000 });
      await vc.screenshot('ready');
      await vc.tap(/Tap to introduce|introduce/i);
      await vc.micShouldBe(true);
      await vc.say('intro');
      await vc.tap(/Stop|Done|Finish|introduce/i, { timeout: 5000 }).catch(() => {});
      await vc.seeHeard({ label: 'Intro shows on screen' });
      await vc.tap(/Proceed/);
      await vc.micShouldBe(true);
      await vc.listen({ label: 'AI introduces itself' });
      for (const line of ['cough', 'cough-onset', 'cough-meds']) {
        await vc.say(line);
        await vc.seeHeard();
        await vc.listen({ label: 'AI answers' });
      }
      await vc.see(/complete|summary|follow-up|Provider/i, { soft: true, label: 'Interview marked complete' });
      await vc.micShouldBe(false, { timeout: 15000 });
    },

    /** Same visit with a slow, uneven connection: the AI's voice should still be smooth. */
    async 'slow-network'(vc) {
      await vc.open('/interview');
      await vc.see(/Proceed/, { timeout: 20000 });
      await vc.tap(/Proceed/);
      await vc.listen({ label: 'AI introduces itself (slow network)' });
      await vc.say('cough');
      await vc.seeHeard();
      await vc.listen({ label: 'AI answers (slow network)' });
    },

    /** Talking over the AI: it should stop and listen. */
    async interrupt(vc) {
      await vc.open('/interview');
      await vc.see(/Proceed/, { timeout: 20000 });
      await vc.tap(/Proceed/);
      await vc.talking({ label: 'AI starts its greeting' });
      await vc.wait(600);
      await vc.say('cough', { background: true });
      await vc.quiet({ within: 1500, label: 'AI stops when talked over' });
      await vc.sayDone();
      await vc.seeHeard();
      await vc.listen({ label: 'AI answers after being talked over' });
    },
  },
  options: {},
  relayOptions: { 'slow-network': { net: 'slow' } },
};
