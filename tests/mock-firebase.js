// Mock em memória do Firebase Realtime Database (compat SDK v8-style), fiel
// o suficiente pra rodar o boot completo do SPAEI DIGITAL em jsdom: .ref(),
// .on('value')/.once/.get/.set/.remove/.update/.orderByKey/.limitToLast e
// .transaction() com serialização real por path (fila) + latência de rede
// simulada (não instantânea — pega bug de corrida que só latência revela).
function buildMockFirebase(latencyMs) {
  latencyMs = latencyMs === undefined ? 5 : latencyMs;
  const store = {};
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
  function fireListeners(path) {
    const parts = path.split('/').filter(Boolean);
    for (let i = parts.length; i >= 0; i--) {
      const p = parts.slice(0, i).join('/');
      (listeners[p] || []).forEach(cb => cb(makeSnap(p, getAt(p))));
    }
  }
  function makeSnap(path, val) {
    return { exists: () => val !== undefined && val !== null, val: () => (val === undefined ? null : val) };
  }
  function makeRef(path) {
    path = path || '';
    const r = {
      once() { return new Promise(res => setTimeout(() => res(makeSnap(path, getAt(path))), latencyMs)); },
      get() { return new Promise(res => setTimeout(() => res(makeSnap(path, getAt(path))), latencyMs)); },
      on(evt, cb) { listeners[path] = listeners[path] || []; listeners[path].push(cb); cb(makeSnap(path, getAt(path))); return cb; },
      off() {},
      set(val) { return new Promise(res => setTimeout(() => { setAt(path, val === undefined ? undefined : JSON.parse(JSON.stringify(val))); fireListeners(path); res(); }, latencyMs)); },
      remove() { return new Promise(res => setTimeout(() => { setAt(path, undefined); fireListeners(path); res(); }, latencyMs)); },
      update(obj) { return new Promise(res => setTimeout(() => { Object.keys(obj).forEach(k => { const full = path ? path + '/' + k : k; setAt(full, obj[k]); fireListeners(full); }); res(); }, latencyMs)); },
      orderByKey() { return r; }, limitToLast() { return r; },
      transaction(fn, cb) {
        filaTransacao[path] = (filaTransacao[path] || Promise.resolve()).then(() =>
          new Promise(res => {
            setTimeout(() => {
              try {
                const cur = getAt(path);
                const novo = fn(cur === undefined ? null : cur);
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
  const fb = { apps: [], initializeApp() { fb.apps.push({ database: () => db }); return { database: () => db }; }, database() { return db; } };
  fb.database.ServerValue = { TIMESTAMP: Date.now() };
  return { fb, store };
}

module.exports = { buildMockFirebase };
