'use strict';

/**
 * Agent coverage: periodic fleet heartbeat + remote config pull.
 * POST /api/fleet/agents → inventory; response embeds resolved config
 * (sampling_rate, kill_switch, …).
 */

const http = require('http');
const https = require('https');
const os = require('os');

const DEFAULT_INTERVAL_MS = 60000;

class Fleet {
  constructor(state, opts) {
    this.state = state;
    this.intervalMs = (opts && opts.intervalMs) || DEFAULT_INTERVAL_MS;
    this.onConfig = (opts && opts.onConfig) || null;
    this._timer = null;
    this.remoteConfig = null;
  }

  start() {
    if (this._timer) return;
    this.beat();
    this._timer = setInterval(() => this.beat(), this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  killed() {
    return !!(this.remoteConfig && this.remoteConfig.kill_switch);
  }

  beat() {
    const cfg = this.state.config;
    if (!cfg || !cfg.enabled) return;
    const apiHost = cfg.apiHost || cfg.host || '127.0.0.1';
    const apiPort = cfg.apiPort || 8088;
    const body = JSON.stringify({
      organization_id: cfg.organizationId || cfg.organization_id || '',
      project_id: cfg.projectId || cfg.project_id || '',
      service: cfg.service || 'node',
      host: os.hostname(),
      agent_version: require('../../package.json').version || '0.0.0',
      language: 'node',
      config_hash: String(cfg.samplingRate || '')
    });
    const lib = (cfg.apiTls || apiPort === 443) ? https : http;
    const req = lib.request({
      host: apiHost,
      port: apiPort,
      path: '/api/fleet/agents',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 5000
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.config) {
            this.remoteConfig = parsed.config;
            if (typeof this.onConfig === 'function') {
              try { this.onConfig(parsed.config); } catch (_) { /* ignore */ }
            }
          }
          if (this.killed() && cfg.debug) {
            // eslint-disable-next-line no-console
            console.log('[opa-node] fleet kill_switch active — sampling should stop');
          }
        } catch (_) { /* ignore */ }
      });
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
  }
}

module.exports = { Fleet };
