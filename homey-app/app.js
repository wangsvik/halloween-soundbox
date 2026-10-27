'use strict';

const Homey = require('homey');

class HalloweenSoundboxApp extends Homey.App {
  async onInit() {
    this.log('Halloween Soundbox er klar 🎃');
  }
}

module.exports = HalloweenSoundboxApp;
