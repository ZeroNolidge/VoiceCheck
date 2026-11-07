// PlainSpeak (xVirtua repo): residents talk with an AI patient.
// Sign-in is an emailed link, so runs use a test account saved with
// `npm run login plainspeak`. Voice goes over WebRTC straight to OpenAI,
// which VoiceCheck can't stand in for yet, so PlainSpeak runs live only
// (real AI, real cost). Clips with real speech are needed: npm run clips.
import lines from './lines.json' with { type: 'json' };

export default {
  name: 'plainspeak',
  title: 'PlainSpeak (AI patient)',
  urls: { live: 'https://xsims-7ea9f.web.app', local: 'http://localhost:5173' },
  needsLogin: true,
  liveOnly: true,
  lines,
  loginHelp:
    'Type your PlainSpeak TEST email and send the link. When the email arrives, copy the link and paste it into the address bar of THIS window (not your usual browser).',
  async signedIn(page, timeout) {
    await page.waitForFunction(
      () => location.pathname === '/' && !document.querySelector('input[type=email]') && document.body.innerText.length > 40,
      null,
      { timeout, polling: 1000 },
    );
  },

  scenarios: {
    /** One short practice conversation, then End and wait for feedback. */
    async conversation(vc) {
      vc.acceptDialogs = true; // "End and get feedback?"
      await vc.open('/');
      await vc.step('Open the first patient', async () => {
        const card = vc.page.locator('.scenario-card').first();
        await card.waitFor({ state: 'visible', timeout: 20000 });
        await card.click();
      });
      await vc.tap('Start conversation', { timeout: 30000 });
      await vc.tap(/Start (the conversation|talking)|Continue the conversation/, { timeout: 30000 });
      await vc.micShouldBe(true, { timeout: 15000 });
      await vc.listen({ label: 'Patient speaks first', start: 30000, soft: true });
      for (const line of ['hello', 'explain', 'check']) {
        await vc.say(line);
        await vc.seeHeard({ timeout: 30000 });
        await vc.listen({ label: 'Patient answers', start: 30000 });
      }
      await vc.tap(/^End$/);
      await vc.see(/feedback|Wrapping up|Saving/i, { timeout: 60000, soft: true, label: 'Feedback starts' });
    },
  },
};
