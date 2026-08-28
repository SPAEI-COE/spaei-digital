// Suite de regressão do SPAEI DIGITAL — roda em CI (GitHub Actions) a cada
// push, contra o index.html REAL do repo (nunca uma cópia). Sem framework de
// teste externo (zero dependência além de jsdom) — cada cenário é uma função
// que loga ✅/❌ e o processo sai com código != 0 se algo falhar, o que
// FALHA o job do Actions automaticamente.
//
// Cobre as classes de bug já documentadas no histórico do app (rito de
// trabalho): escrita atômica/concorrência em escalaSemanas, guarda de duplo
// clique, trilha de auditoria com autor, painel de últimas marcações, e
// estresse de escrita simultânea.
const { bootApp } = require('./boot');

const resultados = [];
function checar(nome, ok, extra) {
  const linha = `${ok ? '✅' : '❌'} ${nome}${extra !== undefined ? ' — ' + String(extra).slice(0, 150) : ''}`;
  console.log(linha);
  resultados.push(ok);
}

async function main() {
  // ───────────────────────────────────────────────────────────
  // GRUPO 1 — Escrita atômica de célula (escalaSemanas) e fallback
  // ───────────────────────────────────────────────────────────
  {
    const { window, store, errosJs } = await bootApp();
    window.eval(`
      Auth.user = { rg:'ADM001', nome:'Admin Teste', posto:'CAP', admin:true };
      DB.set('efetivo', [
        {rg:'ADM001', nome:'Admin Teste', posto:'CAP', chefe:false, admin:true},
        {rg:'111111', nome:'Fulano de Tal', posto:'SD', chefe:false},
      ], 'seed');
      _fbOk = true; _fbSynced = true;
    `);
    await new Promise(r => setTimeout(r, 50));

    window.eval(`Escala.setStatus('111111', 0, 'FOLGA');`);
    await new Promise(r => setTimeout(r, 60));
    const key1 = window.eval(`Escala.chaveAtual()`);
    const local = window.eval(`DB.get('escalaSemanas')['${key1}']['111111'][0]`);
    checar('1.1 — escrita local imediata (otimista)', local === 'FOLGA', local);

    const remoto1 = store.spaei && store.spaei.escalaSemanas && store.spaei.escalaSemanas[key1] && store.spaei.escalaSemanas[key1]['111111'];
    checar('1.2 — grava no "servidor" via path granular (transaction)', !!remoto1 && remoto1[0] === 'FOLGA');

    // merge concorrente: edição local no dia1 + edição remota simulada no dia5 entre a leitura e a escrita
    window.eval(`Escala.setStatus('111111', 3, 'SERVIÇO');`);
    await new Promise(r => setTimeout(r, 60));
    {
      const parts = `spaei/escalaSemanas/${key1}/111111`.split('/');
      let cur = store; for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = cur[parts[i]] || {}; cur = cur[parts[i]]; }
      const atual = (cur[parts[parts.length - 1]] || []).slice(); atual[5] = 'DISPENSA';
      cur[parts[parts.length - 1]] = atual;
    }
    window.eval(`Escala.setStatus('111111', 1, 'SOBREAVISO');`);
    await new Promise(r => setTimeout(r, 60));
    const linhaFinal = store.spaei.escalaSemanas[key1]['111111'];
    checar('1.3 — merge real preserva edição concorrente (dia5) + a própria (dia1)', linhaFinal[1] === 'SOBREAVISO' && linhaFinal[5] === 'DISPENSA' && linhaFinal[3] === 'SERVIÇO', JSON.stringify(linhaFinal));

    // fallback quando a transação falha
    window.eval(`
      const origRef = _fbDB.ref.bind(_fbDB);
      _fbDB.ref = function(p){ const r = origRef(p); if(String(p).includes('escalaSemanas/') && String(p).split('/').length>2){ r.transaction=function(fn,cb){ setTimeout(()=>cb(new Error('falha simulada')),5); }; } return r; };
      window.__fallback = 0;
      const origSet = DB.set.bind(DB);
      DB.set = function(k,v,d){ if(k==='escalaSemanas') window.__fallback++; return origSet(k,v,d); };
      Escala.setStatus('111111', 2, 'A_CRITERIO');
    `);
    await new Promise(r => setTimeout(r, 80));
    checar('1.4 — transação falha → cai no fallback testado (DB.set blob)', window.eval('window.__fallback') > 0);

    // a falha simulada em 1.4 é tratada via try/catch no próprio app (fallback), não deve
    // gerar erro JS não tratado (window.onerror) — só o console.warn esperado
    checar('1.5 — zero erro JS não tratado no grupo 1 (fallback é tratado, não vaza)', errosJs.length === 0, errosJs.join('; '));
  }

  // ───────────────────────────────────────────────────────────
  // GRUPO 2 — Fluxo real de UI (_saveCell), guarda de duplo clique, autor no log
  // ───────────────────────────────────────────────────────────
  {
    const { window, store, errosJs } = await bootApp();
    window.eval(`
      Auth.user = { rg:'ADM001', nome:'Admin Teste', posto:'CAP', admin:true };
      DB.set('efetivo', [
        {rg:'ADM001', nome:'Admin Teste', posto:'CAP', chefe:false, admin:true},
        {rg:'222222', nome:'Beltrano da Silva', posto:'SD', chefe:false},
      ], 'seed');
      _fbOk=true; _fbSynced=true;
    `);
    await new Promise(r => setTimeout(r, 50));
    const chaveProx = window.eval(`chaveDeData(calcSemana(1)[0].jsDate)`);

    window.eval(`Render._saveCell('222222', 2, 'SERVIÇO', '${chaveProx}');`);
    await new Promise(r => setTimeout(r, 60));
    const linha = window.eval(`DB.get('escalaSemanas')['${chaveProx}'] && DB.get('escalaSemanas')['${chaveProx}']['222222']`);
    checar('2.1 — _saveCell (ADM editando outro) grava certo', linha && linha[2] === 'SERVIÇO');

    const ultimoLog = window.eval(`DB.get('logs')[0]`);
    checar('2.2 — log captura o autor (ADM) quando edita outro membro', ultimoLog && ultimoLog.desc.includes('Admin Teste') && ultimoLog.desc.includes('por'));
    checar('2.3 — log tem schema estruturado (opId/autorRg/versao/origem)', !!ultimoLog.opId && ultimoLog.autorRg === 'ADM001' && !!ultimoLog.versao && !!ultimoLog.origem);

    window.eval(`Render._efSalvando = true; Render._saveCell('222222', 3, 'FOLGA', '${chaveProx}');`);
    await new Promise(r => setTimeout(r, 30));
    const dia3 = window.eval(`DB.get('escalaSemanas')['${chaveProx}']['222222'][3]`);
    checar('2.4 — guarda de duplo clique bloqueia chamada concorrente', dia3 !== 'FOLGA');
    window.eval(`Render._efSalvando=false;`);

    checar('2.5 — zero erro JS não tratado no boot/fluxo', errosJs.length === 0, errosJs.join('; '));
  }

  // ───────────────────────────────────────────────────────────
  // GRUPO 3 — Painel de últimas marcações (admin-only, tempo real)
  // ───────────────────────────────────────────────────────────
  {
    const { window } = await bootApp();
    window.eval(`
      Auth.user = { rg:'ADM001', nome:'Admin Teste', posto:'CAP', admin:true };
      DB.set('efetivo', [
        {rg:'ADM001', nome:'Admin Teste', posto:'CAP', chefe:false, admin:true},
        {rg:'333333', nome:'Ciclano Souza', posto:'SD', chefe:false},
      ], 'seed');
      _fbOk=true; _fbSynced=true;
      Nav.current='dashboard';
    `);
    await new Promise(r => setTimeout(r, 50));
    const chaveProx = window.eval(`chaveDeData(calcSemana(1)[0].jsDate)`);
    window.eval(`
      Auth.user = { rg:'333333', nome:'Ciclano Souza', posto:'SD', admin:false };
      const semanas=DB.get('escalaSemanas')||{};
      if(!semanas['${chaveProx}']) semanas['${chaveProx}']={};
      semanas['${chaveProx}']['333333']=['SERVIÇO','SERVIÇO','SERVIÇO','SERVIÇO','SERVIÇO','FOLGA','FOLGA'];
      DB.set('escalaSemanas',semanas);
      Escala.enviar('333333','${chaveProx}');
    `);
    await new Promise(r => setTimeout(r, 80));

    window.eval(`Auth.user = { rg:'ADM001', nome:'Admin Teste', posto:'CAP', admin:true }; Render.dashboard();`);
    const htmlDash = window.eval(`document.getElementById('s-dashboard').innerHTML`);
    checar('3.1 — painel "Últimas Marcações" aparece pro ADM', /Últimas Marcações/.test(htmlDash));
    checar('3.2 — feed mostra o envio real', /Ciclano Souza/.test(htmlDash) && /Programação enviada/.test(htmlDash));

    window.eval(`Auth.user = { rg:'333333', nome:'Ciclano Souza', posto:'SD', admin:false }; Render.dashboard();`);
    const htmlMembro = window.eval(`document.getElementById('s-dashboard').innerHTML`);
    checar('3.3 — membro comum NÃO vê o painel (admin-only)', !/Últimas Marcações/.test(htmlMembro));
  }

  // ───────────────────────────────────────────────────────────
  // GRUPO 4 — Estresse: N usuários enviando ao mesmo tempo + concorrência real
  // ───────────────────────────────────────────────────────────
  {
    const N = 60; // reduzido em relação ao teste manual (120) pra manter o job de CI rápido
    const { window, store } = await bootApp({ latencyMs: 12 });
    const efetivo = [{ rg: 'ADM001', nome: 'Admin Teste', posto: 'CAP', chefe: false, admin: true }];
    for (let i = 1; i <= N; i++) efetivo.push({ rg: String(100000 + i), nome: `Militar ${i}`, posto: 'SD', chefe: false });
    window.eval(`Auth.user={rg:'ADM001',nome:'Admin Teste',posto:'CAP',admin:true};`);
    window.eval(`DB.set('efetivo', ${JSON.stringify(efetivo)}, 'seed carga');`);
    await new Promise(r => setTimeout(r, 50));
    window.eval(`_fbOk=true; _fbSynced=true;`);
    const chaveProx = window.eval(`chaveDeData(calcSemana(1)[0].jsDate)`);

    window.eval(`
      const chave='${chaveProx}';
      for(let i=1;i<=${N};i++){
        const rg=String(100000+i);
        const semanas=DB.get('escalaSemanas')||{};
        if(!semanas[chave]) semanas[chave]={};
        semanas[chave][rg]=['SERVIÇO','SERVIÇO','SERVIÇO','SERVIÇO','SERVIÇO','FOLGA','FOLGA'];
        DB.set('escalaSemanas',semanas);
      }
    `);
    await new Promise(r => setTimeout(r, 80));
    window.eval(`for(let i=1;i<=${N};i++){ Escala.enviar(String(100000+i), '${chaveProx}'); }`);
    await new Promise(r => setTimeout(r, 4000));

    let ok = 0;
    for (let i = 1; i <= N; i++) { if (window.eval(`Escala.isEnviado('${String(100000 + i)}','${chaveProx}')`)) ok++; }
    checar(`4.1 — ${N} envios simultâneos, zero perda`, ok === N, `${ok}/${N}`);
  }

  // ───────────────────────────────────────────────────────────
  // GRUPO 5 — Tela "Log de Auditoria" migrada pra Alpine.js (28/08):
  // proteção real contra XSS via x-text (auto-escape arquitetural, não
  // depende de lembrar escHtml() em cada ponto).
  // ───────────────────────────────────────────────────────────
  {
    const { window, errosJs } = await bootApp();
    window.eval(`
      Auth.user = { rg:'ADM001', nome:'Admin Teste', posto:'CAP', admin:true };
      DB.set('efetivo', [{rg:'ADM001', nome:'Admin Teste', posto:'CAP', chefe:false, admin:true}], 'seed');
      _fbOk=true; _fbSynced=true;
      _logAdd('LOGIN', 'CAP Admin Teste acessou (RG ADM001)');
      _logAdd('EDIÇÃO', '<img src=x onerror="window.__xss_disparou=true">');
      _logAdd('EXCLUSÃO', 'Nome com aspas duplas: "teste" e apóstrofo: O\\'BRIEN');
    `);
    await new Promise(r => setTimeout(r, 50));
    window.eval(`DB.set('adm_tab','logs'); Render.admin();`);
    await new Promise(r => setTimeout(r, 200));

    checar('5.1 — Alpine.js carregou', window.eval('typeof Alpine !== "undefined"'));
    const texto = window.eval(`document.getElementById('s-admin').textContent`);
    checar('5.2 — log normal aparece como texto', texto.includes('Admin Teste acessou'));
    checar('5.3 — tentativa de XSS (img onerror) vira texto literal', texto.includes('<img src=x onerror='));
    checar('5.4 — XSS 1 NÃO EXECUTOU', window.eval('window.__xss_disparou === true') === false);
    checar('5.5 — aspas duplas/apóstrofo aparecem literais (sem quebrar atributo)', texto.includes('aspas duplas: "teste"') && texto.includes("O'BRIEN"));
    const imgReal = window.eval(`document.getElementById('s-admin').querySelector('img')`);
    checar('5.6 — nenhum <img> real criado no DOM', imgReal === null);
    checar('5.7 — zero erro JS não tratado', errosJs.length === 0, errosJs.join('; '));
  }

  const falhas = resultados.filter(r => !r).length;
  console.log('');
  console.log(falhas === 0 ? `=== TODOS OS ${resultados.length} TESTES PASSARAM ===` : `=== ${falhas} DE ${resultados.length} TESTE(S) FALHARAM ===`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch(e => { console.error('ERRO FATAL NA SUITE:', e); process.exit(1); });
