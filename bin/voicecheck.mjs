#!/usr/bin/env node
// voicecheck <app> [scenario|all] [--live] [--url URL] [--headed] [--desktop] [--video]
// voicecheck login <app> [--url URL]
// voicecheck list
import { readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, StepFailed, VoiceCheck } from '../src/session.mjs';
import { launch } from '../src/browser.mjs';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
const val = (name) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq?.split('=').slice(1).join('=');
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] === '--url'));

async function loadApp(name) {
  const file = path.join(ROOT, 'apps', name, 'index.mjs');
  if (!existsSync(file)) throw new Error(`No app "${name}". Try: voicecheck list`);
  return (await import(pathToFileURL(file))).default;
}

async function list() {
  for (const name of await readdir(path.join(ROOT, 'apps'))) {
    if (!existsSync(path.join(ROOT, 'apps', name, 'index.mjs'))) continue;
    const app = await loadApp(name);
    console.log(`${name}  ${app.title ?? ''}`);
    for (const s of Object.keys(app.scenarios)) console.log(`   ${s}`);
  }
}

function authFile(app) {
  return path.join(ROOT, '.auth', `${app}.json`);
}

/** Opens a real window; you sign in yourself; VoiceCheck keeps that sign-in for test runs. */
async function login(name) {
  const app = await loadApp(name);
  const base = val('url') ?? app.urls.live ?? app.urls.local;
  const browser = await launch({ headed: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(new URL(app.loginPath ?? '/', base).toString());
  console.log(`Sign in to ${app.title} with your TEST account in the window that opened.`);
  if (app.loginHelp) console.log(app.loginHelp);
  console.log('VoiceCheck waits until you are signed in (up to 5 minutes).');
  await app.signedIn(page, 5 * 60_000);
  await mkdir(path.dirname(authFile(name)), { recursive: true });
  await context.storageState({ path: authFile(name), indexedDB: true });
  console.log(`Saved the sign-in to ${path.relative(ROOT, authFile(name))} (git ignores it).`);
  await browser.close();
}

async function run(name, which) {
  const app = await loadApp(name);
  const live = flags.has('--live');
  const baseUrl = val('url') ?? (live ? (app.urls.live ?? app.urls.local) : app.urls.local);
  if (app.liveOnly && !live) throw new Error(`${app.title} runs with the real AI only for now: add --live (and sign in first: npm run login ${name}).`);
  const names = !which || which === 'all' ? Object.keys(app.scenarios) : [which];
  let failed = 0;
  for (const scenario of names) {
    const fn = app.scenarios[scenario];
    if (!fn) throw new Error(`No scenario "${scenario}" for ${name}. Try: voicecheck list`);
    const vc = new VoiceCheck({
      app: name,
      scenario,
      baseUrl,
      live,
      lines: app.lines,
      headed: flags.has('--headed'),
      phone: !flags.has('--desktop'),
      video: flags.has('--video'),
      pageOptions: app.options?.[scenario],
      relayOptions: app.relayOptions?.[scenario],
      storageState: existsSync(authFile(name)) ? authFile(name) : undefined,
    });
    let error;
    try {
      await vc.start();
      if (!live && app.fakes) await app.fakes(vc);
      if (app.needsLogin && live && !vc.storageState) throw new Error(`Sign in first: npx voicecheck login ${name}`);
      await fn(vc);
    } catch (e) {
      if (!(e instanceof StepFailed)) error = e;
    }
    const r = await vc.finish(error);
    const mark = r.verdict === 'passed' ? '✓' : r.verdict === 'failed' ? '✗' : '!';
    console.log(`\n${mark} ${name} / ${scenario}: ${r.verdict} (${r.mode})`);
    for (const i of r.issues) console.log(`  ${i.level === 'bug' ? 'BUG  ' : 'CHECK'} ${i.text}`);
    if (r.error) console.log(`  ERROR ${r.error}`);
    console.log(`  Report: ${path.relative(process.cwd(), path.join(vc.outDir, 'report.html'))}`);
    if (r.verdict === 'failed') failed++;
  }
  process.exitCode = failed ? 1 : 0;
}

const [cmd, a, b] = positional;
try {
  if (!cmd || flags.has('--help')) {
    console.log('Usage: voicecheck <app> [scenario|all] [--live] [--url URL] [--headed] [--desktop] [--video]\n       voicecheck login <app>\n       voicecheck list');
  } else if (cmd === 'list') await list();
  else if (cmd === 'login') await login(a);
  else await run(cmd, a);
} catch (e) {
  console.error(e.message ?? e);
  process.exitCode = 2;
}
