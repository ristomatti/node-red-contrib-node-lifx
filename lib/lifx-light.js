"use strict";

var _        = require('lodash');
var Enum     = require('enum');
var async    = require('async');

var inherits      = require('util').inherits;
var EventEmitter  = require('events').EventEmitter;

var colorConvert   = require('color-convert');
var colorTemp      = require('color-temp');
var colorSpace     = require('color-space');


// Light capabilities
const LightCapability = new Enum([
  'TEMPERATURE',
  'COLOR',
  'INFRARED'
]);


/**
 * Converts/Filters Lifx info to internal state
 * @param  {object} lifxInfo Lifx info
 * @return {object} Internal state
 */
function convertLifxState(lifxInfo) {
  const hueStateProperties = {
    hue: true,
    saturation: true,
    brightness: true,
    kelvin: true,
  };

  var state = _.reduce(lifxInfo.color, (coll, value, key) => {
    if (!hueStateProperties.hasOwnProperty(key))
      return coll;
    
    var stateItem = hueStateProperties[key];

    if (stateItem === true)
      coll[key] = value;
    if (typeof stateItem === 'string')
      coll[stateItem] = value;
    return coll;
  }, { on: false, brightness: 0});

  // Inject on status
  state.on = (lifxInfo.power !== 0);

  return state;
}


/**
 * Ensure that value is inside value range
 * @param  {number} val Current value
 * @param  {number} min Min value
 * @param  {number} max Max value
 * @return {number} Limited value
 */
function limitValue(val, min, max) {
  if (isNaN(val))
    val = min;
  if (val > max)
    val = max;
  if (val < min)
    val = min;
  return val;
}


/**
 * Light Class
 * @param {string}    lightID    Light ID
 * @param {LifxLight} lifxLight  Light from node-lifx
 * @param {object}    config     Configuration
 * @param {number}    config.pollInterval Poll interval
 */
function LightItem(lightID, lifxLight, config) {
  EventEmitter.call(this);
  
  this.initialized = false;

  this.id        = lightID;
  this.lifx      = lifxLight;
  this.modified  = 0;
  this.pollTimer = null;

  this.info = {
    // All Lifx lights seems to have temperature support
    capability: LightCapability.TEMPERATURE,
    id:         lifxLight.id,
    address:    lifxLight.address,
    label:      lifxLight.label,
    reachable:  true,
    maxIRLevel: 0, // Only valid for IR capable lights
  }

  // Default state
  this.state = {
    on:         false,
    brightness: 0,
  }

  // Copy server configuration
  this.config = _.merge({}, config);
  this.config.pollInterval = this.config.pollInterval || 5000;
}

inherits(LightItem, EventEmitter);



/**
 * Initialize the light
 * @param {function} callback Done callback
 */
LightItem.prototype.initialize = function initialize(callback) {
  var self = this;

  // All Lifx lights seems to have temperature support, so use that as default
  var capability = LightCapability.TEMPERATURE;

  async.series([

    // Get hardware info, need to process capabilities before going to next function
    (done) => {
      self.lifx.getHardwareVersion((err, info) => {
        if (err)
          return done(err);

        if (_.isPlainObject(info.productFeatures)) {
          if (info.productFeatures.color === true)
            capability = LightCapability.get(capability| LightCapability.COLOR);

          if (info.productFeatures.infrared === true)
            capability = LightCapability.get(capability | LightCapability.INFRARED);
        }
        done(null, info);
      });
    },

    // Get current state
    (done) => {
      self.lifx.getState(done);
    },

    // Get current IR level (if supported)
    (done) => {
      if (!(capability & LightCapability.INFRARED))
        return done(null, null);
      self.lifx.getMaxIR(done);
    },

  ], (err, data) => {
    if (err) {
      return callback(err);
    }

    var lifxHWInfo = data[0];
    var lifxInfo   = data[1];
    var lifxMaxIR  = data[2];


    self.info.capability = capability;
    self.info.model      = lifxHWInfo.productName || 'N/A';

    // Update state information
    self.state = convertLifxState(lifxInfo);

    // Infrared
    if (self.info.capability | LightCapability.INFRARED)
      self.info.maxIRLevel = lifxMaxIR;

    // Update label
    self.info.label = lifxInfo.label;

    // Start poll timer
    self.pollTimer = setInterval(self.pollChanges.bind(self), self.config.pollInterval);

    // Initialization done
    self.initialized = true;

    callback(null);
  });
}


