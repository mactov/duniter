var should   = require('should');
var assert   = require('assert');
var request  = require('supertest');
var async    = require('async');
var mongoose = require('mongoose');
var fs       = require('fs');
var sha1     = require('sha1');
var _        = require('underscore');

module.exports = {}

module.exports.HTTPTestCase = function (label, params) {
  
  var that = this;

  // Test label
  this.label = label;

  // Task to be launched
  this.task = function (next) {
    params.task(function (err, res) {

      // Test function
      that.test = _.partial(params.test, res);
      next();
    });
  };
  return this;
}

module.exports.tester = function (currency) {

  var app;

  this.create = function (params) {
    return new module.exports.HTTPTestCase(params.label, {
      task: params.task,
      test: params.test
    });
  };

  this.verify = function (label, task, test) {
    return new module.exports.HTTPTestCase(label, {
      task: task,
      test: test
    });
  };

  this.delay = function (delayInMilliseconds) {
    return new module.exports.HTTPTestCase('Waiting ' + delayInMilliseconds + 'ms', {
      task: function (done) {
        console.log('Waiting ' + delayInMilliseconds + 'ms..');
        setTimeout(done, delayInMilliseconds);
      },
      test: function () {
        (true).should.be.ok;
      }
    });
  };

  /**
  * Test that HTTP response code matches given HTTP code.
  **/
  this.expectedHTTPCode = function (code) {
    return function (res) {
      should.exist(res.statusCode);
      res.statusCode.should.equal(code);
    };
  };

  /**
  * Test that given result is a merkle tree matching given root value.
  * @param root The root value of Merkle tree.
  * @param leavesCount The l
  **/
  this.expectedMerkle = function (root, leavesCount) {
    return successToJson(function (json) {
      expectedMerkle(json, root, leavesCount);
    });
  };

  /**
  * Test that given result is a public key matching given fingerprint.
  **/
  this.expectedPubkey = function (fingerprint) {
    return successToJson(function (json) {
      isPubKey(json);
      json.key.fingerprint.should.equal(fingerprint);
    });
  };

  /**
  * Test that given result is a public key matching given fingerprint.
  **/
  this.expectedMembership = function (fingerprint) {
    return successToJson(function (json) {
      isMembership(json);
      json.membership.issuer.should.equal(fingerprint);
    });
  };

  /**
  * Test that given result is a public key matching given fingerprint.
  **/
  this.expectedAmendment = function (properties) {
    return successToJson(function (json) {
      isAmendment(json);
      _(properties).keys().forEach(function(key){
        json.should.have.property(key);
        if (properties[key] != null) 
          json[key].should.equal(properties[key]);
        else
          should.not.exist(json[key]);
      });
    });
  };

  this.doGet = function (url) {
    return function (next) {
      get(url, next);
    };
  };

  this.pksAdd = function (keytext, keysign) {
    return function (done) {
      post('/pks/add', {
        "keytext": keytext,
        "keysign": keysign
      }, done);
    };
  };

  this.join = function (signatory) {
    var Membership = mongoose.model('Membership');
    return function (done) {
      var ms = new Membership({ version: 1, currency: currency, issuer: signatory.fingerprint(), membership: 'JOIN' });
      var raw = ms.getRaw();
      var sig = signatory.sign(raw);
      post ('/ucs/community/members', {
        'membership': raw,
        'signature': sig
      }, done);
    };
  };

  this.actualize = function (signatory) {
    var Membership = mongoose.model('Membership');
    return function (done) {
      var ms = new Membership({ version: 1, currency: currency, issuer: signatory.fingerprint(), membership: 'ACTUALIZE' });
      var raw = ms.getRaw();
      var sig = signatory.sign(raw);
      post ('/ucs/community/members', {
        'membership': raw,
        'signature': sig
      }, done);
    };
  };

  this.leave = function (signatory) {
    var Membership = mongoose.model('Membership');
    return function (done) {
      var ms = new Membership({ version: 1, currency: currency, issuer: signatory.fingerprint(), membership: 'LEAVE' });
      var raw = ms.getRaw();
      var sig = signatory.sign(raw);
      post ('/ucs/community/members', {
        'membership': raw,
        'signature': sig
      }, done);
    };
  };

  this.app = function (appToSet) {
    app = appToSet;
  };

  function successToJson (subTest) {
    return function (res) {
      should.exist(res.statusCode);
      res.statusCode.should.equal(200);
      should.exist(res.text);
      // jsoning
      var json = null;
      try {
        json = JSON.parse(res.text);
      } catch(ex) {
      }
      should.exist(json);
      subTest(json);
    };
  }

  function get (url, done) {
    request(app)
      .get(url)
      .end(done);
  }

  function post (url, data, done) {
    request(app)
      .post(url)
      .send(data)
      .end(done);
  }

  return this;
};

