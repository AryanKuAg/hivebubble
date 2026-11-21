import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readPairing, socketUrl } from './config';

const TOKEN = 'Zk3pV0q8xW1yR6tN2mB5cA7d';

describe('where the bubble finds Hivebubble', () => {
  it('talks to the page’s own origin on Hivebubble’s preview', () => {
    assert.equal(socketUrl({ origin: null, token: null }, { protocol: 'http:', host: 'localhost:4321' }), 'ws://localhost:4321/__hivebubble/ws');
    assert.equal(socketUrl({ origin: null, token: null }, { protocol: 'https:', host: 'app.localhost' }), 'wss://app.localhost/__hivebubble/ws');
  });

  it('talks to the engine, with the pairing token, on pages the extension added it to', () => {
    assert.equal(socketUrl({ origin: 'http://127.0.0.1:4321', token: TOKEN }), `ws://127.0.0.1:4321/__hivebubble/ws?token=${TOKEN}`);
  });

  it('takes a new pairing only for an engine on this computer', () => {
    assert.deepEqual(readPairing(JSON.stringify({ engine: 'http://127.0.0.1:4327', token: TOKEN })), { origin: 'http://127.0.0.1:4327', token: TOKEN });
    for (const bad of [
      { engine: 'http://evil.example:4321', token: TOKEN },
      { engine: 'http://127.0.0.1.evil.example:4321', token: TOKEN },
      { engine: 'http://127.0.0.1:4327', token: 'short' },
      { engine: 'http://127.0.0.1:4327', token: 'spaces are not allowed here' },
    ]) {
      assert.equal(readPairing(JSON.stringify(bad)), null, JSON.stringify(bad));
    }
    assert.equal(readPairing({ engine: 'http://127.0.0.1:4327', token: TOKEN }), null, 'only JSON text comes across from the extension');
    assert.equal(readPairing('not json'), null);
  });
});
