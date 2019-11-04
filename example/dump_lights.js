/* eslint no-console: off */
'use strict';

var Lifx = require('lifx-lan-client').Client;
var client = new Lifx();

client.on('error', function(err) {
  console.log('LIFX error:\n' + err.stack);
  client.destroy();
});

client.on('light-new', function(light) {
  light.getHardwareVersion((err, data) => {
    console.log('getHardwareVersion', light.id, err ? err.message : data);
  });

  light.getMaxIR((err, data) => {
    console.log('getMaxIR', light.id, err ? err.message : data);
  });

  light.getState((err, data) => {
    console.log('getState', light.id, err ? err.message : data);
  })
});


client.on('listening', function() {
  var address = client.address();
  console.log(
    'Started LIFX listening on ' +
    address.address + ':' + address.port + '\n'
  );
});

client.init({
  //broadcast: "192.168.1.255",
  messageHandlerTimeout: 1000,
  //debug: true,
});
