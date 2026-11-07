// End-to-end check of VoiceCheck itself against a small fixture page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VoiceCheck } from '../src/session.mjs';
import { babble, wavFromFloat } from '../src/audio.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let server;
let base;
before(async () => {
  const html = await readFile(path.join(here, 'fixture.html'));
  const wav = wavFromFloat(babble(2.5), 48000);
  server = http.createServer((req, res) => {
    if (req.url === '/tone.wav') return res.writeHead(200, { 'content-type': 'audio/wav' }).end(wav);
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function withVc(fn) {
  const vc = new VoiceCheck({ app: 'fixture', scenario: 'test', baseUrl: base, live: false, lines: { hi: { text: 'hello there how are you today' } } });
  await vc.start();
  try {
    await vc.open('/');
    await fn(vc);
  } finally {
    await vc.finish();
    await rm(vc.outDir, { recursive: true, force: true });
  }
  return vc;
}

test('the app hears the virtual mic, and its own mic metering is not counted as the app speaking', async () => {
  await withVc(async (vc) => {
    await vc.tap('Listen');
    await vc.micShouldBe(true, { soft: false });
    await vc.say('hi');
    await vc.see('Heard you speak', { timeout: 3000 });
    const levels = await vc.page.evaluate(() => window.__vc.levels(0).filter(([, r]) => r > 0.01).length);
    assert.equal(levels, 0, 'mic audio leaked into the app-output recording');
    await vc.tap('Stop listening');
    await vc.micShouldBe(false, { soft: false });
  });
});

test('clean speech is heard and not called choppy', async () => {
  const vc = await withVc(async (vc) => {
    await vc.tap('Speak clean');
    await vc.listen();
  });
  const u = vc.utterances[0];
  assert.ok(u.spokeMs > 2500, `spoke ${u.spokeMs} ms`);
  assert.equal(u.choppy, false);
  assert.equal(u.dropouts, 0);
});

test('speech with 100 ms holes is called choppy', async () => {
  const vc = await withVc(async (vc) => {
    await vc.tap('Speak choppy');
    await vc.listen();
  });
  assert.equal(vc.utterances[0].choppy, true, JSON.stringify(vc.utterances[0]));
});

test('sound played through an audio tag is heard', async () => {
  const vc = await withVc(async (vc) => {
    await vc.tap('Speak through audio tag');
    await vc.listen();
  });
  assert.ok(vc.utterances[0].spokeMs > 1500, `spoke ${vc.utterances[0].spokeMs} ms`);
});

test('the browser voice is captured as text and finishes', async () => {
  const vc = await withVc(async (vc) => {
    await vc.tap('Speak browser voice');
    await vc.listen();
    await vc.see('Browser voice done', { timeout: 5000 });
  });
  assert.match(vc.utterances[0].browserVoice.join(' '), /browser voice speaking/);
});
