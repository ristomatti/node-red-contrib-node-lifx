"use strict";

var _            = require('lodash');
var LifxClient   = require('lifx-lan-client').Client;

var inherits     = require('util').inherits;
var EventEmitter = require('events').EventEmitter;

var LightItem    = require('./lifx-light.js');


/**
 * Create unique id from Lifx info
 * @param  {object}  lifxInfo Lifx info
 * @return {string} ID
 */
function createLightID(lifxInfo) {
  return lifxInfo.id;
}


/**
 * Light handler handles communication between server and client
 * @param {string}      lightID     Light ID to set and get changes from
 * @param {LightServer} lightServer Server object
 */
function LightHandler(lightID, lightServer) {
  this.id = lightID;
  this.lightServer = lightServer;
  EventEmitter.call(this);
}
inherits(LightHandler, EventEmitter);


/**
 * Set state of light
 * @param  {object}  data New light data
 * @return {boolean}      False if there is no such light or it's not discovered yet
 */
LightHandler.prototype.setLightState = function setState(data) {
  return this.lightServer.setLightState(this.id, data);
};

/**
 * Set waveform of light
 * @param  {object}  data New light data
 * @return {boolean}      False if there is no such light or it's not discovered yet
 */
LightHandler.prototype.setLightWaveForm = function setState(data) {
  return this.lightServer.setLightWaveForm(this.id, data);
};

/**
 * Send data to light
 * @param  {object} data New light data
 * @return {object}      Light state, null if there is no such light
 */
LightHandler.prototype.getLightState = function getLightState() {
  return this.lightServer.getLightState(this.id);
};


/**
 * Used to emit that this light has been found
 * @param  {object} data Light information
 */
LightHandler.prototype.emitNew = function emitNew(data) {
  this.emit('new', data);
}


/**
 * Used to emit that the light has been updated
 * @param  {object} data Light information
 */
LightHandler.prototype.emitUpdate = function emitUpdate(data) {
  this.emit('update', data);
};



/**
 * Create new light server
 * @param {object} config Configuraion
 */
function LightServer(config) {
  EventEmitter.call(this);

  var self = this;

  self.config = _.merge({}, config);

  // Convert from string
  if (typeof self.config.interval === 'string')
    self.config.interval = parseInt(self.config.interval, 10);

  // Ensure that we have valid poll interval
  if (typeof self.config.interval !== 'number' || isNaN(self.config.interval))
    self.config.interval = 10000;
  // Ensure that we don't use to low poll interval
  else if (self.config.interval < 500)
    self.config.interval = 500;

  this.nodeList = {};
  this.nodeListCount = 0;

  // List of all lights
  this.lights = {};

  // Node-Lifx configuration
  this.lifxConfig = {
    debug: false,
    stopAfterDiscovery: false
  };

  // Populate Node-Lifx configuration
  if (_.isString(self.config.address) && self.config.address.length)
    this.lifxConfig.address = this.config.address;
  if (_.isString(self.config.broadcast) && self.config.broadcast.length)
    this.lifxConfig.broadcast = this.config.broadcast;
  if (_.isString(self.config.lights) && self.config.lights)
    this.lifxConfig.lights = this.config.lights.split(/ *, */g);

  // Create new API
  this.lifxClient = new LifxClient();

  // New lifx detected
  this.lifxClient.on('light-new', (lifxLight) => {
    // Ensure that we don't have multiple lights with the same id
    let lightID = createLightID(lifxLight);
    if (self.lights.hasOwnProperty(lightID))
      return;

    // Create the new light
    self.newLight(lightID, lifxLight, (err) => {
      if (err) {
        return self.emit('error', err.message, err.stack);
      }
    });
  });

  // Offline state detected
  this.lifxClient.on('light-offline', (lightOffline) => {
    let lightID = createLightID(lightOffline)
    if (!self.lights.hasOwnProperty(lightID))
      return;

    var light = self.lights[lightID];
    light.setReachable(false);
  });

  // Online state detected
  this.lifxClient.on('light-online', (lightOnline) => {
    let lightID = createLightID(lightOnline);
    if (!self.lights.hasOwnProperty(lightID))
      return;

    var light = self.lights[lightID];
    light.setReachable(true);
  });

}

inherits(LightServer, EventEmitter);


/**
 * Initialize the server
 * @param  {function} callback Result callback
 */
LightServer.prototype.init = function init(callback) {
  try {
    this.lifxClient.init(this.lifxConfig);
  } catch(e) {
    callback(e);
    return;
  }
  callback(null);
}


/**
 * Stop the server
 */
