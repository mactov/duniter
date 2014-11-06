var async  = require('async');
var _      = require('underscore');
var crypto = require('../lib/crypto');
var logger = require('../lib/logger')('pubkey');

module.exports.get = function (conn, conf) {
  return new IdentityService(conn, conf);
};

function IdentityService (conn, conf) {

  var Identity      = conn.model('Identity');
  var Certification = conn.model('Certification');
  
  var fifo = async.queue(function (task, callback) {
    task(callback);
  }, 1);

  var that = this;

  // Reference to BlockchainService
  var BlockchainService = null;

  this.search = function(search, done) {
    var identities = [];
    async.waterfall([
      function (next){
        Identity.search(search, next);
      },
    ], done);
  };

  this.setBlockchainService = function (service) {
    BlockchainService = service;
  };

  /**
  * Tries to persist a public key given in ASCII-armored format.
  * Returns the database stored public key.
  */
  this.submitIdentity = function(obj, done) {
    var idty = new Identity(obj);
    var selfCert = idty.selfCert();
    var certs = idty.othersCerts();
    fifo.push(function (cb) {
      async.waterfall([
        function (next){
          // Check signature's validity
          crypto.verifyCbErr(selfCert, idty.sig, idty.pubkey, next);
        },
        function (next) {
          async.forEachSeries(certs, function(cert, cb){
            if (cert.from == idty.pubkey)
              cb('Rejected certification: certifying its own self-certification has no meaning');
            else
              crypto.isValidCertification(selfCert, idty.sig, cert.from, cert.sig, cert.time.timestamp(), cb);
          }, next);
        },
        function (next){
          async.forEachSeries(certs, function(cert, cb){
            var mCert = new Certification({ pubkey: cert.from, sig: cert.sig, time: cert.time, target: obj.hash, to: idty.pubkey });
            async.waterfall([
              function (next){
                mCert.existing(next);
              },
              function (existing, next){
                if (existing) next();
                else mCert.save(function (err) {
                  next(err);
                });
              },
            ], cb);
          }, next);
        },
        function (next){
          Identity.getByHash(obj.hash, next);
        },
        function (existing, next){
          if (existing)
            next(null, existing);
          else {
            BlockchainService.stopPoWThenProcessAndRestartPoW(function (saved) {
              // Create
              idty.save(function (err) {
                saved(err, idty);
              });
            }, function (err) {
              next(err, idty);
            });
          }
        },
      ], cb);
    }, done);
  };
}