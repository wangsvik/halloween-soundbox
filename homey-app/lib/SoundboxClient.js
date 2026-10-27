'use strict';

const http = require('http');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const REQUEST_TIMEOUT = 5000;
const PING_INTERVAL = 25000;
const STALE_AFTER = 70000;
const MAX_BACKOFF = 30000;
const SOUNDS_CACHE_MS = 10000;

/**
 * Klient mot Pi-serveren: REST for kommandoer, WebSocket for sanntidshendelser.
 *
 * Hendelser: 'connected', 'disconnected', 'state', 'sound_started', 'sound_finished'
 */
class SoundboxClient extends EventEmitter {
  constructor({ address, port = 8080, apiKey = '', timers = globalThis, log = () => {} }) {
    super();
    this.address = address;
    this.port = Number(port) || 8080;
    this.apiKey = apiKey || '';
    this.timers = timers;
    this.log = log;
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.backoff = 1000;
    this.lastMessage = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.soundsCache = null;
  }

  configure({ address, port, apiKey }) {
    const changed = (address !== undefined && address !== this.address)
      || (port !== undefined && Number(port) !== this.port)
      || (apiKey !== undefined && apiKey !== this.apiKey);
    if (address !== undefined) this.address = address;
    if (port !== undefined) this.port = Number(port) || 8080;
    if (apiKey !== undefined) this.apiKey = apiKey || '';
    if (changed) {
      this.soundsCache = null;
      this.reconnect();
    }
  }

  // ---------- REST ----------

  request(method, path, body) {
    return new Promise((resolve, reject) => {
      if (!this.address) {
        reject(new Error('Mangler IP-adresse til soundboxen'));
        return;
      }
      const data = body === undefined ? null : JSON.stringify(body);
      const headers = { Accept: 'application/json' };
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      if (this.apiKey) headers['X-Api-Key'] = this.apiKey;

      const req = http.request({
        host: this.address, port: this.port, path, method, headers, timeout: REQUEST_TIMEOUT,
      }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { buf += chunk; });
        res.on('end', () => {
          let json = {};
          try { json = buf ? JSON.parse(buf) : {}; } catch (err) { /* ikke JSON */ }
          if (res.statusCode >= 400) {
            const detail = typeof json.detail === 'string' ? json.detail : `HTTP ${res.statusCode}`;
            reject(new Error(detail));
          } else {
            resolve(json);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Soundboxen svarer ikke')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  info() { return this.request('GET', '/api/info'); }
  state() { return this.request('GET', '/api/state'); }
  play(id, volume) { return this.request('POST', '/api/play', volume == null ? { id } : { id, volume }); }
  playRandom(category, volume) { return this.request('POST', '/api/play/random', { category: category || null, volume: volume == null ? null : volume }); }
  ambient(on, id) { return this.request('POST', '/api/ambient', id ? { on, id } : { on }); }
  volume(level) { return this.request('POST', '/api/volume', { level: Math.round(level) }); }
  stop(what = 'all') { return this.request('POST', '/api/stop', { what }); }

  async sounds({ fresh = false } = {}) {
    if (!fresh && this.soundsCache && Date.now() - this.soundsCache.at < SOUNDS_CACHE_MS) {
      return this.soundsCache.data;
    }
    const data = await this.request('GET', '/api/sounds');
    this.soundsCache = { at: Date.now(), data };
    return data;
  }

  /** Full URL som Sonos/Chromecast kan strømme lydfilen fra. */
  mediaUrl(sound) {
    const key = this.apiKey ? `?key=${encodeURIComponent(this.apiKey)}` : '';
    return `http://${this.address}:${this.port}${sound.media}${key}`;
  }

  async findEffect(id) {
    const { effects } = await this.sounds();
    const sound = effects.find((s) => s.id === id);
    if (!sound) throw new Error(`Fant ikke lyden '${id}'`);
    return sound;
  }

  async findAmbient(id) {
    const { ambient } = await this.sounds();
    const track = ambient.find((s) => s.id === id);
    if (!track) throw new Error(`Fant ikke ambiens '${id}'`);
    return track;
  }

  /** Velg en tilfeldig effekt uten å spille den (unngår samme lyd to ganger på rad). */
  async pickRandom(category) {
    const { effects } = await this.sounds();
    let pool = category ? effects.filter((s) => s.category === category) : effects;
    if (!pool.length) throw new Error('Ingen lyder å velge mellom');
    if (pool.length > 1) pool = pool.filter((s) => s.id !== this.lastPicked);
    const sound = pool[Math.floor(Math.random() * pool.length)];
    this.lastPicked = sound.id;
    return sound;
  }

  /** Spill en lyd og vent til den er ferdig (eller avbrutt). */
  async playAndWait(id, volume) {
    const started = await this.play(id, volume);
    const limit = Math.max(5, (started.duration || 0) + 10) * 1000;
    return new Promise((resolve) => {
      const done = (ev) => {
        if (ev.play_id !== started.play_id) return;
        this.timers.clearTimeout(timer);
        this.off('sound_finished', done);
        resolve(ev);
      };
      const timer = this.timers.setTimeout(() => {
        this.off('sound_finished', done);
        resolve({ ...started, timeout: true });
      }, limit);
      this.on('sound_finished', done);
    });
  }

  // ---------- WebSocket ----------

  connect() {
    this.closed = false;
    if (!this.address || this.ws) return;
    const query = this.apiKey ? `?key=${encodeURIComponent(this.apiKey)}` : '';
    const ws = new WebSocket(`ws://${this.address}:${this.port}/ws${query}`, { handshakeTimeout: REQUEST_TIMEOUT });
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = 1000;
      this.lastMessage = Date.now();
      this.connected = true;
      this.emit('connected');
      this.pingTimer = this.timers.setInterval(() => this._ping(), PING_INTERVAL);
    });

    ws.on('message', (raw) => {
      this.lastMessage = Date.now();
      const text = raw.toString();
      if (text === 'pong') return;
      let msg;
      try { msg = JSON.parse(text); } catch (err) { return; }
      if (msg && msg.type === 'library') this.soundsCache = null; // nye/slettede lyder
      if (msg && msg.type) this.emit(msg.type, msg);
    });

    ws.on('error', (err) => this.log('WebSocket-feil:', err.message));
    ws.on('close', () => this._onClose(ws));
  }

  _ping() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastMessage > STALE_AFTER) {
      this.ws.terminate();
      return;
    }
    this.ws.send('ping');
  }

  _onClose(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.timers.clearInterval(this.pingTimer);
    if (this.connected) {
      this.connected = false;
      this.emit('disconnected');
    }
    if (this.closed) return;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.timers.setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
  }

  reconnect() {
    this.backoff = 1000;
    this.timers.clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.terminate(); // _onClose planlegger ny tilkobling
    } else if (!this.closed) {
      this.connect();
    }
  }

  close() {
    this.closed = true;
    this.timers.clearTimeout(this.reconnectTimer);
    this.timers.clearInterval(this.pingTimer);
    if (this.ws) this.ws.terminate();
    this.removeAllListeners();
  }
}

module.exports = SoundboxClient;
