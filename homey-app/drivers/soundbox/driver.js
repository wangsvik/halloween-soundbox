'use strict';

const Homey = require('homey');
const SoundboxClient = require('../../lib/SoundboxClient');

const ALL_CATEGORIES = '*';

class SoundboxDriver extends Homey.Driver {
  async onInit() {
    const { flow } = this.homey;

    this.triggerStarted = flow.getDeviceTriggerCard('sound_started');
    this.triggerFinished = flow.getDeviceTriggerCard('sound_finished');
    this.triggerSpecificFinished = flow.getDeviceTriggerCard('specific_sound_finished');
    this.triggerSpecificFinished
      .registerRunListener(async (args, state) => args.sound.id === state.sound_id)
      .registerArgumentAutocompleteListener('sound', (query, args) => this.effectOptions(query, args.device));

    flow.getConditionCard('is_playing')
      .registerRunListener(async ({ device }) => device.getCapabilityValue('speaker_playing') === true);
    flow.getConditionCard('ambient_on')
      .registerRunListener(async ({ device }) => device.getCapabilityValue('onoff') === true);

    const action = (id, run) => flow.getActionCard(id).registerRunListener(run);
    const effectAutocomplete = (card) => card
      .registerArgumentAutocompleteListener('sound', (query, args) => this.effectOptions(query, args.device));

    effectAutocomplete(action('play_sound', ({ device, sound }) => device.client.play(sound.id)));
    effectAutocomplete(action('play_sound_volume', ({ device, sound, volume }) => device.client.play(sound.id, volume)));
    effectAutocomplete(action('play_sound_wait', ({ device, sound }) => device.client.playAndWait(sound.id)));

    action('play_random', ({ device, category }) => device.client.playRandom(
      category && category.id !== ALL_CATEGORIES ? category.id : null,
    )).registerArgumentAutocompleteListener('category', (query, args) => this.categoryOptions(query, args.device));

    action('ambient_start', ({ device, track }) => device.client.ambient(true, track.id))
      .registerArgumentAutocompleteListener('track', (query, args) => this.ambientOptions(query, args.device));
    action('ambient_stop', ({ device }) => device.client.ambient(false));
    action('stop_all', ({ device }) => device.client.stop('all'));

    // URL-kort: gir en lenke til lydfilen som kan sendes til Sonos, Chromecast o.l.
    const urlTokens = (client, sound) => ({
      url: client.mediaUrl(sound),
      sound: sound.name,
      category: sound.category,
    });
    effectAutocomplete(action('sound_url', async ({ device, sound }) => (
      urlTokens(device.client, await device.client.findEffect(sound.id)))));
    action('random_sound_url', async ({ device, category }) => urlTokens(
      device.client,
      await device.client.pickRandom(category && category.id !== ALL_CATEGORIES ? category.id : null),
    )).registerArgumentAutocompleteListener('category', (query, args) => this.categoryOptions(query, args.device));
    action('ambient_url', async ({ device, track }) => {
      const sound = await device.client.findAmbient(track.id);
      return { url: device.client.mediaUrl(sound), sound: sound.name };
    }).registerArgumentAutocompleteListener('track', (query, args) => this.ambientOptions(query, args.device));
  }

  // ---------- autocomplete ----------

  static match(query, ...fields) {
    const q = (query || '').trim().toLowerCase();
    return !q || fields.some((f) => (f || '').toLowerCase().includes(q));
  }

  static pretty(text) {
    const t = (text || '').replace(/-/g, ' ');
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  async effectOptions(query, device) {
    const { effects } = await device.client.sounds();
    return effects
      .filter((s) => SoundboxDriver.match(query, s.name, s.category, s.id))
      .map((s) => ({ id: s.id, name: s.name, description: SoundboxDriver.pretty(s.category) }));
  }

  async ambientOptions(query, device) {
    const { ambient } = await device.client.sounds();
    return ambient
      .filter((s) => SoundboxDriver.match(query, s.name, s.id))
      .map((s) => ({ id: s.id, name: s.name }));
  }

  async categoryOptions(query, device) {
    const { categories, effects } = await device.client.sounds();
    const all = { id: ALL_CATEGORIES, name: this.homey.__('all_categories'), description: `${effects.length}` };
    const items = categories.map((c) => ({
      id: c,
      name: SoundboxDriver.pretty(c),
      description: `${effects.filter((e) => e.category === c).length}`,
    }));
    return [all, ...items].filter((c) => SoundboxDriver.match(query, c.name, c.id));
  }

  // ---------- paring ----------

  async onPair(session) {
    let manual = null;
    let apiKey = '';

    session.setHandler('connect', async ({ address, port, apiKey: key }) => {
      apiKey = (key || '').trim();
      const addr = (address || '').trim();
      if (!addr) {
        manual = null;
        return { mode: 'discovery' };
      }
      const client = new SoundboxClient({ address: addr, port: port || 8080, apiKey });
      const info = await client.info();
      if (info.auth && !apiKey) throw new Error(this.homey.__('pair.needs_key'));
      if (info.auth) await client.state(); // verifiserer nøkkelen
      manual = { info, address: addr, port: Number(port) || 8080 };
      return { mode: 'manual', name: info.name };
    });

    session.setHandler('list_devices', async () => {
      if (manual) {
        return [{
          name: manual.info.name,
          data: { id: manual.info.id },
          settings: { address: manual.address, port: manual.port, api_key: apiKey },
        }];
      }
      const results = Object.values(this.getDiscoveryStrategy().getDiscoveryResults());
      return results.map((r) => ({
        name: (r.txt && r.txt.name) || r.name || 'Halloween Soundbox',
        data: { id: r.id },
        settings: { address: r.address, port: Number(r.port) || 8080, api_key: apiKey },
      }));
    });
  }
}

module.exports = SoundboxDriver;
