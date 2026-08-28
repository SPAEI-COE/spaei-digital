const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const { buildMockFirebase } = require('./mock-firebase');

// Sobe o app real (index.html, sem edição nenhuma) num jsdom, com o SDK do
// Firebase trocado pelo mock (sandbox/CI não deve depender de rede real do
// Firebase pra rodar testes). Único stub de verdade: crypto.subtle (jsdom
// não implementa) via módulo nativo crypto do Node.
async function bootApp(opts) {
  opts = opts || {};
  const latencyMs = opts.latencyMs === undefined ? 5 : opts.latencyMs;
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
  const { fb, store, appCheckCalls } = buildMockFirebase(latencyMs);
  const htmlSemFbSdk = html.replace(/<script src="https:\/\/www\.gstatic\.com\/firebasejs[^"]*"><\/script>/g, '');

  const errosJs = [];
  const dom = new JSDOM(htmlSemFbSdk, {
    url: 'https://spaei-coe.github.io/spaei-digital/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.firebase = fb;
      window.matchMedia = window.matchMedia || function () { return { matches: false, addListener() {}, removeListener() {} }; };
      if (!window.crypto || !window.crypto.subtle) {
        const nodeCrypto = require('crypto');
        window.crypto = window.crypto || {};
        window.crypto.subtle = { digest: async (algo, data) => nodeCrypto.createHash('sha256').update(Buffer.from(data)).digest().buffer };
      }
      window.onerror = (msg, src, line, col, err) => { errosJs.push(`${msg} @linha ${line}`); };
    }
  });

  await new Promise(r => setTimeout(r, 300));
  return { window: dom.window, store, errosJs, appCheckCalls };
}

module.exports = { bootApp };