/**
 * Stop the light
 */
LightItem.prototype.stop = function stop() {
  var self = this;
  if (self.pollTimer)
    clearInterval(self.pollTimer);
  self.pollTimer = null;
}


/**
 * Poll light for changes
 */
LightItem.prototype.pollChanges = function pollChanges() {
  var self = this;

  async.series([
    // Get state info
    (done) => {
      self.lifx.getState(done);
    },

    // Get IR info (if we have the capability)
    (done) => {
      if (!(self.info.capability & LightCapability.INFRARED))
        return done(null, null);
      self.lifx.getMaxIR(done);
    }
  ], (err, data) => {
    if (err) {
      return;
    }

    var lifxState = data[0];
    var lifxMaxIR = data[1];

    // Light is reachable
    this.setReachable(true);

    // We need to ignore the changes for this light until modified value has expired
    if (self.modified >= process.uptime())
      return;

    var newState = convertLifxState(lifxState);
    var isUpdated = false;

    // Determine if state is updated
    isUpdated = !_.isEqual(self.state, newState);
    if (isUpdated)
      self.state = newState;

    if (self.info.capability & LightCapability.INFRARED && _.isFinite(lifxMaxIR)) {
      isUpdated = (self.info.maxIRLevel !== lifxMaxIR) || isUpdated;
      self.info.maxIRLevel = limitValue(Math.round(lifxMaxIR), 0, 100);
    }

    // Copy label
    self.info.label = lifxState.label;

    // Values/state has been updated
    if (isUpdated)
      self.emit('update');
  });
}


/**
 * Check if we have new color and calculate updated properties
 * @param  {object} input  Input arguments
 * @param  {object} output New state arguments
 * @return {bool}          Is color updated
 */
LightItem.prototype.parseColorRGB = function updateColorRGB(input, output) {

  // We want to run this function even though we don't have any color capability,
  // this is so we can extract the brightness from the specified color

  var changed = false;
  var hsv = [this.state.hue||0, this.state.saturation||0, this.state.brightness||0];

  // hue
  if (_.isFinite(input.hue)) {
    changed = true;
    hsv[0] = limitValue(input.hue, 0, 360);
  }

  // rgb channel
  else if (_.isArray(input.rgb) &&
          input.rgb.length === 3 &&
           _.isFinite(input.rgb[0]) &&
           _.isFinite(input.rgb[1]) &&
           _.isFinite(input.rgb[2])) {
    changed = true;
    
    // Create new rgb ensuring values is in valid range
    let rgb = [
      limitValue(input.rgb[0], 0, 0xFF),
      limitValue(input.rgb[1], 0, 0xFF),
      limitValue(input.rgb[2], 0, 0xFF)
    ];

    // Convert to hsv
    hsv = colorSpace.rgb.hsv(rgb);
  }

  // rgb channel
  else if (_.isFinite(input.red)   ||
           _.isFinite(input.green) ||
           _.isFinite(input.blue)) {
    changed = true;

    // Convert HSV to RGB and update affected channels
    let rgb = colorSpace.hsv.rgb(hsv);

    // Get channel values
    if (_.isFinite(input.red))
      rgb[0] = input.red;
    if (_.isFinite(input.green))
      rgb[1] = input.green;
    if (_.isFinite(input.blue))
      rgb[2] = input.blue;

    // Ensure that values is in valid range
    rgb[0] = limitValue(rgb[0], 0, 0xFF);
    rgb[1] = limitValue(rgb[1], 0, 0xFF);
    rgb[2] = limitValue(rgb[2], 0, 0xFF);

    // Convert to hsv
    hsv = colorSpace.rgb.hsv(rgb);
  }

  // hex
  else if (_.isString(input.hex) && /^#?[0-9a-fA-F]{6}$/.test(input.hex)) {
    changed = true;
    hsv = colorSpace.rgb.hsv(colorConvert.hex.rgb(input.hex));
  }

  // Saturation
  if (_.isFinite(input.sat)) {
    changed = true;
    hsv[1] = input.sat;
  }
  else if (_.isFinite(input.saturation)) {
    changed = true;
    hsv[1] = input.saturation;
  }

  // No change
  if (!changed)
    return false;

  // No color support
  if (!(this.info.capability & LightCapability.COLOR)) {
    // Check if the brightness has been modified by the color change
    if (hsv[2] !== this.state.brightness) {
      output.brightness = limitValue(Math.round(hsv[2]), 0, 100);
      return true;
    }

    return false;
  }

  // Round the values and make sure that they are in the valid range
  output.hue        = limitValue(Math.round(hsv[0]), 0, 360);
  output.saturation = limitValue(Math.round(hsv[1]), 0, 100);
  output.brightness = limitValue(Math.round(hsv[2]), 0, 100);

  return true;
}


