// Writes report.json and a plain report.html for one run, and works out the
// list of problems found.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Noise that every page makes and nobody needs to hear about. */
const IGNORE = [/favicon\.ico/, /Download the React DevTools/, /\[vite\]/];

export function findIssues(vc, pageEvents) {
  const issues = [];
  const add = (level, text) => issues.push({ level, text });
  for (const s of vc.steps) {
    if (s.status === 'fail') add('bug', `Step failed: ${s.name}: ${s.detail}`);
    if (s.status === 'warn') add('check', `${s.name}: ${s.detail}`);
  }
  for (const u of vc.utterances) {
    if (u.choppy) add('bug', `App speech ${u.index} sounds choppy: ${u.dropouts} dropouts in ${(u.spokeMs / 1000).toFixed(1)} s (listen to ${u.file ?? 'the recording'}).`);
    else if (u.dropouts >= 2) add('check', `App speech ${u.index} has ${u.dropouts} short dropouts; listen to ${u.file ?? 'the recording'}.`);
    if (u.browserVoice.length && vc.live) add('bug', `App speech ${u.index} used the browser's own voice, so the real voice failed or was off.`);
    if (u.waitMs > 6000 && vc.utterances.indexOf(u) > 0) add('check', `App took ${(u.waitMs / 1000).toFixed(1)} s to start answering (speech ${u.index}).`);
  }
  const seen = new Set();
  const once = (level, text) => {
    if (seen.has(text)) return;
    seen.add(text);
    add(level, text);
  };
  for (const e of vc.nodeEvents) {
    const text = e.text ?? e.url ?? '';
    if ([...IGNORE, ...vc.ignore].some((r) => r.test(text))) continue;
    if (e.type === 'page.crash') once('bug', `Page error: ${e.text}`);
    if (e.type === 'console.error') once('bug', `Console error: ${e.text}`);
    if (e.type === 'net.failed') once('bug', `Request failed: ${e.method} ${e.url} (${e.why})`);
    if (e.type === 'net.error') once(e.status >= 500 ? 'bug' : 'check', `Request returned ${e.status}: ${e.method} ${e.url}`);
    if (e.type === 'ws.error') once('bug', `Live connection error: ${e.url}: ${e.text}`);
    if (e.type === 'fake.error') once('bug', `VoiceCheck's fake server broke: ${e.text}`);
    if (e.type === 'warn') once('check', e.text);
  }
  for (const e of pageEvents) {
    if (e.type === 'media.playFailed') once('bug', `Sound would not play: ${e.message}`);
    if (e.type === 'page.rejection') once('bug', `Unhandled error in the app: ${e.message}`);
    if (e.type === 'tap.error') once('check', `VoiceCheck could not listen to one sound: ${e.message}`);
  }
  const said = pageEvents.filter((e) => e.type === 'say.start');
  for (const e of said) if (e.micOpen === 0) once('bug', `The mic was off while "${e.label}" was being said.`);
  return issues;
}

