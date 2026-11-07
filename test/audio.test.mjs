import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLevels, babble, readWav, wavFromFloat } from '../src/audio.mjs';

const bins = (pattern) => pattern.map((r, i) => [i * 20, r]);

test('one steady utterance', () => {
  const a = analyzeLevels(bins([0, 0, ...Array(100).fill(0.1), 0, 0]));
  assert.equal(a.segments.length, 1);
  assert.equal(a.dropouts.length, 0);
});

test('digital-silence holes inside speech are dropouts', () => {
  const chunk = [...Array(15).fill(0.1), ...Array(5).fill(0)];
  const a = analyzeLevels(bins(Array(10).fill(chunk).flat()));
  assert.ok(a.dropouts.length >= 8);
  assert.equal(a.choppy, true);
});

test('quiet pauses with room tone are not dropouts', () => {
  const chunk = [...Array(15).fill(0.1), ...Array(10).fill(0.003)];
  const a = analyzeLevels(bins(Array(10).fill(chunk).flat()));
  assert.equal(a.dropouts.length, 0);
});

test('WAV round trip', () => {
  const w = readWav(wavFromFloat(babble(1, { rate: 16000 }), 16000));
  assert.equal(w.rate, 16000);
  assert.ok(Math.abs(w.seconds - 1) < 0.01);
});
