// xThera (VirtualTherapist repo): the Tagalog therapist demo.
// Voice loop: Tap to talk -> recording -> POST /api/transcribe -> /api/reply
// -> /api/speech (one clip per sentence) -> plays -> Tap to talk again.
import { babble, secondsForText, wavFromFloat } from '../../src/audio.mjs';
import lines from './lines.json' with { type: 'json' };

export default {
  name: 'xthera',
  title: 'xThera (Tagalog therapist)',
  urls: { local: 'http://localhost:5173' },
  lines,

  /** Stands in for the API server's AI so nothing costs money. */
  async fakes(vc) {
    const replies = [
      'Salamat sa pagbabahagi. Ano ang pinakamabigat sa iyo ngayon?',
      'Naiintindihan ko. Mahirap talaga kapag kulang sa tulog. Ano ang nakakatulong sa iyo?',
      'Mabuti at nasabi mo iyan. Subukan natin ang isang maikling paghinga nang sabay.',
      'Salamat. Magaling ang ginawa mo ngayon.',
    ];
    let n = 0;
    // Without a key the server can't summarize; the app falls back to its offline summary.
    vc.ignore.push(/\/api\/summary/, /status of 503/);
    await vc.fake('**/api/health', () => ({
      openai: true, cartesia: true, tagalogVoice: 'cartesia', avatar: false, avatarMode: null,
      voices: ['sage'], defaultVoice: 'sage', passcodeRequired: false,
    }));
    await vc.fake('**/api/transcribe', (req) => {
      vc.fakeLog?.push({ call: 'transcribe', bytes: req.postDataBuffer()?.length ?? 0 });
      return { text: vc.lastSaid?.text ?? '' };
    });
    await vc.fake('**/api/reply', () => ({ reply: replies[n++ % replies.length], mood: n % 2 ? 'calm' : 'warm', stepDone: true }));
    await vc.fake('**/api/speech', (req) => {
      const { text = '' } = JSON.parse(req.postData() || '{}');
      return { contentType: 'audio/wav', body: wavFromFloat(babble(secondsForText(text), { rate: 24000, pitch: 210, seed: text.length }), 24000) };
    });
  },

  scenarios: {
    /** The Tagalog test session: greeting, three spoken turns, end, therapist view. */
    async tagalog(vc) {
      await vc.open('/');
      await vc.tap('Start Tagalog test');
      await vc.see(/Before we start/);
      await vc.tap('I understand, start');
      await vc.listen({ label: 'Therapist greets' });
      for (const line of ['tl-hello', 'tl-worry', 'tl-mood']) {
        await vc.tap(/Magsalita|Tap to talk/);
        await vc.micShouldBe(true);
        await vc.say(line);
        await vc.tap(/Tapos na|Done talking/);
        await vc.micShouldBe(false);
        await vc.seeHeard();
        await vc.listen({ label: 'Therapist answers' });
      }
      await vc.see(/Script step \d of \d/, { soft: true });
      await vc.tap('End session');
      await vc.screenshot('ended');
    },

    /** Cutting in: start talking while the therapist is still speaking. */
    async interrupt(vc) {
      await vc.open('/');
      await vc.tap('Start Tagalog test');
      await vc.tap('I understand, start');
      await vc.talking({ label: 'Therapist starts her greeting' });
      await vc.wait(700);
      await vc.tap(/Magsalita|Tap to talk/);
      await vc.quiet({ within: 500, label: 'She stops when cut off' });
      await vc.micShouldBe(true);
      await vc.say('tl-hello');
      await vc.tap(/Tapos na|Done talking/);
      await vc.seeHeard();
      await vc.listen({ label: 'Therapist answers after the interruption' });
    },

    /** Mic blocked: the app should say so and offer typing. */
    async 'mic-blocked'(vc) {
      await vc.open('/');
      await vc.tap('Start Tagalog test');
      await vc.tap('I understand, start');
      await vc.listen({ label: 'Therapist greets' });
      await vc.tap(/Magsalita|Tap to talk/);
      await vc.see(/Microphone not available/);
      await vc.see(/Your message|type/i, { soft: true });
    },
  },
  options: { 'mic-blocked': { denyMic: true } },
};
