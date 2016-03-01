"use strict";
var stream      = require('stream');
var async       = require('async');
var util        = require('util');
var co          = require('co');
var _           = require('underscore');
var Q           = require('q');
var parsers     = require('./app/lib/streams/parsers/doc');
var constants   = require('./app/lib/constants');
var fileDAL     = require('./app/lib/dal/fileDAL');
var jsonpckg    = require('./package.json');
var router      = require('./app/lib/streams/router');
var base58      = require('./app/lib/base58');
var crypto      = require('./app/lib/crypto');
var signature   = require('./app/lib/signature');
var directory   = require('./app/lib/directory');
var dos2unix    = require('./app/lib/dos2unix');

function Server (dbConf, overrideConf) {

  stream.Duplex.call(this, { objectMode: true });

  let home = directory.getHome(dbConf.name, dbConf.home);
  var logger = require('./app/lib/logger')('server');
  var that = this;
  var connectionPromise, servicesPromise;
  that.conf = null;
  that.dal = null;
  that.version = jsonpckg.version;

  var documentsMapping = {};

  // Unused, but made mandatory by Duplex interface
  this._read = () => null;

  this._write = (obj, enc, writeDone) => that.submit(obj, false, () => writeDone);

  this.connectDB = function (useDefaultConf) {
    // Connect only once
    return connectionPromise || (connectionPromise = that.connect(useDefaultConf));
  };

  this.initWithServices = function (done) {
    // Init services only once
    return servicesPromise || (servicesPromise = that.connectDB()
        .then(() => that.initDAL())
        .then(that.initServices)
        .then(function(err) {
          done && done(err);
          return that;
        })
        .catch(done));
  };

  this.submit = function (obj, isInnerWrite, done) {
    return co(function *() {
      if (!obj.documentType) {
        throw 'Document type not given';
      }
      try {
        let action = documentsMapping[obj.documentType];
        let res;
        if (typeof action == 'function') {
          // Handle the incoming object
          res = yield action(obj);
        } else {
          throw 'Unknown document type \'' + obj.documentType + '\'';
        }
        if (res) {
          // Only emit valid documents
          that.emit(obj.documentType, _.clone(res));
          that.push(_.clone(res));
        }
        if (done) {
          isInnerWrite ? done(null, res) : done();
        }
        return res;
      } catch (err) {
        logger.debug(err);
        if (done) {
          isInnerWrite ? done(err, null) : done();
        } else {
          throw err;
        }
      }
    });
  };

  this.submitP = (obj, isInnerWrite) => Q.nbind(this.submit, this)(obj, isInnerWrite);

  this.connect = (useDefaultConf) => co(function *() {
    if (!that.dal) {
      // Init connection
      var dbType = dbConf && dbConf.memory ? fileDAL.memory : fileDAL.file;
      that.dal = yield dbType(home);
      that.conf = yield that.dal.loadConf(overrideConf, useDefaultConf);
      // Default values
      var defaultValues = {
        remoteipv6:         that.conf.ipv6,
        remoteport:         that.conf.port,
        cpu:                1,
        c:                  constants.CONTRACT.DEFAULT.C,
        dt:                 constants.CONTRACT.DEFAULT.DT,
        ud0:                constants.CONTRACT.DEFAULT.UD0,
        stepMax:            constants.CONTRACT.DEFAULT.STEPMAX,
        sigPeriod:          constants.CONTRACT.DEFAULT.SIGPERIOD,
        sigStock:           constants.CONTRACT.DEFAULT.SIGSTOCK,
        sigWindow:          constants.CONTRACT.DEFAULT.SIGWINDOW,
        sigValidity:        constants.CONTRACT.DEFAULT.SIGVALIDITY,
        msValidity:         constants.CONTRACT.DEFAULT.MSVALIDITY,
        sigQty:             constants.CONTRACT.DEFAULT.SIGQTY,
        xpercent:           constants.CONTRACT.DEFAULT.X_PERCENT,
        percentRot:         constants.CONTRACT.DEFAULT.PERCENTROT,
        blocksRot:          constants.CONTRACT.DEFAULT.BLOCKSROT,
        powDelay:           constants.CONTRACT.DEFAULT.POWDELAY,
        avgGenTime:         constants.CONTRACT.DEFAULT.AVGGENTIME,
        dtDiffEval:         constants.CONTRACT.DEFAULT.DTDIFFEVAL,
        medianTimeBlocks:   constants.CONTRACT.DEFAULT.MEDIANTIMEBLOCKS,
        rootoffset:         0,
        forksize:           constants.BRANCHES.DEFAULT_WINDOW_SIZE
      };
      _.keys(defaultValues).forEach(function(key){
        if (that.conf[key] == undefined) {
          that.conf[key] = defaultValues[key];
        }
      });
    }
    return that.conf;
  });

  this.initDAL = () => this.dal.init();

  this.start = function () {
    return that.checkConfig()
      .then(function (){
        // Add signing & public key functions to PeeringService
        logger.info('Node version: ' + that.version);
        logger.info('Node pubkey: ' + that.PeeringService.pubkey);
        return Q.nfcall(that.initPeer);
      });
  };

  this.recomputeSelfPeer = function() {
    return Q.nbind(that.PeeringService.generateSelfPeer, that.PeeringService)(that.conf, 0);
  };

  this.initPeer = function (done) {
    async.waterfall([
      function (next){
        that.checkConfig().then(next).catch(next);
      },
      function (next){
        that.PeeringService.regularCrawlPeers(next);
      },
      function (next){
        logger.info('Storing self peer...');
        that.PeeringService.regularPeerSignal(next);
      },
      function(next) {
        that.PeeringService.regularTestPeers(next);
      },
      function (next){
        that.PeeringService.regularSyncBlock(next);
      },
      function (next){
        that.BlockchainService.regularCleanMemory(next);
      }
    ], done);
  };

  let shouldContinue = true;

  this.stopBlockComputation = function() {
    shouldContinue = false;
  };

  this.startBlockComputation = function() {
    return co(function *() {
      while (shouldContinue) {
        try {
          let block = yield that.BlockchainService.startGeneration();
          if (block && shouldContinue) {
            try {
              let obj = parsers.parseBlock.syncWrite(dos2unix(block.getRawSigned()));
              yield that.singleWritePromise(obj);
            } catch (err) {
              logger.warn('Proof-of-work self-submission: %s', err.message || err);
            }
          }
        }
        catch (e) {
          logger.error(e);
          shouldContinue = true;
        }
      }
    });
  };

  this.checkConfig = function () {
    return that.checkPeeringConf(that.conf);
  };

  this.checkPeeringConf = function (conf) {
    return Q()
      .then(function(){
        if (!conf.pair && conf.passwd == null) {
          throw new Error('No key password was given.');
        }
        if (!conf.pair && conf.salt == null) {
          throw new Error('No key salt was given.');
        }
        if (!conf.currency) {
          throw new Error('No currency name was given.');
        }
        if(!conf.ipv4 && !conf.ipv6){
          throw new Error("No interface to listen to.");
        }
        if(!conf.remoteipv4 && !conf.remoteipv6 && !conf.remotehost){
          throw new Error('No interface for remote contact.');
        }
        if (!conf.remoteport) {
          throw new Error('No port for remote contact.');
        }
      });
  };

  this.reset = function(done) {
    return that.dal.resetAll(done);
  };

  this.resetData = function(done) {
    return that.dal.resetData(done);
  };

  this.resetStats = function(done) {
    return that.dal.resetStats(done);
  };

  this.resetPeers = function(done) {
    return that.dal.resetPeers(done);
  };

  this.resetTxs = function(done) {
    that.dal.resetTransactions(done);
  };

  this.resetConf = function(done) {
    return that.dal.resetConf(done);
  };

  this.disconnect = function() {
    return that.dal && that.dal.close();
  };

  this.initServices = () => co(function *() {
    if (!that.servicesInited) {
      // Extract key pair
      let pair = null;
      if (that.conf.pair) {
        pair = {
          publicKey: base58.decode(that.conf.pair.pub),
          secretKey: base58.decode(that.conf.pair.sec)
        };
      }
      else if (that.conf.passwd || that.conf.salt) {
        pair = yield Q.nbind(crypto.getKeyPair, crypto)(that.conf.passwd, that.conf.salt);
      }
      if (!pair) {
        throw 'This node does not have a keypair. Use `ucoind wizard key` to fix this.';
      }
      that.pair = pair;
      that.sign = signature.asyncSig(pair);
      that.servicesInited = true;
      // TODO: migrer en début de code + utiliser les setConf et setDAL pour changer ces 2 paramètres
      that.MerkleService       = require("./app/service/MerkleService");
      that.ParametersService   = require("./app/service/ParametersService")();
      that.IdentityService     = require('./app/service/IdentityService')(that.conf, that.dal);
      that.MembershipService   = require('./app/service/MembershipService')(that.conf, that.dal);
      that.PeeringService      = require('./app/service/PeeringService')(that, that.pair, that.dal);
      that.BlockchainService   = require('./app/service/BlockchainService')(that.conf, that.dal, that.pair);
      that.TransactionsService = require('./app/service/TransactionsService')(that.conf, that.dal);
      // Create document mapping
      documentsMapping = {
        'identity':    that.IdentityService.submitIdentity,
        'certification': that.IdentityService.submitCertification,
        'revocation':  that.IdentityService.submitRevocation,
        'membership':  that.MembershipService.submitMembership,
        'peer':        that.PeeringService.submitP,
        'transaction': that.TransactionsService.processTx,
        'block':       _.partial(that.BlockchainService.submitBlock, _, true)
      };
    }
  });

  this.makeNextBlock = function(manualValues) {
    return co(function *() {
      yield that.initWithServices();
      let proven = yield that.BlockchainService.makeNextBlock(null, null, null, manualValues);
      return proven;
    });
  };

  this.checkBlock = function(block) {
    return that.initWithServices()
      .then(function(){
        var parsed = parsers.parseBlock.syncWrite(block.getRawSigned());
        return that.BlockchainService.checkBlock(parsed, false);
      });
  };

  this.revert = () => this.BlockchainService.revertCurrentBlock();

  this.revertTo = (number) => co(function *() {
    let current = yield that.BlockchainService.current();
    for (let i = 0, count = current.number - number; i < count; i++) {
      yield that.BlockchainService.revertCurrentBlock();
    }
    if (current.number <= number) {
      logger.warn('Already reached');
    }
    that.BlockchainService.revertCurrentBlock();
  });

  this.singleWritePromise = (obj) => that.submit(obj);

  var theRouter;

  this.router = function() {
    if (!theRouter) {
      theRouter = router(that.PeeringService.pubkey, that.conf, that.dal);
    }
    return theRouter;
  };

}

util.inherits(Server, stream.Duplex);

module.exports = Server;
