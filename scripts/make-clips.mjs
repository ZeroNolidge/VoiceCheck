#!/usr/bin/env node
// Makes the spoken clips VoiceCheck plays into the mic, one WAV per line in
// apps/<app>/lines.json, saved to clips/<app>/<id>.wav. Run on your computer:
//   npm run clips            all apps, only lines that have no clip yet
//   npm run clips xthera     one app
//   npm run clips -- --redo  make them all again
// Voices, first that works: Tagalog → Cartesia (CARTESIA_API_KEY), then
// OpenAI (OPENAI_API_KEY); other languages → OpenAI, then the Mac's `say`,
// then espeak-ng. Keys come from the environment or a .env file here
// (git ignores it). Each clip is made once; making them costs a few cents.
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wavFromInt16 } from '../src/audio.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile))
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
const { OPENAI_API_KEY, CARTESIA_API_KEY } = process.env;
const redo = process.argv.includes('--redo');
const only = process.argv.slice(2).find((a) => !a.startsWith('--'));

const pcmWav = (buf, rate) => wavFromInt16(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)), rate);

async function openai(text, lang) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL ?? 'gpt-4o-mini-tts',
      voice: process.env.OPENAI_TTS_VOICE ?? 'ash',
      input: text,
      instructions: `A patient talking to a clinician, natural and a little tired. Language: ${lang}.`,
      response_format: 'pcm', // 24 kHz 16-bit mono
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return pcmWav(Buffer.from(await res.arrayBuffer()), 24000);
}

let cartesiaVoice = process.env.CARTESIA_VOICE_TL;
async function cartesia(text) {
  const headers = { 'X-API-Key': CARTESIA_API_KEY, 'Cartesia-Version': '2025-04-16', 'Content-Type': 'application/json' };
  if (!cartesiaVoice) {
    const r = await fetch('https://api.cartesia.ai/voices/?limit=100&language=tl', { headers });
    const list = (await r.json())?.data ?? [];
    cartesiaVoice = list.find((v) => v.language === 'tl')?.id;
    if (!cartesiaVoice) throw new Error('No Tagalog voice found on Cartesia; set CARTESIA_VOICE_TL');
  }
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model_id: process.env.CARTESIA_MODEL ?? 'sonic-3',
      transcript: text,
      voice: { mode: 'id', id: cartesiaVoice },
      language: 'tl',
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
    }),
  });
  if (!res.ok) throw new Error(`Cartesia ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return pcmWav(Buffer.from(await res.arrayBuffer()), 24000);
}

function local(text, lang, out) {
  if (process.platform === 'darwin') {
    execFileSync('say', ['-o', out, '--data-format=LEI16@24000', text]);
    return null;
  }
  execFileSync('espeak-ng', ['-v', lang === 'es' ? 'es' : 'en-us', '-w', out, text]);
  return null;
}

async function make(line, out) {
  const lang = line.lang ?? 'en';
  if (lang === 'tl' && CARTESIA_API_KEY) return cartesia(line.text);
  if (OPENAI_API_KEY) return openai(line.text, lang);
  if (lang === 'tl') throw new Error('Tagalog needs CARTESIA_API_KEY or OPENAI_API_KEY');
  return local(line.text, lang, out);
}

let made = 0;
let failed = 0;
for (const app of await readdir(path.join(ROOT, 'apps'))) {
  if (only && app !== only) continue;
  const file = path.join(ROOT, 'apps', app, 'lines.json');
  if (!existsSync(file)) continue;
  const lines = JSON.parse(readFileSync(file, 'utf8'));
  await mkdir(path.join(ROOT, 'clips', app), { recursive: true });
  for (const [id, line] of Object.entries(lines)) {
    const out = path.join(ROOT, 'clips', app, `${id}.wav`);
    if (existsSync(out) && !redo) continue;
    try {
      const wav = await make(line, out);
      if (wav) await writeFile(out, wav);
      console.log(`made clips/${app}/${id}.wav  "${line.text}"`);
      made++;
    } catch (e) {
      console.log(`could not make ${app}/${id}: ${e.message}`);
      failed++;
    }
  }
}
console.log(`${made} made, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