/**
 * Check if we have new temperature color and calculate updated properties
 * @param  {object} input  Input arguments
 * @param  {object} output New state arguments
 * @return {bool}          Is temperature color updated
 */
LightItem.prototype.parseColorTemp = function parseColorTemp(input, output) {

  // Check if we have temperature support
  if (!(this.info.capability & LightCapability.TEMPERATURE))
    return false;

  var changed = false;
  var kelvin  = this.state.kelvin;

  // Mired/Mirek color temperature
  if (_.isFinite(input.ct)) {
    kelvin = 1000000 / limitValue(input.ct, 100, 500);
    changed = true;
  }

  else if (_.isFinite(input.mirek)) {
    kelvin = 1000000 / limitValue(input.mirek, 100, 500);
    changed = true;
  }

  else if (_.isFinite(input.mired)) {
    kelvin = 1000000 / limitValue(input.mired, 100, 500);
    changed = true;
  }

  // Kelvin color temperature
  else if (_.isFinite(input.kelvin)) {
    kelvin = input.kelvin;
    changed = true;
  }

  // No change
  if (!changed)
    return false;

  // Round the values and make sure that they are in the valid range
  output.kelvin = limitValue(Math.round(kelvin), 2000, 10000);

  return true;
}


/**
 * Check if we have new brightness value and calculate updated properties
 * @param  {object} input  Input arguments
 * @param  {object} output New state arguments
 * @return {bool}          Is brightness updated
 */
LightItem.prototype.parseBrightness = function updateColorBri(input, output) {
  var bri = this.state.brightness;
  var changed = false;
  
  // Brightness
  if (_.isFinite(input.bri)) {
    bri = input.bri;
    changed = true;
  }
  else if (_.isFinite(input.brightness)) {
    bri = input.brightness;
    changed = true;
  }

  // No change
  if (!changed)
    return false;

  // Round the values and make sure that they are in the valid range
  output.brightness = limitValue(Math.round(bri), 0, 100);
  return true;
}


/**
 * Update light to new state, parse/convert input parameters to correct light parameter
 * @param  {object} input  Input arguments
 * @return {object}        Updated state parameters
 */
