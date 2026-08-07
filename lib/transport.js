'use strict';

const net = require('net');

const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5000;
const MAX_QUEUE = 1000;

/**
 * Resilient TCP ND-JSON sender.
 *
 * - Lazy connect on first send.
 * - Buffers lines while (re)connecting; drops (and counts) on overflow.
 * - Reconnects with exponential backoff (250ms .. 5s).
 * - Never throws into application code.
 * - unref()s the socket and timers so the agent never keeps the process alive.
 */
class Transport {
  constructor(config) {
    this.host = config.host;
    this.port = config.port;
    this.debug = !!config.debug;
    this.ingestKey = config.ingestKey || '';
    this.authSent = false;
    this.queue = [];
    this.maxQueue = MAX_QUEUE;
    this.dropped = 0;
    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.backoff = INITIAL_BACKOFF_MS;
    this.reconnectTimer = null;
    this.closed = false;
  }

  _log() {
    if (!this.debug) return;
    try {
      const args = Array.prototype.slice.call(arguments);
      args.unshift('[opa-node transport]');
      console.error.apply(console, args);
    } catch (e) { /* ignore */ }
  }

  /**
   * Queue one span object (or pre-serialized string) as a single ND-JSON line.
   */
  send(span) {
    try {
      if (this.closed) return;
      const line = (typeof span === 'string' ? span : JSON.stringify(span)) + '\n';
      if (this.queue.length >= this.maxQueue) {
        this.dropped++;
        return;
      }
      this.queue.push(line);
      this._ensureConnection();
      this._flushQueue();
    } catch (e) {
      this._log('send failed:', e && e.message);
    }
  }

  flush() {
    try {
      this._flushQueue();
    } catch (e) {
      this._log('flush failed:', e && e.message);
    }
  }

  _ensureConnection() {
    if (this.socket || this.connecting || this.closed) return;
    this.connecting = true;
    let sock;
    try {
      sock = net.connect({ host: this.host, port: this.port });
    } catch (e) {
      this.connecting = false;
      this._log('connect failed:', e && e.message);
      this._scheduleReconnect();
      return;
    }
    this.socket = sock;
    try { sock.unref(); } catch (e) { /* ignore */ }
    try { sock.setNoDelay(true); } catch (e) { /* ignore */ }

    sock.on('connect', () => {
      this.connecting = false;
      this.connected = true;
      this.authSent = false;
      this.backoff = INITIAL_BACKOFF_MS;
      this._log('connected to', this.host + ':' + this.port);
      this._sendAuthIfNeeded();
      this._flushQueue();
    });
    sock.on('error', (e) => {
      this._log('socket error:', e && e.message);
    });
    sock.on('close', () => {
      this.connecting = false;
      this.connected = false;
      this.authSent = false;
      this.socket = null;
      if (!this.closed && this.queue.length > 0) this._scheduleReconnect();
    });
  }

  _sendAuthIfNeeded() {
    if (this.authSent || !this.ingestKey || !this.connected || !this.socket) return;
    try {
      const line = JSON.stringify({ type: 'auth', ingest_key: this.ingestKey }) + '\n';
      this.socket.write(line);
      this.authSent = true;
    } catch (e) {
      this._log('auth write failed:', e && e.message);
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer || this.closed) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._ensureConnection();
    }, delay);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  _flushQueue() {
    if (!this.connected || !this.socket) return;
    this._sendAuthIfNeeded();
    while (this.queue.length > 0) {
      const line = this.queue.shift();
      try {
        this.socket.write(line);
      } catch (e) {
        this._log('write failed:', e && e.message);
        this.dropped++;
      }
    }
  }

  /**
   * Flush pending lines (waiting briefly for an in-flight connect) then close.
   * Resolves always; never throws.
   */
  shutdown(timeoutMs) {
    const limit = typeof timeoutMs === 'number' ? timeoutMs : 500;
    return new Promise((resolve) => {
      const done = () => {
        this.closed = true;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        const s = this.socket;
        this.socket = null;
        this.connected = false;
        if (s) {
          try { s.end(); } catch (e) { /* ignore */ }
        }
        resolve();
      };
      try {
        if (this.connected) {
          this._flushQueue();
          return done();
        }
        if (this.queue.length === 0) return done();
        // Pending data but not connected: attempt one connect, bounded by timeout.
        this._ensureConnection();
        const deadline = setTimeout(done, limit);
        if (deadline.unref) deadline.unref();
        const poll = setInterval(() => {
          if (this.connected) {
            this._flushQueue();
            clearTimeout(deadline);
            clearInterval(poll);
            done();
          } else if (this.closed) {
            clearTimeout(deadline);
            clearInterval(poll);
            resolve();
          }
        }, 20);
        if (poll.unref) poll.unref();
      } catch (e) {
        this._log('shutdown error:', e && e.message);
        resolve();
      }
    });
  }
}

module.exports = Transport;