LightServer.prototype.stop = function stop() {
  var self = this;

  Object.keys(this.lights).forEach((lightID) => {
    var light = self.lights[lightID];
    light.stop();
  });
  this.lights = {};

  this.lifxClient.stopDiscovery();
  this.lifxClient.stopSendingProcess();
  this.lifxClient.destroy();
  this.lifxClient = null;
}


/**
 * Create new light for the server
 * @param {string}  lightID  ID for light/group
 * @param {object}  lifxInfo Lifx info
 * @param {function} callback Result callback
 */
LightServer.prototype.newLight = function newLight(lightID, lifxInfo, callback) {
  var self = this;
  var light = new LightItem(lightID, lifxInfo, this.config);

  light.initialize((err) => {
    if (err)
      return callback(err);

    light.on('error', (msg, obj) => {
      self.emit('error', msg, obj);
    });

    light.on('warning', (msg, obj) => {
      self.emit('warning', msg, obj);
    });

    light.on('change', () => {
      self.statusUpdateLight(lightID, light, 'change');
    });

    light.on('update', () => {
      self.statusUpdateLight(lightID, light, 'update');
    })

    // Attach the light
    self.lights[lightID] = light;

    let message = light.getStateMessage();
    message.event = 'new';

    // Check if anybody has registered for this light, need to tell them about this new light
    if (self.nodeList.hasOwnProperty(lightID)) {
      let lightHandler = this.nodeList[lightID];

      lightHandler.emitNew(message);
    }

    // Emit light-new from the server to allow listeners to see the new light
    self.emit('light-new', message);

    callback(null, light);
  });
}


/**
 * Using light find all connected nodes and update state for them
 * @param {string} lightID  ID for light/group
 * @param {object} light    Lifx light
 * @param {string} event    Event triggering this update
 */
LightServer.prototype.statusUpdateLight = function statusUpdateLight(lightID, light, event) {
  if (!this.nodeList.hasOwnProperty(lightID))
    return;

  let lightHandler = this.nodeList[lightID];

  let message = light.getStateMessage();
  message.event = event;

  lightHandler.emitUpdate(message);
};


/**
 * Get light handle that communicates between server and client
 * @param  {string}       lightID ID/Label of the light
 * @return {LightHandler}         Light handler object, emit change events from light and receive new state
 */
LightServer.prototype.getLightHandler = function getLightHandler(lightID) {
  var lightHandler;

  // Create new light handler if needed
  if (!this.nodeList.hasOwnProperty(lightID)) {
    this.nodeList[lightID] = new LightHandler(lightID, this);
  }

  lightHandler = this.nodeList[lightID];

  return lightHandler;
};


/**
 * Change light state
 * @param  {string} lightID ID/Label for the light
 * @param  {object} value   New values for the light
 * @return {boolean}        False if no such light exists
 */
LightServer.prototype.setLightState = function setLightState(lightID, value) {
  if (!this.lights.hasOwnProperty(lightID))
    return false;

  var light = this.lights[lightID];

  // Update light color
  light.setColor(value);
  return true;
}


/**
 * Get current light state
 * @param  {string} lightID ID/Label for the light
 * @return {object} null if the light doesn't exists, else the current light state
 */
LightServer.prototype.getLightState = function getLightState(lightID) {
  if (!this.lights.hasOwnProperty(lightID))
    return null;

  var light = this.lights[lightID];
  return light.getStateMessage();
}


/**
 * Retreive list of detected lights
 * @return {array} Array with id, address and label for each light
 */
LightServer.prototype.getLights = function getLights() {
  var self = this;
  var retVal = Object.keys(self.lights).reduce((coll, lightID) => {
    var light = self.lights[lightID];
    var val = { id: lightID, info: light.info.address, name: light.info.label };
    coll.push(val);
    return coll;
  }, []);

  return retVal;
}

/**
 * Set light state wave form
 *
 * example {
 *   isTransient: true,
 *   color: {hue: 0, saturation: 65535, brightness: 65535, kelvin: 3500},
 *   period: 800,
 *  cycles: 3,
 *  skewRatio: 0,
 *  waveform:  SAW, SINE, HALF_SINE, TRIANGLE, PULSE
 * }
 * @param  {string} lightID ID/Label for the light
 * @param  {object} value   New values for the light wave form
 * @return {boolean}        False if no such light exists
 */
LightServer.prototype.setLightWaveForm = function setLightWaveForm(lightID, value) {

  if (!this.lights.hasOwnProperty(lightID))
    return false;

  value.waveform = nodeLifx.constants.LIGHT_WAVEFORMS.indexOf(value.waveform)

  var packetObj = nodeLifx.packet.create('setWaveform', value, this.lifxClient.source);

  packetObj.target = lightID

  this.lifxClient.send(packetObj, () => {})

  return true;
}


/**
 * Exports LightServer
 */
module.exports = LightServer;