function expectedMerkle (json, root, leavesCount) {
  isMerkleSimpleResult(json);
  json.root.should.equal(root);
}

function isMerkleSimpleResult (json) {
  isMerkleResult(json);
  json.should.not.have.property('leaf');
  json.should.not.have.property('leaves');
}

function isMerkleLeafResult (json) {
  isMerkleResult(json);
  json.should.have.property('leaf');
  json.should.not.have.property('leaves');
}

function isMerkleLeavesResult (json) {
  isMerkleResult(json);
  json.should.have.property('leaves');
  json.should.not.have.property('leaf');
  _(json.leaves).each(function (leaf) {
    leaf.should.have.property('hash');
    leaf.should.have.property('value');
  });
}

function isMerkleResult (json) {
  json.should.have.property('depth');
  json.should.have.property('nodesCount');
  json.should.have.property('leavesCount');
  json.should.have.property('root');
}

function isPubKey (json) {
  json.should.have.property('signature');
  json.should.have.property('key');
  json.key.should.have.property('email');
  json.key.should.have.property('name');
  json.key.should.have.property('fingerprint');
  json.key.should.have.property('raw');
  json.key.should.not.have.property('_id');
  json.key.raw.should.not.match(/-----/g);
}

function isMembership (json) {
  json.should.have.property('signature');
  json.should.have.property('membership');
  json.membership.should.have.property('version');
  json.membership.should.have.property('currency');
  json.membership.should.have.property('issuer');
  json.membership.should.have.property('membership');
  json.membership.should.have.property('sigDate');
  json.membership.should.have.property('raw');
  json.membership.should.not.have.property('_id');
  json.membership.raw.should.not.match(/-----/g);
}

function isAmendment (json) {
  var mandatories = [
    "version",
    "currency",
    "generated",
    "number",
    "votersRoot",
    "votersCount",
    "votersChanges",
    "membersRoot",
    "membersCount",
    "membersChanges",
    "raw"
  ];
  json.should.have.properties(mandatories);
  mandatories.forEach(function(prop){
    should.exist(json[prop]);
  });
  var optional = [
    "dividend",
    "coinMinPower",
    "previousHash"
  ];
  json.should.have.properties(optional);
  if (json.number > 0) {
    json.should.have.property('previousHash');
  }
  // Numbers
  json.version.should.be.a.Number.and.not.be.below(1);
  json.generated.should.be.a.Number.and.not.be.below(0);
  json.number.should.be.a.Number.and.not.be.below(0);
  if (json.dividend) {
    json.dividend.should.be.a.Number.and.be.above(0);
  }
  if (json.coinMinimalPower) {
    json.coinMinimalPower.should.be.a.Number.and.be.above(0);
  }
  json.membersCount.should.be.a.Number.and.not.be.below(0);
  json.votersCount.should.be.a.Number.and.not.be.below(0);
  // Strings
  json.currency.should.be.a.String.and.not.be.empty;
  if (json.previousHash) {
    json.previousHash.should.be.a.String.and.match(/^[A-Z0-9]{40}$/);
  }
  if (json.membersCount > 0) {
    json.membersRoot.should.be.a.String.and.match(/^[A-Z0-9]{40}$/);
  } else {
    json.membersRoot.should.be.a.String.and.be.empty;
  }
  if (json.votersCount > 0) {
    json.votersRoot.should.be.a.String.and.match(/^[A-Z0-9]{40}$/);
  } else {
    json.votersRoot.should.be.a.String.and.be.empty;
  }
  json.membersChanges.should.be.an.Array;
  json.membersChanges.forEach(function(change){
    change.should.match(/^(\+|-)[A-Z0-9]{40}$/);
  });
  json.votersChanges.should.be.an.Array;
  json.votersChanges.forEach(function(change){
    change.should.match(/^(\+|-)[A-Z0-9]{40}$/);
  });
}