LightItem.prototype.setColor = function setColor(input) {
  if (!this.initialized)
    return;

  var changedIR    = false;
  var changedColor = false;
  var newValues = {};
  var isOn = this.state.on;

  // Ensure that input is of correct type
  if (!_.isPlainObject(input)) {
    // Convert boolean to on
    if (_.isBoolean(input)) {
      input = { on: input };
    }
    // On/Off string
    else if (input === 'on' || input === 'off') {
      input = { on: (input === 'on') };
    }
    // Convert number to brightness, also enables the light
    else if (_.isFinite(input)) {
      input = { on: true, bri: input };
    }
    // Unknown input
    else {
      this.emit('warning', 'Unhandled input', input);
      return;
    }
  }

  // First check if RGB values has been updated
  if (this.parseColorRGB(input, newValues))
    changedColor = true;

  // Then, parse temperature
  if (this.parseColorTemp(input, newValues))
    changedColor = true;

  // Finally parse brightness
  if (this.parseBrightness(input, newValues))
    changedColor = true;

  // On/Off
  if (_.isBoolean(input.on)) {
    newValues.on = input.on;
    changedColor = true;
  }

  // Infrared max level
  if ((this.info.capability & LightCapability.INFRARED) && _.isFinite(input.maxIR)) {
    this.maxIR = limitValue(Math.round(input.maxIR), 0, 100);
    changedIR = true;
  }

  // Ignore color changes when going offline, this is because we can't both turn
  // of the light and change the color in one go. To facilitate this we would
  // need to add timer that wait for the light to go off and then change the color
  if (isOn && !this.state.on) {
    this.state.on = false;
  }
  // Merge configurations
  else {
    _.merge(this.state, newValues);
  }

  // Ensure that we don't trigger on our own update
  this.modified = process.uptime() + 2;

  // Duration
  var duration = 0;
  if (_.isFinite(input.duration) && input.duration > 0) {
    duration = input.duration;

    // Increase modified value to include transition time
    this.modified += Math.round(1 + (duration/1000));
  }

  // Update maxIR value
  if ((this.info.capability & LightCapability.INFRARED) && changedIR) {
    this.lifx.maxIR(this.maxIR);
  }


  // If we only changed infrared max level we don't need to trigger color change
  if (!changedColor && _.isFinite(input.maxIR)) {
    // No color/state change
  }
  // Color change
  else if (isOn == this.state.on) {
    // Fade light to new color
    this.lifx.color(this.state.hue || 0, this.state.saturation || 0, this.state.brightness, this.state.kelvin || 3500, duration);
  }
  // Light off
  else if (!this.state.on) {
    this.lifx.off(duration);
  }
  // Light on
  else {
    // Set color for light and then fade the light on
    this.lifx.color(this.state.hue || 0, this.state.saturation || 0, this.state.brightness, this.state.kelvin || 3500, 0);
    this.lifx.on(duration);
  }

  this.emit('change');

  return newValues;
}


/**
 * Set if light is reachable
 * @param {boolean} state New reachable state
 */
LightItem.prototype.setReachable = function setReachable(state) {
  var self = this;

  // Same state that we already have, ignore
  if (this.info.reachable === state)
    return;

  // Ensure the poll timer is stopped
  if (self.pollTimer)
    clearInterval(self.pollTimer);
  self.pollTimer = null;

  // set reachable
  this.info.reachable = !!state;

  // Not initialized yet
  if (!this.initialized)
    return;

  // start polling for changes
  if (this.info.reachable) {
    this.pollTimer = setInterval(this.pollChanges.bind(this), this.config.pollInterval);
    this.pollChanges();
  }

  self.emit('updated');
}


/**
 * Get node-red message for the current state of the light
 * @return {object} State information
 */
LightItem.prototype.getStateMessage = function getStateMessage() {
  var self = this;
  var hsv;

  // Use color
  if (self.info.capability & LightCapability.COLOR) {
    hsv = [this.state.hue || 0, this.state.saturation || 0, this.state.brightness || 0];
  }
  // Use temperature for color and output it
  else {
    let rgb = colorTemp.temp2rgb(this.state.kelvin||3500);
    hsv = colorSpace.rgb.hsv(rgb);
    hsv[1] = 5;
    hsv[2] = this.state.brightness || 0;
  }

  // Convert to rgb
  let rgb = colorSpace.hsv.rgb(hsv);
  if (!_.isArray(rgb))
    rgb = [0, 0, 0];


  var retVal = {
    id: this.id,

    // Light information
    info: {
      id:      this.info.id,
      name:    this.info.label,
      address: this.info.address,
      model:   this.info.model,
  
      // Conver bitmask to capabilities
      capability: LightCapability.enums.reduce((coll, enumItem) => {
        if (self.info.capability & enumItem)
          coll.push(enumItem.key.toLowerCase());
        return coll;
      }, []),
    },

    // Calculated colors
    payload: {
      on:        this.state.on,
      reachable: this.info.reachable,

      bri:  Math.round(this.state.brightness),

      hsv: [ Math.round(hsv[0]), Math.round(hsv[1]), Math.round(hsv[2]) ],
      rgb: [ Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2]) ],
    
      hex:   colorConvert.rgb.hex(rgb),
      color: colorConvert.rgb.keyword(rgb),

      kelvin: Math.round(this.state.kelvin),
      mired:  Math.round(1000000 / this.state.kelvin),
    },

    // Raw internal state
    state: _.merge({}, this.state)
  }

  // Append maxIR to root node for IR capable lights
  if (self.info.capability & LightCapability.INFRARED) {
    retVal.maxIR = this.info.maxIRLevel;
  }

  return retVal;
}


// Export
module.exports = LightItem;
