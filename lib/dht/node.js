var dgram = require('dgram'),
    crypto = require('crypto'),
    util = require('util'),
    Buffer = require('buffer').Buffer,
    EventEmitter = require('events').EventEmitter;

var dht = require('../dht'),
    bencode = dht.bencode,
    utils = dht.utils;

function Node(port) {
  var self = this;
  EventEmitter.call(this);

  this.address = null;
  this.port = port;

  this.socket = dgram.createSocket('udp4');
  this.socket.on('message', this.onmessage.bind(this));
  this.socket.once('listening', function() {
    self.port = self.socket.address().port;
    self.address = self.socket.address().address;

    process.nextTick(function() {
      self.emit('listening');
    });
  });
  this.socket.bind(port);

  this.id = new Buffer(
    crypto.createHash('sha1').update(crypto.randomBytes(20)).digest('hex'),
    'hex'
  );

  this.queries = {};
  this.timeouts = {
    response: 5000, // 5 seconds
    peer: 60 * 60 * 1000 // 1 hour
  };

  this.K = 8;
  this.buckets = [new Bucket(this)];

  // Information about peers
  this.peers = {};
};
util.inherits(Node, EventEmitter);

exports.create = function create(port) {
  return new Node(port || 0);
};

Node.prototype.close = function close() {
  this.socket.close();
};

Node.prototype.request = function request(target, type, args, callback) {
  var self = this,
      id = new Buffer([~~(Math.random() * 256), ~~(Math.random() * 256)]),
      msg = {
        t: id,
        y: 'q',
        q: type,
        a: args
      },
      packet = bencode.encode(msg);

  this.socket.send(packet, 0, packet.length, target.port, target.address);

  var key = id.toString('hex'),
      query = {
        callback: callback,
        timeout: setTimeout(function() {
          callback(new Error('Timed out'));
          if (self.queries[key] !== query) return;

          delete self.queries[key];
        }, this.timeouts.response)
      };

  this.queries[key] = query;
};

Node.prototype.respond = function respond(target, msg, args) {
  args.id = this.id;

  var response = {
        t: msg.t,
        y: 'r',
        r: args
      },
      packet = bencode.encode(response);

  this.socket.send(packet, 0, packet.length, target.port, target.address);
};

Node.prototype.onmessage = function onmessage(packet, rinfo) {
  try {
    var msg = bencode.decode(packet);

    // Process response
    if (msg.y && msg.y.length === 1 && msg.y[0] === 0x72 /* r */) {
      var id = msg.t.toString('hex');

      // Invoke callback if we have sent request with the same id
      if (this.queries.hasOwnProperty(id)) {
        var query = this.queries[id];
        clearTimeout(query.timeout);
        query.callback(null, msg.r, rinfo);
        delete this.queries[id];
      }
      return;
    }

    // Process requests
    this.processRequest(msg.q.toString(), msg, rinfo);

  } catch (e) {
    this.emit('error', e);
  }
};

Node.prototype.processRequest = function processRequest(type, msg, rinfo) {
  if (!msg.a) return;

  var id = msg.a.id;

  // Ignore malformed data
  if (!id || !Buffer.isBuffer(id) || id.length !== 20) return;

  while (true) {
    var bucket = this.buckets.filter(function(bucket) {
      return bucket.contains(id);
    })[0];

    // Add node to bucket
    if (bucket.add(id, rinfo)) break;

    // Non-main bucket can't be split
    if (!bucket.contains(this.id)) break;

    // Bucket is full - split it and try again
    this.buckets.splice(this.buckets.indexOf(bucket), 1, bucket.split());
  }

  if (type === 'ping') {
    this.processPing(msg, rinfo);
  } else if (type === 'find_node') {
    this.processFindNode(msg, rinfo);
  } else if (type === 'get_peers') {
    this.processGetPeers(msg, rinfo);
  } else if (type === 'announce_peer') {
    this.processAnnouncePeer(msg, rinfo);
  } else {
    // Ignore
  }
};

Node.prototype.sendPing = function sendPing(target, callback) {
  this.request(target, 'ping', { id: this.id }, callback);
};

Node.prototype.sendFindNode = function sendFindNode(target, id, callback) {
  this.request(target, 'find_node', { id: this.id, target: id }, callback);
};

Node.prototype.sendGetPeers = function sendGetPeers(target, id, callback) {
  this.request(target, 'get_peers', { id: this.id, info_hash: id }, callback);
};

Node.prototype.sendAnnouncePeer = function sendAnnouncePeer(target,
                                                            token,
                                                            peer,
                                                            callback)  {
  var self = this;

  // UDP Port is required. Wait for socket to bound if it isn't.
  if (this.port === 0) {
    this.once('listening', function() {
      send();
    });
  } else {
    send();
  }

  function send() {
    self.request(target, 'announce_peer', {
      id: self.id,
      info_hash: id,
      token: token,
      port: self.port
    }, callback);
  }
};

