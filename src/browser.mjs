// Finds a Chromium to drive. In order: CHROME_PATH, Playwright's own
// Chromium (`npx playwright install chromium`), then @sparticuz/chromium
// (Linux only, used in cloud sandboxes where the Playwright download is blocked).
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const MEDIA_FLAGS = [
  '--use-fake-ui-for-media-stream', // allow the mic without a prompt
  '--use-fake-device-for-media-stream', // a fake camera if an app asks for video
  '--autoplay-policy=no-user-gesture-required',
];

export async function launch({ headed = false } = {}) {
  const tries = [];
  if (process.env.CHROME_PATH) tries.push({ executablePath: process.env.CHROME_PATH, args: [] });
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) tries.push({ executablePath: p, args: [] });
  } catch {
    /* not installed */
  }
  if (!tries.length && process.platform === 'linux') {
    try {
      const sp = (await import('@sparticuz/chromium')).default;
      const args = sp.args.filter((a) => !a.startsWith('--single-process') && !a.startsWith('--headless'));
      tries.push({ executablePath: await sp.executablePath(), args });
    } catch {
      /* optional */
    }
  }
  if (!tries.length) {
    throw new Error('No Chromium found. Run: npx playwright install chromium (or set CHROME_PATH to Chrome).');
  }
  const { executablePath, args } = tries[0];
  return chromium.launch({ executablePath, headless: !headed, args: [...args, ...MEDIA_FLAGS] });
}
