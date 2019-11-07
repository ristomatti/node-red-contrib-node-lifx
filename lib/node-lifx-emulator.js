/* eslint no-console: 0 */

var inherits      = require('util').inherits;
var EventEmitter  = require('events').EventEmitter;

/**
 * Emulate Node-lifx light
 * @param {number} num Light number
 */
function NodeLifxLightEmulator(num) {

  this.id = 'dummy'+num;
  this.address = '1.2.3.4';
  this.label = 'Test' + num;
  this.status = (Math.random() > 0.5 ?'on' : 'off');
  this.power = 1;
  this.reachable = true;

  this.state = {
    power: 1,
    color: {
      hue: Math.floor(Math.random()*360),
      saturation: Math.floor(Math.random()*100),
      brightness: Math.floor(Math.random()*100),
      kelvin: 1500 + Math.floor(Math.random()*5000)
    }
  };
}

NodeLifxLightEmulator.prototype.getState = function getState(callback) {
  var self = this;
  setTimeout(() => {
    callback(null, self.state);
  }, Math.random() * 2000);
};

NodeLifxLightEmulator.prototype.on = function on() {
  console.log("%s.on()", this.id);
  this.state.power = 1;
}

NodeLifxLightEmulator.prototype.off = function off() {
  console.log("%s.off()", this.id);
  this.state.power = 0;
}

NodeLifxLightEmulator.prototype.color = function color(hue, sat, bri, kelvin) {
  console.log(`${this.id}.color(.., .., ${bri}%)`);
  this.state.color.hue        = hue    || this.state.color.hue;
  this.state.color.saturation = sat    || this.state.color.saturation;
  this.state.color.brightness = bri    || this.state.color.brightness;
  this.state.color.kelvin     = kelvin || this.state.color.kelvin;
}


/**
 * Emulate Node-Lifx
 */
function NodeLifxEmulator() {
  this.numLights = 100;
  this.lightList = [];

  // Randomly change state for one of the lights
  this.doStuff = function doStuff() {
    var index = Math.floor(Math.random()*this.numLights);
    var light = this.lightList[index];
    if (!light)
      return;

    light.reachable = !light.reachable;
    console.log(light.id, light.reachable);
    if (light.reachable) {
      this.emit('light-online', light);
    }
    else {
      this.emit('light-offline', light);
    }
  }.bind(this);
  this.doStuffInterval = null;


  EventEmitter.call(this);
}

inherits(NodeLifxEmulator, EventEmitter);

NodeLifxEmulator.prototype.stopDiscovery = function stopDiscovery() {
  clearInterval(this.doStuffInterval);
}

NodeLifxEmulator.prototype.stopSendingProcess = function stopSendingProcess() {
}

NodeLifxEmulator.prototype.destroy = function destroy() {
}


NodeLifxEmulator.prototype.init = function init(/*config*/) {
  var self = this;
  this.doStuffInterval = setInterval(this.doStuff, 1000);

  // Create 100 lights
  setTimeout(() => {
    for (let i=0; i < self.numLights; i++) {
      let light = new NodeLifxLightEmulator(i);
      self.lightList.push(light);
      self.emit('light-new', light);
    }
  }, 300);
}


module.exports = {
  Client: NodeLifxEmulator
}