Node.prototype.processPing = function processPing(msg, rinfo) {
  this.respond(rinfo, msg, { });
};

Node.prototype.processFindNode = function processFindNode(msg, rinfo) {
  this.respond(rinfo, msg, {
    nodes: utils.encodeNodes(this.findKClosest(msg.a.id))
  });
};

Node.prototype.processGetPeers = function processGetPeers(msg, rinfo) {
  if (!msg.a.info_hash ||
      !Buffer.isBuffer(msg.a.info_hash) ||
      msg.a.info_hash.length !== 20) {
    return;
  }

  var infohash = msg.a.info_hash.toString('hex'),
      token = this.issueToken();

  if (!this.peers.hasOwnProperty(infohash)) {
    this.respond(rinfo, msg, {
      token: token,
      nodes: utils.encodeNodes(this.findKClosest(msg.a.info_hash))
    });
    return;
  }

  this.respond(rinfo, msg, {
    token: token,
    values: utils.encodePeers(this.peers[infohash])
  });
};

Node.prototype.processAnnouncePeer = function processAnnouncePeer(msg, rinfo) {
  if (!msg.a.token ||
      !Buffer.isBuffer(msg.a.token) ||
      !this.verifyToken(msg.a.token) ||
      !msg.a.info_hash ||
      !Buffer.isBuffer(msg.a.info_hash) ||
      msg.a.info_hash.length !== 20) {
    return;
  }

  var self = this,
      infohash = msg.a.info_hash.toString('hex'),
      peers = this.peers[infohash],
      address = rinfo.address,
      port = typeof msg.a.port === 'number' ? msg.a.port : rinfo.port,
      existing;

  peers.some(function(peer) {
    if (peer.address !== address || peer.port !== peer.port) return false;
    existing = peer;
    return true;
  });

  if (existing) {
    existing.renew();
  } else {
    var peer = {
      address: address,
      port: port,
      renew: function() {
        if (peer.timeout) clearTimeout(peer.timeout);
        peer.timeout = setTimeout(function() {
          peer.timeout = null;

          var index = peers.indexOf(peer);
          if (index === -1) return;

          peers.splice(index, 1);
          self.emit('peer:delete', infohash, peer);
        }, self.timeouts.peer);
      },
      timeout: null
    };

    peer.renew();

    this.peers[infohash].push(peer);
    this.emit('peer:new', infohash, peer);
  }
  this.respond(rinfo, msg, {});
};

Node.prototype.findNodes = function findNodes(id, callback) {

};

Node.prototype.findPeers = function findPeers(infohash, callback) {

};

Node.prototype.findKClosest = function findKClosest(id) {
  var bucket = this.buckets.filter(function(bucket) {
    return bucket.contains(id);
  })[0];

  var nodes = bucket.getNodes();

  // If not enough results
  if (nodes.length < this.K) {
    var index = this.buckets.indexOf(bucket);

    // Include neighbors
    if (index - 1 >= 0) {
      nodes = nodes.concat(this.buckets[index - 1].getNodes());
    }
    if (index + 1 < this.buckets.length) {
      nodes = nodes.concat(this.buckets[index + 1].getNodes());
    }
  }

  // Limit number of nodes
  nodes = nodes.slice(0, this.K);

  return nodes;
};

Node.prototype.issueToken = function issueToken() {
  // XXX: Issue real token
  return new Buffer(4);
};

Node.prototype.verifyToken = function verifyToken(token) {
  // XXX: Verify token
  return true;
};

function Bucket(node, start, end) {
  this.node = node;

  if (start && end) {
    this.start = start;
    this.end = end;
    this.first = false;
  } else {
    this.start = new Buffer(20);
    this.end = new Buffer(20);
    this.first = true;

    for (var i = 0; i < this.start.length; i += 2) {
      this.start.writeUInt16BE(0, i);
      this.end.writeUInt16BE(0xffff, i);
    }
  }

  this.timeouts = {
    renew: 15 * 60 * 1000 // 15 minutes
  };
  this.timeout = null;
  this.nodes = {};
  this.slots = node.K;

  this.renew();
};

Bucket.prototype.close = function close() {
  // Do not renew anymore
  this.timeout = false;
};

Bucket.prototype.renew = function renew() {
  var self = this,
      id = new Buffer(this.start.length);

  // Pick random id
  for (var i = 0; i < id.length; i += 2) {
    var sword = this.start.readUInt16BE(i),
        eword = this.end.readUInt16BE(i);

    if (sword !== eword) {
      id.writeUInt16BE(~~(sword + Math.random() * (eword - sword)), i);
      break;
    } else {
      id.writeUInt16BE(sword, i);
    }
  }
  crypto.randomBytes(id.length - i).copy(id, i);

  // And perform query
  this.node.findNodes(id, function() {
    if (self.timeout === false) return;
    self.timeout = setTimeout(function() {
      self.renew();
    }, this.timeouts.renew);
  });
};

