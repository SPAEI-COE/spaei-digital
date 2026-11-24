// Mock em memória do Firebase Realtime Database (compat SDK v8-style), fiel
// o suficiente pra rodar o boot completo do SPAEI DIGITAL em jsdom: .ref(),
// .on('value')/.once/.get/.set/.remove/.update/.orderByKey/.limitToLast e
// .transaction() com serialização real por path (fila) + latência de rede
// simulada (não instantânea — pega bug de corrida que só latência revela).
function buildMockFirebase(latencyMs, storeCompartilhado) {
  latencyMs = latencyMs === undefined ? 5 : latencyMs;
  // storeCompartilhado: o MESMO "servidor" entre 2 boots (simula fechar o app
  // e abrir de novo, ou 2 aparelhos). ctl.otimista: transaction() com
  // applyLocally (padrão do SDK real) dispara os listeners NA HORA com o valor
  // local ainda não confirmado. ctl.congelado: a rede nunca confirma (app
  // fechado / socket morto antes do servidor responder).
  const store = storeCompartilhado || {};
  const ctl = { otimista: false, congelado: false, conectar: false }; // conectar: once(evt,cb) chama o callback (boot real conecta)
  const overlays = {};
  const listeners = {};
  const filaTransacao = {};

  function getAt(path) {
    const parts = path.split('/').filter(Boolean);
    let cur = store;
    for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
    return cur;
  }
  function setAt(path, val) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length) return;
    let cur = store;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    if (val === undefined) delete cur[parts[parts.length - 1]];
    else cur[parts[parts.length - 1]] = val;
  }
  // Visão LOCAL do cliente = servidor + transações otimistas ainda em voo
  function getView(path) {
    const ks = Object.keys(overlays);
    if (!ks.length) return getAt(path);
    const clone = JSON.parse(JSON.stringify(store));
    ks.forEach(op => {
      const parts = op.split('/').filter(Boolean); let cur = clone;
      for (let i = 0; i < parts.length - 1; i++) { if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {}; cur = cur[parts[i]]; }
      cur[parts[parts.length - 1]] = JSON.parse(JSON.stringify(overlays[op]));
    });
    const parts = path.split('/').filter(Boolean); let cur = clone;
    for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
    return cur;
  }
  function fireListeners(path) {
    const parts = path.split('/').filter(Boolean);
    for (let i = parts.length; i >= 0; i--) {
      const p = parts.slice(0, i).join('/');
      (listeners[p] || []).forEach(cb => cb(makeSnap(p, getView(p))));
    }
  }
  // Há listener ativo neste caminho OU em algum ancestral? (= o SDK tem cache local
  // completo desse caminho). Sem isso, transaction() recebe null na 1ª chamada.
  function cobertoPorListener(path) {
    const parts = path.split('/').filter(Boolean);
    for (let i = parts.length; i >= 0; i--) {
      if ((listeners[parts.slice(0, i).join('/')] || []).length) return true;
    }
    return false;
  }
  // update() multi-path do SDK real é ATÔMICO e dispara cada listener UMA vez só
  // (não uma vez por caminho gravado). Reproduz isso aqui.
  function fireListenersUmaVez(paths) {
    const jaChamados = new Set();
    paths.forEach(path => {
      const parts = path.split('/').filter(Boolean);
      for (let i = parts.length; i >= 0; i--) {
        const p = parts.slice(0, i).join('/');
        (listeners[p] || []).forEach(cb => { if (jaChamados.has(cb)) return; jaChamados.add(cb); cb(makeSnap(p, getAt(p))); });
      }
    });
  }
  function makeSnap(path, val) {
    return { exists: () => val !== undefined && val !== null, val: () => (val === undefined ? null : val) };
  }
  function makeRef(path) {
    path = path || '';
    const r = {
      once(evt, cb) { return new Promise(res => setTimeout(() => { const sn = makeSnap(path, getAt(path)); if (ctl.conectar && typeof cb === 'function') cb(sn); res(sn); }, latencyMs)); },
      get() { return new Promise(res => setTimeout(() => res(makeSnap(path, getAt(path))), latencyMs)); },
      on(evt, cb) { const kp = path.split('/').filter(Boolean).join('/'); listeners[kp] = listeners[kp] || []; listeners[kp].push(cb); cb(makeSnap(path, getAt(path))); return cb; },
      off() {},
      set(val) { return new Promise(res => setTimeout(() => { setAt(path, (val === undefined || val === null) ? undefined : JSON.parse(JSON.stringify(val))); fireListeners(path); res(); }, latencyMs)); }, // set(null) APAGA o nó no RTDB real
      remove() { return new Promise(res => setTimeout(() => { setAt(path, undefined); fireListeners(path); res(); }, latencyMs)); },
      update(obj) { return new Promise(res => setTimeout(() => { const caminhos = []; Object.keys(obj).forEach(k => { const full = path ? path + '/' + k : k; setAt(full, obj[k] === null ? undefined : (obj[k] === undefined ? undefined : JSON.parse(JSON.stringify(obj[k])))); caminhos.push(full); }); fireListenersUmaVez(caminhos); res(); }, latencyMs)); },
      orderByKey() { return r; }, limitToLast() { return r; },
      transaction(fn, cb, applyLocally) {
        const kp = path.split('/').filter(Boolean).join('/');
        if (ctl.otimista && applyLocally !== false) {
          const cur0 = getView(kp);
          const local = fn(cur0 === undefined ? null : JSON.parse(JSON.stringify(cur0)));
          if (local !== undefined) { overlays[kp] = JSON.parse(JSON.stringify(local)); fireListeners(kp); }
        }
        if (ctl.congelado) return; // servidor nunca responde
        const _cbOrig = cb;
        cb = function () { if (overlays[kp] !== undefined) delete overlays[kp]; return _cbOrig && _cbOrig.apply(null, arguments); };
        filaTransacao[path] = (filaTransacao[path] || Promise.resolve()).then(() =>
          new Promise(res => {
            setTimeout(() => {
              try {
                const cur = getAt(path);
                // Fidelidade ao SDK real: sem listener ativo cobrindo este caminho o cache
                // local é vazio e o updateFunction recebe null na 1ª chamada. Retornar
                // undefined ali ABORTA a transação (o SDK só refaz com o valor real do
                // servidor se a 1ª tentativa devolveu um valor). Antes este mock entregava
                // o valor real de primeira — escondia o bug de produção em que o SPAEI
                // não conseguia gravar a movimentação na base do SEI DIGITAL COE.
                const temCache = cobertoPorListener(path);
                const visto = temCache ? cur : null;
                let novo = fn(visto === undefined ? null : visto);
                if (novo !== undefined && !temCache && cur !== undefined && cur !== null) {
                  novo = fn(cur); // servidor rejeitou o palpite null: SDK refaz com o valor real
                }
                if (novo === undefined) { cb && cb(null, false, makeSnap(path, cur)); res(); return; }
                setAt(path, JSON.parse(JSON.stringify(novo)));
                fireListeners(path);
                cb && cb(null, true, makeSnap(path, novo));
              } catch (e) { cb && cb(e, false, null); }
              res();
            }, latencyMs);
          })
        );
      }
    };
    return r;
  }
  const db = { ref(p) { return makeRef(p); } };
  // Stub mínimo de App Check — só confirma que activate() roda sem lançar
  // erro (não simula o fluxo real do reCAPTCHA, que exige rede/DOM reais).
  const appCheckCalls = [];
  const appCheckObj = { activate(siteKey, isTokenAutoRefreshEnabled) { appCheckCalls.push({ siteKey, isTokenAutoRefreshEnabled }); } };
  const fb = {
    apps: [],
    initializeApp() { fb.apps.push({ database: () => db }); return { database: () => db }; },
    database() { return db; },
    appCheck() { return appCheckObj; },
  };
  fb.database.ServerValue = { TIMESTAMP: Date.now() };
  return { fb, store, appCheckCalls, ctl };
}

module.exports = { buildMockFirebase };
