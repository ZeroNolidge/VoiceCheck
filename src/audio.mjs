// Small audio helpers: WAV files, a speech-like stand-in sound, and the
// analysis that turns the app's output levels into "spoke / silent / choppy".

/** 16-bit mono WAV from Int16 samples. */
export function wavFromInt16(samples, rate) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export function wavFromFloat(f32, rate) {
  const s = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) s[i] = Math.max(-1, Math.min(1, f32[i])) * 32767;
  return wavFromInt16(s, rate);
}

/** Reads the PCM samples of a 16-bit WAV (any channel count; first channel). */
export function readWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a WAV file');
  let p = 12;
  let fmt = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === 'data') {
      if (!fmt || fmt.bits !== 16) throw new Error('only 16-bit WAV is supported');
      const n = Math.floor(size / 2 / fmt.channels);
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(p + 8 + i * 2 * fmt.channels);
      return { rate: fmt.rate, samples: out, seconds: n / fmt.rate };
    }
    p += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data');
}

/**
 * A speech-like stand-in: voiced "syllables" (a buzzy pitch with a few
 * formants) about 4 per second, with short pauses between words. Good enough
 * for anything that only needs to detect that someone is talking. Not words:
 * a real speech-to-text will hear nothing in it.
 */
export function babble(seconds, { rate = 48000, pitch = 140, seed = 1 } = {}) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  const lead = Math.round(0.15 * rate);
  let i = lead;
  let phase = 0;
  while (i < n - lead) {
    const syl = Math.round((0.12 + rnd() * 0.12) * rate);
    const f1 = 400 + rnd() * 500;
    const f2 = 1000 + rnd() * 1200;
    const f0 = pitch * (0.9 + rnd() * 0.2);
    for (let k = 0; k < syl && i < n - lead; k++, i++) {
      const env = Math.sin((Math.PI * k) / syl) ** 0.6;
      phase += (2 * Math.PI * f0) / rate;
      const t = i / rate;
      const v = 0.5 * Math.sin(phase) + 0.25 * Math.sin(2 * Math.PI * f1 * t) * Math.sin(phase) + 0.15 * Math.sin(2 * Math.PI * f2 * t) * Math.sin(phase);
      out[i] = 0.35 * env * v;
    }
    i += Math.round((rnd() < 0.3 ? 0.18 : 0.04) * rate); // word or syllable gap
  }
  // Faint room tone everywhere, like a real recording: a real voice never
  // drops to digital silence between words, a broken stream does.
  for (let k = 0; k < n; k++) out[k] += (rnd() - 0.5) * 0.008;
  return out;
}

/** Rough speaking time for a line of text (about 2.7 words a second). */
export function secondsForText(text) {
  const words = (String(text).match(/\S+/g) || []).length;
  return Math.min(20, Math.max(1, words / 2.7 + 0.4));
}

/**
 * Turns merged output levels ([t ms, rms] in 20 ms bins) into what the app
 * said: speech segments, total time, and dropouts (stretches of near-digital
 * silence inside an utterance, which is what choppy streaming sounds like).
 */
export function analyzeLevels(levels, { speech = 0.01, silent = 0.0005, joinMs = 700, minDropMs = 60, maxDropMs = 250 } = {}) {
  const segments = [];
  let cur = null;
  for (const [t, r] of levels) {
    if (r >= speech) {
      if (cur && t - cur.end <= joinMs) cur.end = t + 20;
      else {
        cur = { start: t, end: t + 20 };
        segments.push(cur);
      }
    }
  }
  const dropouts = [];
  for (const seg of segments) {
    seg.ms = seg.end - seg.start;
    seg.dropouts = 0;
    let dropStart = null;
    for (const [t, r] of levels) {
      if (t < seg.start || t > seg.end) continue;
      if (r < silent) dropStart ??= t;
      else if (dropStart !== null) {
        const ms = t - dropStart;
        if (ms >= minDropMs && ms <= maxDropMs) {
          seg.dropouts++;
          dropouts.push({ at: dropStart, ms });
        }
        dropStart = null;
      }
    }
  }
  const spokeMs = segments.reduce((a, s) => a + s.ms, 0);
  const perMin = spokeMs ? (dropouts.length / spokeMs) * 60000 : 0;
  return { segments, spokeMs, dropouts, dropoutsPerMinute: Math.round(perMin), choppy: dropouts.length >= 3 && perMin >= 20 };
}
