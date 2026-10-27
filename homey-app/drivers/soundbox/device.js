'use strict';

const Homey = require('homey');
const SoundboxClient = require('../../lib/SoundboxClient');

class SoundboxDevice extends Homey.Device {
  async onInit() {
    const settings = this.getSettings();
    this.client = new SoundboxClient({
      address: settings.address,
      port: settings.port,
      apiKey: settings.api_key,
      timers: this.homey,
      log: (...args) => this.log(...args),
    });

    this.client.on('connected', () => this.setAvailable().catch(this.error));
    this.client.on('disconnected', () => this.setUnavailable(this.homey.__('unreachable')).catch(this.error));
    this.client.on('state', (state) => this.applyState(state));
    this.client.on('sound_started', (ev) => this.onSoundStarted(ev));
    this.client.on('sound_finished', (ev) => this.onSoundFinished(ev));

    this.registerCapabilityListener('onoff', (on) => this.client.ambient(on));
    this.registerCapabilityListener('volume_set', (value) => this.client.volume(value * 100));
    this.registerCapabilityListener('speaker_playing', (playing) => (
      playing ? this.client.playRandom() : this.client.stop('effects')));

    if (!settings.address) await this.setUnavailable(this.homey.__('waiting_for_discovery'));
    this.client.connect();
  }

  applyState(state) {
    const current = state.current ? state.current.sound.name : '';
    const updates = {
      onoff: !!state.ambient,
      speaker_playing: !!state.playing,
      volume_set: state.volume / 100,
      current_sound: current || (state.ambient ? `🌫 ${state.ambient.name}` : '–'),
    };
    for (const [cap, value] of Object.entries(updates)) {
      if (this.getCapabilityValue(cap) !== value) {
        this.setCapabilityValue(cap, value).catch(this.error);
      }
    }
  }

  static tokens(ev) {
    return {
      sound: ev.sound.name,
      sound_id: ev.sound.id,
      category: ev.sound.category,
    };
  }

  onSoundStarted(ev) {
    this.driver.triggerStarted
      .trigger(this, { ...SoundboxDevice.tokens(ev), duration: ev.duration || 0 })
      .catch(this.error);
  }

  onSoundFinished(ev) {
    const interrupted = !!ev.interrupted;
    this.driver.triggerFinished
      .trigger(this, { ...SoundboxDevice.tokens(ev), interrupted })
      .catch(this.error);
    this.driver.triggerSpecificFinished
      .trigger(this, { interrupted }, { sound_id: ev.sound.id })
      .catch(this.error);
  }

  // ---------- mDNS ----------

  onDiscoveryResult(result) {
    return result.id === this.getData().id;
  }

  async onDiscoveryAvailable(result) {
    await this.updateAddress(result);
  }

  async onDiscoveryAddressChanged(result) {
    await this.updateAddress(result);
  }

  onDiscoveryLastSeenChanged() {
    if (!this.client.connected) this.client.reconnect();
  }

  async updateAddress(result) {
    const port = Number(result.port) || 8080;
    const settings = this.getSettings();
    if (settings.address === result.address && settings.port === port) return;
    this.log('Ny adresse fra mDNS:', `${result.address}:${port}`);
    await this.setSettings({ address: result.address, port });
    this.client.configure({ address: result.address, port });
  }

  // ---------- innstillinger ----------

  async onSettings({ newSettings }) {
    this.client.configure({
      address: newSettings.address,
      port: newSettings.port,
      apiKey: newSettings.api_key,
    });
  }

  async onUninit() {
    this.client.close();
  }

  async onDeleted() {
    this.client.close();
  }
}

module.exports = SoundboxDevice;
