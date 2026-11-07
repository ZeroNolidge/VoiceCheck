// Runs inside the app's page before the app's own code (Playwright init script).
// 1. A virtual microphone: getUserMedia returns a stream VoiceCheck can "speak" into.
// 2. An output tap: records the sound the app plays (Web Audio, <audio>, WebRTC
//    audio) as levels plus PCM, so VoiceCheck can tell whether the app spoke,
//    for how long, and whether the sound broke up.
// 3. A stand-in for speechSynthesis, which has no voices in headless Chrome.
// Everything is logged to window.__vc.events for the Node side to read.
(() => {
  if (window.__vc) return;
  const opts = window.__vcOptions || {};
  const now = () => performance.now();
  const VC = (window.__vc = {
    events: [],
    taps: [],
    micCtx: null,
    micDest: null,
    denyMic: !!opts.denyMic,
    micTracks: new Set(),
  });
  const log = (type, data = {}) => VC.events.push({ t: now(), type, ...data });
  VC.log = log;

  const AC = window.AudioContext || window.webkitAudioContext;
  const origConnect = AudioNode.prototype.connect;

  // ---------- virtual microphone ----------
  function micDest() {
    if (!VC.micCtx) {
      VC.micCtx = new AC({ sampleRate: 48000 });
      VC.micDest = VC.micCtx.createMediaStreamDestination();
      VC.micDest.channelCount = 1;
    }
    return VC.micDest;
  }

  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const origGUM = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => {
      log('mic.request', { constraints: JSON.stringify(constraints ?? {}) });
      if (VC.denyMic) {
        log('mic.denied');
        throw new DOMException('Permission denied', 'NotAllowedError');
      }
      if (!constraints || !constraints.audio) return origGUM(constraints);
      const dest = micDest();
      if (VC.micCtx.state !== 'running') await VC.micCtx.resume().catch(() => {});
      const tracks = dest.stream.getAudioTracks().map((t) => t.clone());
      if (constraints.video) {
        const v = await origGUM({ video: constraints.video });
        tracks.push(...v.getVideoTracks());
      }
      for (const t of tracks) if (t.kind === 'audio') VC.micTracks.add(t);
      log('mic.open', { open: VC.micTracks.size });
      return new MediaStream(tracks);
    };
  }
  const origStop = MediaStreamTrack.prototype.stop;
  MediaStreamTrack.prototype.stop = function () {
    if (VC.micTracks.has(this)) {
      VC.micTracks.delete(this);
      log('mic.close', { open: VC.micTracks.size });
    }
    return origStop.call(this);
  };

  VC.micOpen = () => [...VC.micTracks].filter((t) => t.readyState === 'live').length;

  /** Plays a clip (base64 WAV/MP3) into the virtual mic. Resolves when it ends. */
  VC.say = async (b64, label) => {
    const dest = micDest();
    const ctx = VC.micCtx;
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const buf = await ctx.decodeAudioData(bytes.buffer);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    origConnect.call(src, dest);
    log('say.start', { label, seconds: buf.duration, micOpen: VC.micOpen() });
    await new Promise((resolve) => {
      src.onended = resolve;
      src.start();
    });
    log('say.end', { label, micOpen: VC.micOpen() });
    return buf.duration;
  };

  // ---------- output tap ----------
  const FRAME = 1024;
  const MAX_SECONDS = 600;
  function makeTap(ctx, kind) {
    const tap = {
      id: VC.taps.length,
      kind,
      rate: ctx.sampleRate,
      levels: [], // [t(ms), rms]
      pcm: [], // Int16Array chunks
      samples: 0,
    };
    VC.taps.push(tap);
    const proc = ctx.createScriptProcessor(FRAME, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    proc.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      const rms = Math.sqrt(sum / d.length);
      tap.levels.push([now(), rms]);
      if (tap.samples < MAX_SECONDS * ctx.sampleRate) {
        const s = new Int16Array(d.length);
        for (let i = 0; i < d.length; i++) s[i] = Math.max(-1, Math.min(1, d[i])) * 32767;
        tap.pcm.push(s);
        tap.samples += d.length;
      }
    };
    origConnect.call(proc, mute);
    origConnect.call(mute, ctx.destination);
    tap.input = proc;
    return tap;
  }
  const ctxTaps = new WeakMap();
  function tapFor(ctx, kind) {
    let t = ctxTaps.get(ctx);
    if (!t) {
      t = makeTap(ctx, kind);
      ctxTaps.set(ctx, t);
    }
    return t;
  }

  // A context that reads the mic (to meter or encode it) is not the app
  // speaking, even if the app wires it to the speakers to keep it running.
  const micContexts = new WeakSet();
  const origMSS = AudioContext.prototype.createMediaStreamSource;
  if (origMSS)
    AudioContext.prototype.createMediaStreamSource = function (stream) {
      if (stream && stream.getAudioTracks().some((t) => VC.micTracks.has(t))) {
        micContexts.add(this);
        const tap = ctxTaps.get(this);
        if (tap) tap.mic = true;
      }
      return origMSS.call(this, stream);
    };

  // Anything the app connects to a speaker is also sent to the tap.
  AudioNode.prototype.connect = function (dest, ...rest) {
    const out = origConnect.call(this, dest, ...rest);
    try {
      if (dest instanceof AudioDestinationNode && this.context !== VC.micCtx && !micContexts.has(this.context)) {
        origConnect.call(this, tapFor(this.context, 'webaudio').input);
      }
    } catch (e) {
      log('tap.error', { message: String(e) });
    }
    return out;
  };

  // <audio>/<video>: blob, data and same-origin files go through a tap context;
  // live streams (WebRTC) are only listened to, playback is untouched.
  let mediaCtx = null;
  const tapped = new WeakSet();
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    try {
      if (!tapped.has(this)) {
        mediaCtx ??= new AC();
        if (mediaCtx.state !== 'running') mediaCtx.resume().catch(() => {});
        const tap = tapFor(mediaCtx, 'media');
        if (this.srcObject instanceof MediaStream && this.srcObject.getAudioTracks().length) {
          tapped.add(this);
          origConnect.call(mediaCtx.createMediaStreamSource(this.srcObject), tap.input);
          log('media.stream', { tag: this.tagName.toLowerCase() });
        } else if (this.src && !this.srcObject) {
          const u = new URL(this.src, location.href);
          const sameOrigin = u.protocol === 'blob:' || u.protocol === 'data:' || u.origin === location.origin;
          if (sameOrigin && (this.tagName === 'AUDIO' || opts.tapVideo)) {
            tapped.add(this);
            const src = mediaCtx.createMediaElementSource(this);
            src.connect(mediaCtx.destination); // goes through the hook above, so it is tapped
          }
        }
      }
      log('media.play', { tag: this.tagName.toLowerCase(), src: (this.currentSrc || this.src || '').slice(0, 60) });
    } catch (e) {
      log('tap.error', { message: String(e) });
    }
    const p = origPlay.apply(this, args);
    if (p && p.catch) p.catch((e) => log('media.playFailed', { message: String(e) }));
    return p;
  };

  // ---------- speechSynthesis stand-in ----------
  if ('speechSynthesis' in window && opts.fakeSpeechSynthesis !== false) {
    const queue = [];
    let timer = null;
    const fire = (u, type, extra = {}) => {
      try {
        const ev = type === 'error'
          ? new SpeechSynthesisErrorEvent('error', { utterance: u, error: extra.error || 'interrupted' })
          : new SpeechSynthesisEvent(type, { utterance: u });
        u.dispatchEvent(ev);
      } catch (e) {
        log('tap.error', { message: String(e) });
      }
    };
    const next = () => {
      const u = queue[0];
      if (!u) return;
      const words = (u.text.match(/\S+/g) || []).length;
      const ms = Math.max(400, words * 330) / (u.rate || 1);
      log('tts.start', { text: u.text, lang: u.lang, seconds: ms / 1000 });
      fire(u, 'start');
      timer = setTimeout(() => {
        queue.shift();
        log('tts.end', { text: u.text.slice(0, 80) });
        fire(u, 'end');
        next();
      }, ms);
    };
    const syn = window.speechSynthesis;
    syn.speak = (u) => {
      queue.push(u);
      if (queue.length === 1) next();
    };
    syn.cancel = () => {
      clearTimeout(timer);
      const dropped = queue.splice(0);
      if (dropped.length) log('tts.cancel', { count: dropped.length });
      dropped.forEach((u) => fire(u, 'error', { error: 'interrupted' }));
    };
    Object.defineProperty(syn, 'speaking', { get: () => queue.length > 0 });
    Object.defineProperty(syn, 'pending', { get: () => queue.length > 1 });
  }

  // ---------- reading results back ----------
  /** Levels since `since` (ms), all taps merged into 20 ms bins: [[t, rms], ...]. */
  VC.levels = (since = 0) => {
    const bins = new Map();
    for (const tap of VC.taps)
      if (!tap.mic)
      for (const [t, r] of tap.levels) {
        if (t < since) continue;
        const k = Math.floor(t / 20) * 20;
        bins.set(k, Math.max(bins.get(k) || 0, r));
      }
    return [...bins.entries()].sort((a, b) => a[0] - b[0]);
  };
  VC.tapSummary = () =>
    VC.taps.map((t) => ({ id: t.id, kind: t.kind, rate: t.rate, seconds: t.samples / t.rate }));
  /** One tap's recorded sound as base64 Int16 PCM. */
  VC.tapPcm = (id) => {
    const tap = VC.taps[id];
    const all = new Int16Array(tap.samples);
    let o = 0;
    for (const c of tap.pcm) {
      all.set(c, o);
      o += c.length;
    }
    let s = '';
    const b = new Uint8Array(all.buffer);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  };
  VC.now = now;

  window.addEventListener('error', (e) => log('page.error', { message: String(e.message) }));
  window.addEventListener('unhandledrejection', (e) => log('page.rejection', { message: String(e.reason) }));
})();
