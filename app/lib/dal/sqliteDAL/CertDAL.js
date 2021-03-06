/**
 * Created by cgeek on 22/08/15.
 */

var Q = require('q');
var co = require('co');
var AbstractSQLite = require('./AbstractSQLite');

module.exports = CertDAL;

function CertDAL(db) {

  "use strict";

  AbstractSQLite.call(this, db);

  let that = this;

  this.table = 'cert';
  this.fields = [
    'linked',
    'written',
    'written_block',
    'written_hash',
    'sig',
    'block_number',
    'block_hash',
    'target',
    'to',
    'from',
    'block'
  ];
  this.arrays = [];
  this.booleans = ['linked', 'written'];
  this.pkFields = ['from','target','sig'];
  this.translated = {};

  this.init = () => co(function *() {
    return that.exec('BEGIN;' +
      'CREATE TABLE IF NOT EXISTS ' + that.table + ' (' +
      '`from` VARCHAR(50) NOT NULL,' +
      '`to` VARCHAR(50) NOT NULL,' +
      'target CHAR(64) NOT NULL,' +
      'sig VARCHAR(100) NOT NULL,' +
      'block_number INTEGER NOT NULL,' +
      'block_hash VARCHAR(64),' +
      'block INTEGER NOT NULL,' +
      'linked BOOLEAN NOT NULL,' +
      'written BOOLEAN NOT NULL,' +
      'written_block INTEGER,' +
      'written_hash VARCHAR(64),' +
      'PRIMARY KEY (`from`, target, sig, written_block)' +
      ');' +
      'CREATE INDEX IF NOT EXISTS idx_cert_from ON cert (`from`);' +
      'CREATE INDEX IF NOT EXISTS idx_cert_target ON cert (target);' +
      'CREATE INDEX IF NOT EXISTS idx_cert_linked ON cert (linked);' +
      'COMMIT;', []);
  });

  this.beforeSaveHook = function(entity) {
    entity.written = entity.written || !!(entity.written_hash);
  };

  this.getToTarget = (hash) => this.sqlFind({
    target: hash
  });

  this.getFromPubkey = (pubkey) => this.sqlFind({
    from: pubkey
  });

  this.getNotLinked = () => this.sqlFind({
    linked: false
  });

  this.getNotLinkedToTarget = (hash) => this.sqlFind({
    target: hash,
    linked: false
  });

  this.listLocalPending = () => Q([]);

  this.saveOfficial = (cert) => {
    cert.linked = true;
    return this.saveEntity(cert);
  };

  this.saveCert = (cert) => this.saveEntity(cert);

  this.saveNewCertification = (cert) => this.saveEntity(cert);

  this.existsGivenCert = (cert) => Q(this.sqlExisting(cert));

  this.updateBatchOfCertifications = (certs) => co(function *() {
    let queries = [];
    let insert = that.getInsertHead();
    let values = certs.map((cert) => that.getInsertValue(cert));
    if (certs.length) {
      queries.push(insert + '\n' + values.join(',\n') + ';');
    }
    if (queries.length) {
      return that.exec(queries.join('\n'));
    }
  });
}