"use strict";

var co = require('co');
var Server = require('./server');
var bma  = require('./app/lib/streams/bma');
var webmin  = require('./app/lib/streams/webmin');
var upnp = require('./app/lib/upnp');
var multicaster = require('./app/lib/streams/multicaster');
var logger = require('./app/lib/logger')('ucoin');

module.exports = function (dbConf, overConf) {
  return new Server(dbConf, overConf);
};

module.exports.statics = {

  startNode: (server, conf) => co(function *() {

    logger.info(">> NODE STARTING");

    /***************
     * HTTP BINDING
     **************/
    yield bma(server, null, conf.httplogs);

    /***************
     * HTTP ROUTING
     **************/
    if (server.conf.routing) {
      server
      // The router asks for multicasting of documents
        .pipe(server.router())
        // The documents get sent to peers
        .pipe(multicaster(server.conf.isolate))
        // The multicaster may answer 'unreachable peer'
        .pipe(server.router());
    }

    /***************
     *    UPnP
     **************/
    if (conf.upnp) {
      yield upnp(server.conf.port, server.conf.remoteport)
        .catch(function(err){
          logger.warn(err);
        });
    }

    /*******************
     * BLOCK COMPUTING
     ******************/
    if (conf.participate) {
      server.startBlockComputation();
    }

    /***********************
     * CRYPTO NETWORK LAYER
     **********************/
    server.start();

    logger.info('>> Server ready!');
  })
};
