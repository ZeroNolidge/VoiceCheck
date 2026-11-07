// VoiceCheck: one test run against one app. Scenarios call these methods
// the way a person would use the app: open, tap, talk, listen, look.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { launch } from './browser.mjs';
import { analyzeLevels, babble, readWav, secondsForText, wavFromFloat, wavFromInt16 } from './audio.mjs';
import { writeReport } from './report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE_SCRIPT = path.join(here, 'inject', 'page.js');
export const ROOT = path.resolve(here, '..');

export class StepFailed extends Error {}

/** Addresses go in reports without their query: it can hold sign-in tokens. */
const noQuery = (u) => String(u).split(/[?#]/)[0].slice(0, 200);

export class VoiceCheck {
  /**
   * @param {object} o
   * @param {string} o.app       app name (folder under apps/)
   * @param {string} o.scenario  scenario name
   * @param {string} o.baseUrl   where the app runs
   * @param {boolean} o.live     real AI (true) or faked (false)
   * @param {object} [o.lines]   the scripted lines the test can say, by id
   * @param {boolean} [o.headed] show the browser window
   * @param {boolean} [o.phone]  phone-size screen (default true)
   * @param {string} [o.outDir]
   */
  constructor(o) {
    Object.assign(this, { phone: true, headed: false, lines: {}, ...o });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.outDir ??= path.join(ROOT, 'runs', `${stamp}-${o.app}-${o.scenario}`);
    this.steps = [];
    this.nodeEvents = [];
    this.utterances = []; // what the app said, one entry per waitForAppSpeech
    this.said = []; // what the test said
    this.lastSaid = null;
    this.shots = 0;
    this.ignore = []; // RegExps for messages a scenario expects (e.g. a fake server's gaps)
  }

  // ---------- setup / teardown ----------
  async start() {
    await mkdir(this.outDir, { recursive: true });
    this.browser = await launch({ headed: this.headed });
    this.context = await this.browser.newContext({
      viewport: this.phone ? { width: 390, height: 844 } : { width: 1280, height: 860 },
      deviceScaleFactor: 2,
      isMobile: false,
      hasTouch: this.phone,
      permissions: ['microphone'],
      storageState: this.storageState,
      recordVideo: this.video ? { dir: this.outDir, size: { width: 390, height: 844 } } : undefined,
    });
    await this.context.addInitScript({ content: `window.__vcOptions = ${JSON.stringify(this.pageOptions ?? {})};` });
    await this.context.addInitScript({ path: PAGE_SCRIPT });
    this.page = await this.context.newPage();
    this.#listen(this.page);
    this.t0 = Date.now();
  }

  #note(type, data) {
    this.nodeEvents.push({ wall: Date.now(), type, ...data });
  }

  #listen(page) {
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') this.#note(`console.${m.type()}`, { text: m.text().slice(0, 500) });
    });
    page.on('dialog', async (d) => {
      this.#note('dialog', { text: d.message().slice(0, 200), accepted: !!this.acceptDialogs });
      await (this.acceptDialogs ? d.accept() : d.dismiss()).catch(() => {});
    });
    page.on('pageerror', (e) => this.#note('page.crash', { text: String(e.message).slice(0, 500) }));
    page.on('requestfailed', (r) => {
      const why = r.failure()?.errorText ?? '';
      if (why.includes('ERR_ABORTED')) return; // the app cancelled it itself
      this.#note('net.failed', { method: r.method(), url: noQuery(r.url()), why });
    });
    page.on('response', (r) => {
      if (r.status() >= 400) this.#note('net.error', { method: r.request().method(), url: noQuery(r.url()), status: r.status() });
    });
    page.on('websocket', (ws) => {
      const info = { url: noQuery(ws.url()), sent: {}, received: {}, times: {} };
      this.#note('ws.open', { url: info.url });
      const count = (bucket, payload) => {
        let type = 'binary';
        if (typeof payload === 'string') {
          try {
            type = JSON.parse(payload).type ?? 'json';
          } catch {
            type = 'text';
          }
        }
        bucket[type] = (bucket[type] ?? 0) + 1;
        if (bucket === info.received) (info.times[type] ??= []).push(Date.now());
        if (!/audio|delta/.test(type) && bucket[type] <= 3) this.#note('ws.frame', { url: info.url, dir: bucket === info.sent ? 'sent' : 'received', type });
      };
      ws.on('framesent', (f) => count(info.sent, f.payload));
      ws.on('framereceived', (f) => count(info.received, f.payload));
      const summarize = () => {
        // How often each kind of message arrives (median gap), e.g. how fast the
        // patient's words come back, which decides whether talking over the AI works.
        const gaps = {};
        for (const [type, ts] of Object.entries(info.times)) {
          if (ts.length < 3) continue;
          const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
          gaps[type] = { count: ts.length, medianGapMs: d[Math.floor(d.length / 2)] };
        }
        return gaps;
      };
      this.sockets ??= [];
      this.sockets.push({ info, summarize });
      ws.on('close', () => this.#note('ws.close', { url: info.url, sent: info.sent, received: info.received, timing: summarize() }));
      ws.on('socketerror', (e) => this.#note('ws.error', { url: info.url, text: String(e) }));
    });
  }

  async pageNow() {
    return this.page.evaluate(() => window.__vc.now());
  }

  /** Runs one named step; a failure is recorded with a screenshot and stops the scenario. */
  async step(name, fn, { soft = false } = {}) {
    const started = Date.now();
    const rec = { name, status: 'ok', ms: 0, detail: '' };
    this.steps.push(rec);
    try {
      const detail = await fn();
      if (detail) rec.detail = String(detail);
    } catch (e) {
      rec.status = soft ? 'warn' : 'fail';
      rec.detail = String(e?.message ?? e).split('\n')[0].slice(0, 400);
      rec.screenshot = await this.screenshot(`${soft ? 'warn' : 'fail'}-${this.steps.length}`).catch(() => undefined);
      if (!soft) throw new StepFailed(rec.detail);
    } finally {
      rec.ms = Date.now() - started;
    }
    return rec;
  }

  // ---------- doing things ----------
  url(p = '/') {
    return new URL(p, this.baseUrl).toString();
  }

  async open(p = '/') {
    return this.step(`Open ${p}`, async () => {
      await this.page.goto(this.url(p), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await this.page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    });
  }

  #target(name, role) {
    const p = this.page;
    if (role) return p.getByRole(role, { name });
    return p
      .getByRole('button', { name })
      .or(p.getByRole('link', { name }))
      .or(p.getByRole('checkbox', { name }))
      .first();
  }

  /** Taps a button or link by its visible name (text or RegExp). */
  async tap(name, { role, timeout = 15000 } = {}) {
    return this.step(`Tap "${name}"`, async () => {
      const el = this.#target(name, role);
      await el.waitFor({ state: 'visible', timeout });
      await el.click({ timeout });
      this.lastActionAt = await this.pageNow();
    });
  }

  async type(label, text) {
    return this.step(`Type in "${label}"`, async () => {
      await this.page.getByLabel(label).or(this.page.getByPlaceholder(label)).first().fill(text);
    });
  }

  /**
   * Speaks a line into the virtual mic. `line` is a line id from the app's
   * lines file, or { text, lang }. Uses clips/<app>/<id>.wav when it exists
   * (real speech, needed with the real AI), otherwise a speech-like sound.
   */
  async say(line, { waitForMic = 5000, background = false } = {}) {
    const l = typeof line === 'string' ? { id: line, ...(this.lines[line] ?? { text: line }) } : line;
    return this.step(`Say "${l.text}"`, async () => {
      // Talking into a mic nobody is listening to is a bug report, not a test of the app.
      const deadline = Date.now() + waitForMic;
      while ((await this.page.evaluate(() => window.__vc.micOpen())) === 0) {
        if (Date.now() > deadline) throw new Error('the app never opened the microphone');
        await this.page.waitForTimeout(100);
      }
      const clipPath = l.id ? path.join(ROOT, 'clips', this.app, `${l.id}.wav`) : null;
      let wav;
      let source = 'stand-in sound';
      if (clipPath && existsSync(clipPath)) {
        wav = await readFile(clipPath);
        readWav(wav); // fails early on a bad file
        source = `clips/${this.app}/${l.id}.wav`;
      } else {
        if (this.live) this.#note('warn', { text: `No recorded clip for "${l.id ?? l.text}", so the real AI hears a stand-in sound, not words. Run npm run clips.` });
        wav = wavFromFloat(babble(secondsForText(l.text), { seed: this.said.length + 1 }), 48000);
      }
      this.lastSaid = l;
      const at = await this.pageNow();
      const speaking = this.page.evaluate(([b64, label]) => window.__vc.say(b64, label), [wav.toString('base64'), l.id ?? l.text]);
      const done = speaking.then(async (seconds) => {
        this.said.push({ ...l, at, seconds, source });
        this.lastActionAt = await this.pageNow().catch(() => this.lastActionAt);
        return seconds;
      });
      if (background) {
        // Keep going while the line plays (to talk over the app); sayDone() waits for it.
        this.speaking = done;
        return `started (${source})`;
      }
      const seconds = await done;
      return `${seconds.toFixed(1)} s from ${source}`;
    });
  }

  /** Waits for a line started with say(line, { background: true }) to finish. */
  async sayDone() {
    if (this.speaking) await this.speaking;
    this.speaking = null;
  }

  /** Waits for the app to start talking, then for it to finish. Records what it said. */
  async listen({ start = 20000, max = 60000, quietMs = 1500, label = 'App speaks', soft = false } = {}) {
    return this.step(
      label,
      async () => {
        const since = (this.lastListenEnd ?? 0);
        const t0 = Date.now();
        let began = null;
        while (true) {
          const st = await this.page.evaluate((s) => {
            const vc = window.__vc;
            const ev = vc.events.filter((e) => e.t >= s);
            const starts = ev.filter((e) => e.type === 'tts.start');
            const ends = ev.filter((e) => e.type === 'tts.end' || e.type === 'tts.cancel');
            const loud = vc.levels(s).filter(([, r]) => r >= 0.01);
            return {
              now: vc.now(),
              firstLoud: loud[0]?.[0] ?? null,
              lastLoud: loud.at(-1)?.[0] ?? null,
              firstTts: starts[0]?.t ?? null,
              lastTtsEnd: ends.at(-1)?.t ?? null,
              ttsActive: starts.length > ends.length,
            };
          }, since);
          const firsts = [st.firstLoud, st.firstTts].filter((x) => x !== null);
          if (firsts.length) {
            began ??= Math.min(...firsts);
            const last = st.ttsActive ? st.now : Math.max(st.lastLoud ?? 0, st.lastTtsEnd ?? 0);
            if (st.now - last >= quietMs) break;
          } else if (Date.now() - t0 > start) {
            throw new Error(`the app stayed silent for ${Math.round(start / 1000)} s`);
          }
          if (Date.now() - t0 > max) break;
          await this.page.waitForTimeout(150);
        }
        const end = await this.pageNow();
        this.lastListenEnd = end;
        const levels = await this.page.evaluate(([a, b]) => window.__vc.levels(a).filter(([t]) => t <= b), [began - 100, end]);
        const a = analyzeLevels(levels);
        const tts = await this.page.evaluate(([a, b]) => window.__vc.events.filter((e) => e.type === 'tts.start' && e.t >= a && e.t <= b).map((e) => e.text), [began - 100, end]);
        const u = { index: this.utterances.length + 1, from: began, to: end, spokeMs: a.spokeMs, dropouts: a.dropouts.length, choppy: a.choppy, browserVoice: tts, waitMs: Math.max(0, Math.round(began - Math.max(since, this.lastActionAt ?? 0))) };
        u.file = await this.#saveUtterance(u).catch(() => undefined);
        this.utterances.push(u);
        if (tts.length) return `browser voice (not the real voice): "${tts.join(' ').slice(0, 120)}"`;
        return `${(a.spokeMs / 1000).toFixed(1)} s of sound${a.dropouts.length ? `, ${a.dropouts.length} dropouts${a.choppy ? ' (choppy)' : ''}` : ''}`;
      },
      { soft },
    );
  }

  async #saveUtterance(u) {
    const got = await this.page.evaluate(([a, b]) => {
      const vc = window.__vc;
      let best = null;
      for (const tap of vc.taps) {
        if (tap.mic) continue;
        let e = 0;
        const idx = [];
        tap.levels.forEach(([t, r], i) => {
          if (t >= a && t <= b && i < tap.pcm.length) {
            e += r;
            idx.push(i);
          }
        });
        if (idx.length && (!best || e > best.e)) best = { e, idx, tap };
      }
      if (!best || best.e === 0) return null;
      const n = best.idx.reduce((s, i) => s + best.tap.pcm[i].length, 0);
      const all = new Int16Array(n);
      let o = 0;
      for (const i of best.idx) {
        all.set(best.tap.pcm[i], o);
        o += best.tap.pcm[i].length;
      }
      let s = '';
      const bytes = new Uint8Array(all.buffer);
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { b64: btoa(s), rate: best.tap.rate };
    }, [u.from - 50, u.to]);
    if (!got) return undefined;
    const buf = Buffer.from(got.b64, 'base64');
    const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
    const name = `app-said-${u.index}.wav`;
    await writeFile(path.join(this.outDir, name), wavFromInt16(samples, got.rate));
    return name;
  }

  /** Checks that text shows on screen (text or RegExp). */
  async see(text, { timeout = 15000, soft = false, label } = {}) {
    return this.step(
      label ?? `See "${text}"`,
      async () => {
        await this.page.getByText(text).first().waitFor({ state: 'visible', timeout });
      },
      { soft },
    );
  }

  /** Checks that the app heard the last line: its words show on screen. */
  async seeHeard({ timeout = 20000, soft = true, label = 'App shows what was said' } = {}) {
    const l = this.lastSaid;
    if (!l?.text) return;
    const words = l.text.replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter((w) => w.length > 3);
    const probe = words.slice(0, 3).join(' ');
    return this.step(
      label,
      async () => {
        const body = this.page.locator('body');
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const txt = ((await body.innerText()) || '').toLowerCase();
          const hits = words.filter((w) => txt.includes(w.toLowerCase())).length;
          if (words.length === 0 || hits / words.length >= 0.6) return `matched ${hits} of ${words.length} words`;
          await this.page.waitForTimeout(300);
        }
        throw new Error(`"${probe}…" never showed on screen`);
      },
      { soft },
    );
  }

  /** Waits until the app starts making sound (without waiting for it to finish). */
  async talking({ timeout = 20000, label = 'App starts talking' } = {}) {
    return this.step(label, async () => {
      const since = await this.pageNow();
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const on = await this.page.evaluate((s) => window.__vc.levels(s).some(([, r]) => r >= 0.01) || window.__vc.events.some((e) => e.t >= s && e.type === 'tts.start'), since - 300);
        if (on) return;
        await this.page.waitForTimeout(100);
      }
      throw new Error(`no sound within ${Math.round(timeout / 1000)} s`);
    });
  }

  /** Checks the app goes quiet within `within` ms (for example after being interrupted). */
  async quiet({ within = 1000, soft = true, label = 'App stops talking' } = {}) {
    return this.step(
      label,
      async () => {
        const from = await this.pageNow();
        await this.page.waitForTimeout(within + 300);
        const loud = await this.page.evaluate((s) => window.__vc.levels(s).filter(([, r]) => r >= 0.01).map(([t]) => t), from + within);
        const tts = await this.page.evaluate(() => window.speechSynthesis?.speaking);
        if (loud.length || tts) throw new Error(`still talking ${within} ms later`);
        this.lastListenEnd = await this.pageNow();
      },
      { soft },
    );
  }

  /** Checks whether the mic is open (true) or closed (false). */
  async micShouldBe(open, { timeout = 5000, soft = true } = {}) {
    return this.step(
      `Mic is ${open ? 'on' : 'off'}`,
      async () => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const n = await this.page.evaluate(() => window.__vc.micOpen());
          if (open ? n > 0 : n === 0) return;
          await this.page.waitForTimeout(150);
        }
        throw new Error(open ? 'the mic is still off' : 'the mic was left on');
      },
      { soft },
    );
  }

  async wait(ms) {
    await this.page.waitForTimeout(ms);
  }

  async screenshot(name) {
    this.shots++;
    const file = `${String(this.shots).padStart(2, '0')}-${name.replace(/[^\w-]+/g, '-').slice(0, 40)}.png`;
    await this.page.screenshot({ path: path.join(this.outDir, file) });
    const last = this.steps.at(-1);
    if (last && !last.screenshot) last.screenshot = file;
    return file;
  }

  // ---------- fakes (used when not live) ----------
  /** Answers an HTTP call in the page instead of the real server. */
  async fake(pattern, handler) {
    await this.context.route(pattern, async (route) => {
      try {
        const r = await handler(route.request(), this);
        if (r === undefined) return route.continue();
        if (Buffer.isBuffer(r.body)) return route.fulfill({ status: r.status ?? 200, contentType: r.contentType, body: r.body });
        return route.fulfill({ status: r.status ?? 200, contentType: 'application/json', body: JSON.stringify(r.json ?? r) });
      } catch (e) {
        this.#note('fake.error', { text: String(e) });
        return route.abort();
      }
    });
  }

  // ---------- results ----------
  async finish(error) {
    let pageEvents = [];
    try {
      if (this.page && !this.page.isClosed()) {
        await this.screenshot('end').catch(() => {});
        pageEvents = await this.page.evaluate(() => window.__vc.events);
        this.micOpenAtEnd = await this.page.evaluate(() => window.__vc.micOpen());
      }
    } catch {
      /* page gone */
    }
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    const result = await writeReport(this, { pageEvents, error });
    return result;
  }
}
