'use strict';

// Integrasjonstest: kjører driver + device mot en ekte Pi-server (standard localhost:8080)
// uten Homey, ved å etterligne de delene av Homey SDK-en appen bruker.
//   SOUNDBOX_ADDRESS=192.168.1.50 npm test

const assert = require('assert');
const Module = require('module');
const path = require('path');

const triggered = [];
const cards = {};
const card = (id) => (cards[id] = cards[id] || {
  id,
  run: null,
  autocomplete: {},
  registerRunListener(fn) { this.run = fn; return this; },
  registerArgumentAutocompleteListener(arg, fn) { this.autocomplete[arg] = fn; return this; },
  async trigger(device, tokens, state) {
    if (this.run && state && !(await this.run({ ...this.args, device }, state))) return;
    triggered.push({ id, tokens, state });
  },
});

const fakeHomey = {
  __: (k) => k,
  flow: {
    getDeviceTriggerCard: card, getConditionCard: card, getActionCard: card,
  },
  setTimeout, clearTimeout, setInterval, clearInterval,
};

class Base {
  constructor() { this.homey = fakeHomey; }
  log(...a) { if (process.env.DEBUG) console.log(...a); }
  error(...a) { console.error(...a); }
}
class Device extends Base {
  constructor(settings) { super(); this._settings = settings; this._caps = {}; this.available = null; this._listeners = {}; }
  getSettings() { return this._settings; }
  getData() { return { id: 'test' }; }
  getCapabilityValue(c) { return this._caps[c]; }
  async setCapabilityValue(c, v) { this._caps[c] = v; }
  registerCapabilityListener(c, fn) { this._listeners[c] = fn; }
  async setAvailable() { this.available = true; }
  async setUnavailable() { this.available = false; }
  async setSettings(s) { Object.assign(this._settings, s); }
}
class Driver extends Base {}

const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === 'homey' ? 'homey' : resolve.call(this, request, ...rest);
};
require.cache.homey = { id: 'homey', filename: 'homey', loaded: true, exports: { Device, Driver, App: Base } };

const SoundboxDriver = require(path.join(__dirname, '../drivers/soundbox/driver.js'));
const SoundboxDevice = require(path.join(__dirname, '../drivers/soundbox/device.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await wait(50); }
  throw new Error('Tidsavbrudd');
}

(async () => {
  const driver = new SoundboxDriver();
  await driver.onInit();
  const device = new SoundboxDevice({ address: process.env.SOUNDBOX_ADDRESS || '127.0.0.1', port: 8080, api_key: '' });
  device.driver = driver;
  await device.onInit();
  await until(() => device.available === true);
  console.log('✓ tilkoblet, tilgjengelig');

  const sounds = await cards.play_sound.autocomplete.sound('', { device });
  assert(sounds.length > 0, 'ingen lyder');
  console.log('✓ autocomplete lyder:', sounds.map((s) => s.name).join(', '));
  const cats = await cards.play_random.autocomplete.category('', { device });
  console.log('✓ autocomplete kategorier:', cats.map((c) => c.name).join(', '));
  const amb = await cards.ambient_start.autocomplete.track('', { device });

  await device._listeners.volume_set(0.4);
  await until(() => device.getCapabilityValue('volume_set') === 0.4);
  console.log('✓ volum 40 %');

  await cards.ambient_start.run({ device, track: amb[0] });
  await until(() => device.getCapabilityValue('onoff') === true);
  assert.strictEqual(await cards.ambient_on.run({ device }), true);
  console.log('✓ ambiens på:', amb[0].name);

  cards.specific_sound_finished.args = { sound: sounds[0] };
  const t0 = Date.now();
  const result = await cards.play_sound_wait.run({ device, sound: sounds[0] });
  console.log(`✓ spill-og-vent ferdig etter ${Date.now() - t0} ms (varighet ${result.duration}s)`);
  await wait(200);
  assert(triggered.some((t) => t.id === 'sound_started' && t.tokens.sound_id === sounds[0].id));
  assert(triggered.some((t) => t.id === 'sound_finished' && t.tokens.sound_id === sounds[0].id));
  assert(triggered.some((t) => t.id === 'specific_sound_finished'));
  console.log('✓ triggere: sound_started, sound_finished, specific_sound_finished');

  await cards.play_random.run({ device, category: cats[0] });
  await until(() => device.getCapabilityValue('speaker_playing') === true);
  assert.strictEqual(await cards.is_playing.run({ device }), true);
  console.log('✓ tilfeldig lyd spiller:', device.getCapabilityValue('current_sound'));

  await cards.stop_all.run({ device });
  await until(() => !device.getCapabilityValue('speaker_playing') && !device.getCapabilityValue('onoff'));
  assert(triggered.some((t) => t.id === 'sound_finished' && t.tokens.interrupted === true));
  console.log('✓ stopp alt (avbrutt-token satt)');

  const http = require('http');
  const fetchStatus = (url) => new Promise((res, rej) => http.get(url, (r) => {
    r.resume();
    res(`${r.statusCode} ${r.headers['content-type']} ${r.headers['content-length']}`);
  }).on('error', rej));

  const one = await cards.sound_url.run({ device, sound: sounds[0] });
  assert(one.url.startsWith('http://') && one.sound === sounds[0].name);
  console.log('✓ lyd-URL:', one.url, '→', await fetchStatus(one.url));
  const r1 = await cards.random_sound_url.run({ device, category: cats[0] });
  const r2 = await cards.random_sound_url.run({ device, category: cats[0] });
  assert.notStrictEqual(r1.url, r2.url, 'samme tilfeldige lyd to ganger på rad');
  console.log('✓ tilfeldig URL:', r1.sound, '→', r2.sound);
  const a = await cards.ambient_url.run({ device, track: amb[0] });
  console.log('✓ ambiens-URL:', a.url, '→', await fetchStatus(a.url));
  assert.strictEqual(device.getCapabilityValue('speaker_playing'), false, 'URL-kort skal ikke spille på Pi-en');

  await device.onDeleted();
  console.log('\nAlle tester bestått 🎃');
  process.exit(0);
})().catch((err) => { console.error('✖', err); process.exit(1); });