Bucket.prototype.getNodes = function getNodes() {
  var nodes = this.nodes;

  return Object.keys(nodes).map(function(id) {
    return nodes[id];
  });
};

Bucket.compare = function compare(a, b) {
  for (var i = 0; i < a.length; i += 2) {
    var aword = a.readUInt16BE(i),
        bword = b.readUInt16BE(i);

    if (aword === bword) continue;

    return aword > bword ? 1 : -1;
  }

  return 0;
};

Bucket.prototype.contains = function contains(id) {
  return Bucket.compare(this.start, id) <= 0 &&
         Bucket.compare(id, this.end) <= 0;
};

Bucket.prototype.get = function get(id) {
  if (!this.nodes.hasOwnProperty(id)) return false;

  return this.nodes[id];
};

Bucket.prototype.add = function add(id, target) {
  var self = this;

  // If all slots are busy
  if (this.slots === 0) {
    // Evict bad old nodes
    var bad = Object.keys(this.nodes).filter(function(key) {
      return !this.nodes[key].good;
    }, this).sort(function(a, b) {
      return self.nodes[a].lastSeen - self.nodes[b].lastSeen;
    });

    // No bad nodes - fail
    if (bad.length === 0) return false;

    // Remove one node and continue
    this.remove(bad[0]);
  }

  var remote = target instanceof RemoteNode ?
                  target : new RemoteNode(this.node, id, target);

  this.nodes[remote.id] = remote;
  this.slots--;

  return true;
};

Bucket.prototype.remove = function remove(id) {
  if (!this.nodes.hasOwnProperty(id)) return;

  this.nodes[id].close();
  delete this.nodes[id];
  this.slots++;
};

Bucket.prototype.split = function split() {
  var rpos = new Buffer(this.end.length),
      lpos = new Buffer(this.end.length),
      overR = 1,
      overL = 1;

  // Big-small numbers :)
  for (var i = this.end.length - 2; i >= 0; i -= 2) {
    var word = this.end.readUInt16BE(i) + overR;

    overR = word & 0x10000;
    if (i !== 0) {
      word ^= overR;
      overR = overR >> 16;
    } else {
      overR = 0;
    }

    word = (word + this.start.readUInt16BE(i)) >> 1;
    rpos.writeUInt16BE(word, i);

    if (overL != 0){
      if (word - overL >= 0) {
        word -= overL;
        overL = 0;
      } else {
        word = 0xFFFF;
        overL = 1;
      }
    }

    lpos.writeUInt16BE(word, i);
  }

  var head = new Bucket(this.node, this.start, lpos),
      tail = new Bucket(this.node, rpos, this.end);

  // Relocate all nodes from this bucket into head and tail
  Object.keys(this.nodes).forEach(function(id) {
    if (head.contains(id)) {
      head.add(id, this.nodes[id]);
    } else {
      tail.add(id, this.nodes[id]);
    }
  }, this);

  this.close();

  return [head, tail];
};

// Node to store in a bucket
function RemoteNode(node, id, target) {
  this.node = node;
  this.id = id;
  this.address = target.address;
  this.port = target.port;

  this.firstSeen = +new Date;
  this.lastSeen = +new Date;

  this.timeouts = { ping : 15 * 60 * 1000 /* 15 minutes */ };
  this.timeout = null;
  this.good = true;
  this.bads = 0;

  this.schedulePing();
};

RemoteNode.prototype.close = function close() {
  if (this.timeout) {
    clearTimeout(this.timeout);
    this.timeout = null;
  }
}

RemoteNode.prototype.thank = function thank() {
  this.bads = 0;
  this.good = true;
  this.lastSeen = +new Date;
};

RemoteNode.prototype.curse = function curse() {
  this.bads++;
  if (this.bads > 2) {
    this.good = false;
  }
};

RemoteNode.prototype.schedulePing = function schedulePing() {
  var self = this;

  this.timeout = setTimeout(function() {
    self.ping(function() {
      self.schedulePing();
    });
  }, this.timeouts.ping);
};

RemoteNode.prototype._wrapCallback = function wrapCallback(callback) {
  var self = this;

  return function(err, data, rinfo) {
    if (err) {
      self.curse();
    } else {
      self.thank();
    }

    callback(err, data, rinfo);
  };
};

RemoteNode.prototype.ping = function ping(callback) {
  this.node.sendPing(this, this._wrapCallback(callback));
};

RemoteNode.prototype.findNode = function findNode(id, callback) {
  this.node.sendFindNode(this, id, this._wrapCallback(callback));
};

RemoteNode.prototype.getPeers = function getPeers(id, callback) {
  this.node.sendGetPeers(this, id, this._wrapCallback(callback));
};

RemoteNode.prototype.announcePeer = function announcePeer(token,
                                                          peer,
                                                          callback)  {
  this.node.sendAnnouncePeer(this, token, peer, this._wrapCallback(callback));
};