export async function writeReport(vc, { pageEvents, error }) {
  const issues = findIssues(vc, pageEvents);
  const failed = vc.steps.some((s) => s.status === 'fail') || !!error;
  const bugs = issues.filter((i) => i.level === 'bug').length;
  const verdict = failed ? 'failed' : bugs ? 'passed with bugs' : 'passed';
  const result = {
    app: vc.app,
    scenario: vc.scenario,
    mode: vc.live ? 'live AI' : 'fake AI',
    url: vc.baseUrl,
    when: new Date(vc.t0 ?? Date.now()).toISOString(),
    verdict,
    issues,
    steps: vc.steps,
    said: vc.said.map(({ id, text, lang, seconds, source }) => ({ id, text, lang, seconds, source })),
    appSaid: vc.utterances,
    appStats: vc.extra,
    sockets: (vc.sockets ?? []).map((s) => ({ url: s.info.url, sent: s.info.sent, received: s.info.received, timing: s.summarize() })),
    error: error ? String(error.message ?? error) : undefined,
    events: { node: vc.nodeEvents, page: pageEvents.filter((e) => !/^say\./.test(e.type) || true).slice(-500) },
  };
  await writeFile(path.join(vc.outDir, 'report.json'), JSON.stringify(result, null, 2));

  const row = (s) => `<tr class="${s.status}"><td>${s.status === 'ok' ? '✓' : s.status === 'warn' ? '!' : '✗'}</td><td>${esc(s.name)}</td><td>${esc(s.detail)}</td><td>${(s.ms / 1000).toFixed(1)} s</td><td>${s.screenshot ? `<a href="${esc(s.screenshot)}">picture</a>` : ''}</td></tr>`;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VoiceCheck ${esc(vc.app)} ${esc(vc.scenario)}</title>
<style>
body{font:15px/1.45 system-ui,sans-serif;margin:16px;max-width:960px;color:#1d2433;background:#fff}
h1{font-size:20px;margin:0 0 4px} .muted{color:#667085}
.verdict{display:inline-block;padding:2px 10px;border-radius:12px;font-weight:600}
.passed{background:#dcfae6;color:#085d3a}.failed{background:#fee4e2;color:#912018}.withbugs{background:#fef0c7;color:#93370d}
table{border-collapse:collapse;width:100%;margin:8px 0 20px}td,th{border-bottom:1px solid #e4e7ec;padding:6px;text-align:left;vertical-align:top}
tr.fail td{background:#fef3f2}tr.warn td{background:#fffaeb}
li.bug{color:#912018}li.check{color:#93370d}
.shots{display:flex;flex-wrap:wrap;gap:8px}.shots img{width:180px;border:1px solid #e4e7ec;border-radius:6px}
audio{height:32px;vertical-align:middle}
@media (prefers-color-scheme:dark){body{background:#0f1115;color:#e6e8ee}td,th{border-color:#2a2f3a}tr.fail td{background:#3a1d1d}tr.warn td{background:#3a301a}}
</style>
<h1>${esc(vc.app)}: ${esc(vc.scenario)}</h1>
<p class="muted">${esc(result.mode)} · ${esc(vc.baseUrl)} · ${esc(result.when)}</p>
<p><span class="verdict ${failed ? 'failed' : bugs ? 'withbugs' : 'passed'}">${esc(verdict)}</span></p>
<h2>Problems found</h2>
${issues.length ? `<ul>${issues.map((i) => `<li class="${i.level}">${i.level === 'bug' ? 'Bug' : 'Check'}: ${esc(i.text)}</li>`).join('')}</ul>` : '<p>None.</p>'}
<h2>Steps</h2>
<table><tr><th></th><th>Step</th><th>What happened</th><th>Time</th><th></th></tr>${vc.steps.map(row).join('')}</table>
<h2>What the app said</h2>
${vc.utterances.length ? `<table><tr><th>#</th><th>Sound</th><th>Dropouts</th><th>Started after</th><th>Listen</th></tr>${vc.utterances
    .map((u) => `<tr><td>${u.index}</td><td>${u.browserVoice.length ? `browser voice: ${esc(u.browserVoice.join(' ').slice(0, 200))}` : `${(u.spokeMs / 1000).toFixed(1)} s`}</td><td>${u.dropouts}${u.choppy ? ' (choppy)' : ''}</td><td>${(u.waitMs / 1000).toFixed(1)} s</td><td>${u.file ? `<audio controls src="${esc(u.file)}"></audio>` : ''}</td></tr>`)
    .join('')}</table>` : '<p>Nothing heard.</p>'}
${result.sockets.length ? `<h2>Live connections</h2><details><summary>${result.sockets.length} connection(s)</summary><pre>${esc(JSON.stringify(result.sockets, null, 2))}</pre></details>` : ''}
${vc.extra ? `<h2>The app's own numbers</h2><details><summary>Show</summary><pre>${esc(JSON.stringify(vc.extra, null, 2))}</pre></details>` : ''}
<h2>Pictures</h2>
<div class="shots">${[...new Set(vc.steps.map((s) => s.screenshot).filter(Boolean))].map((f) => `<a href="${esc(f)}"><img src="${esc(f)}" alt="${esc(f)}"></a>`).join('')}</div>
`;
  await writeFile(path.join(vc.outDir, 'report.html'), html);
  return result;
}
