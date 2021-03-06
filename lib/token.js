var request = require('./request');
var format = require('util').format;
var debug = require('debug')('mongodb-scope-client:token');
var Model = require('ampersand-model');
var decodeError = require('./decode-error');

var EJSON = require('mongodb-extended-json');

var _cache = {};

var Token = Model.extend({
  idAttribute: 'url',
  props: {
    // The encoded JSON Web Token value.
    token: 'string',
    instance_id: 'string',
    expires_at: 'date',
    created_at: 'date'
  },
  derived: {
    url: {
      deps: ['connection.endpoint'],
      fn: function() {
        return format('%s/api/v1/token', this.connection.endpoint);
      }
    }
  },
  session: {
    connection: 'state'
  },
  close: function(fn) {
    _cache[this.connection.getId()] = null;

    fn = fn || function() {};
    if (!this.token) {
      debug('nothing to close');
      return process.nextTick(fn);
    }
    clearTimeout(this.refreshTimeout);

    if (this.isExpired()) {
      debug('current token is already expired. '
        + 'dont need to send DELETE to server');
      return process.nextTick(fn);
    }

    debug('closing token');
    request.del(this.url)
      .accept('json')
      .set('Authorization', format('Bearer %s', this.toString()))
      .end(function(err, res) {
        debug('response from token close', err, res);
        fn(err, res);
      });
  },
  isExpired: function() {
    return Date.now() >= this.expires_at;
  },
  create: function(done) {
    var payload = this.connection.serialize({
      all: true
    });

    debug('creating...');
    request.post(this.url)
      .send(EJSON.stringify(payload))
      .type('json')
      .accept('json')
      .end(function(err, res) {
        if (err) {
          err = decodeError(err);
        } else {
          // Dumb client-side throttling, but gotta to start somewhere.
          var oneMinute = 1 * 60 * 1000;
          if (new Date(res.body.expires_at) - Date.now() < oneMinute) {
            err = new Error('Got an expires that is less than a minute from now.');
          }
        }

        if (err) {
          debug('Error creating token!', err);
          return done(err);
        }

        this.set(res.body);
        done(null, this);
      }.bind(this));
  },
  listen: function(fn) {
    this.refresh(fn);
  },
  refresh: function(fn) {
    var onError = function(err) {
      if (fn) {
        fn(err);
      } else {
        this.trigger('error', err);
      }
    }.bind(this);

    var onCreated = function(err) {
      if (err) {
        if (err) {
          return onError(err);
        }
      }
      this.scheduleNextRefresh();
      if (fn) {
        fn(null, this);
      }
      this.trigger('refreshed', this);
    }.bind(this);

    this.close(function(err) {
      if (err) {
        return onError(err);
      }

      this.create(onCreated);
    }.bind(this));
  },
  scheduleNextRefresh: function() {
    var ms = this.expires_at - Date.now() - 15 * 1000;
    debug('scheduling next refresh for %dms from now', ms);
    this.refreshTimeout = setTimeout(this.refresh.bind(this), ms);
  }
});

Token.prototype.toString = function() {
  return this.token;
};

module.exports = function(connection, fn) {
  if (!_cache[connection.getId()]) {
    _cache[connection.getId()] = new Token({
      connection: connection
    }).listen(fn);
  } else {
    process.nextTick(function() {
      fn(null, _cache[connection.getId()]);
    });
  }
};
