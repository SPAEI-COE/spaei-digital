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

  // ───────────────────────────────────────────────────────────
  // GRUPO 6 — onclick com numero/id de processo vindo do SEI (texto externo,
  // não controlado pelo app): reproduz o SyntaxError REAL capturado pelo
  // Sentry em produção (10/09/2026, "Unexpected end of input" ao abrir
  // processo via card, mecanismo auto.browser.global_handlers.onerror).
  // escHtml() sozinho NÃO protege argumento de string dentro de onclick
  // (o navegador decodifica a entidade ANTES de compilar o atributo como
  // JS) — a correção usa _safeArg/_argVal (índice numérico, nunca quebra
  // sintaxe) em vez de interpolar o texto livre direto na string.
  // ───────────────────────────────────────────────────────────
  {
    const { window, errosJs } = await bootApp();
    window.eval(`
      Auth.user = { rg:'ADM001', nome:'Admin Teste', posto:'CAP', admin:true };
      DB.set('efetivo', [{rg:'ADM001', nome:'Admin Teste', posto:'CAP', chefe:false, admin:true}], 'seed');
      DB.set('processos', [], 'seed');
      _fbOk=true; _fbSynced=true;
      _mem['sei_processos'] = [{
        id: undefined, numero: "SEI-260002/002950/2026 O'BRIEN", assunto: 'Processo de teste',
        status: 'EM ANDAMENTO', prio: 'ALTA', resp: 'Fulano de Tal', criado: '01/09/2026',
        prazo: '30/09/2026', tipo: 'AQUISIÇÃO', _src: 'SEI'
      }];
    `);
    await new Promise(r => setTimeout(r, 50));
    window.eval(`Nav.go('dashproc');`);
    await new Promise(r => setTimeout(r, 100));

    const html = window.eval(`document.getElementById('s-dashproc').innerHTML`);
    checar("6.1 — onclick do card NÃO tem o apóstrofo cru (usa _argVal, nunca texto livre)", !/onclick="[^"]*O\\'BRIEN/.test(html) && !/onclick="[^"]*O'BRIEN/.test(html));

    const temCard = window.eval(`document.querySelector('.dp-proc-card') !== null`);
    checar('6.2 — card do processo SEI renderizou', temCard);

    // Clique real no card — é exatamente esse evento que, no código antigo,
    // disparava o SyntaxError capturado pelo window.onerror (== Sentry).
    window.eval(`document.querySelector('.dp-proc-card').dispatchEvent(new window.MouseEvent('click',{bubbles:true}))`);
    await new Promise(r => setTimeout(r, 100));

    checar('6.3 — clique no card NÃO gera SyntaxError/erro JS não tratado', errosJs.length === 0, errosJs.join('; '));
    const modalAbriu = window.eval(`document.querySelector('.dp-detail-num') !== null`);
    checar('6.4 — modal de detalhes do processo abriu de verdade (numero com apóstrofo íntegro)', modalAbriu);
    if (modalAbriu) {
      const numeroExibido = window.eval(`document.querySelector('.dp-detail-num').textContent`);
      checar("6.5 — numero exibido no modal preserva o apóstrofo (O'BRIEN)", numeroExibido.includes("O'BRIEN"), numeroExibido);
    }
  }

  // ───────────────────────────────────────────────────────────
  // GRUPO 7 — escrita de escala ANTES da 1ª sincronização completa (_fbOk
  // true, _fbSynced ainda false): reproduz a janela real de perda relatada
  // em produção (10/09/2026, "marquei e não ficou registrada") — vários
  // membros abrindo o app quase ao mesmo tempo caíam no blob antigo
  // (sobrescrita) em vez da transação atômica por célula.
  // ───────────────────────────────────────────────────────────
  {
    const { window, store } = await bootApp();
    window.eval(`
      Auth.user = { rg:'ADM001', nome:'Admin Teste', posto:'CAP', admin:true };
      DB.set('efetivo', [
        {rg:'ADM001', nome:'Admin Teste', posto:'CAP', chefe:false, admin:true},
        {rg:'333333', nome:'Ciclano', posto:'SD', chefe:false},
      ], 'seed');
      window.__blobCalls = 0;
      const origSet = DB.set.bind(DB);
      DB.set = function(k,v,d){ if(k==='escalaSemanas') window.__blobCalls++; return origSet(k,v,d); };
      _fbOk = true; _fbSynced = false; // exatamente a janela vulnerável (conectado, mas 1ª leitura ainda não terminou)
    `);
    await new Promise(r => setTimeout(r, 50));
    window.eval(`Escala.setStatus('333333', 2, 'DISPENSA');`);
    await new Promise(r => setTimeout(r, 80));

    const key = window.eval(`Escala.chaveAtual()`);
    const remoto = store.spaei && store.spaei.escalaSemanas && store.spaei.escalaSemanas[key] && store.spaei.escalaSemanas[key]['333333'];
    checar('7.1 — com _fbSynced=false mas online, grava via transação atômica no "servidor" mesmo assim', !!remoto && remoto[2] === 'DISPENSA', JSON.stringify(remoto));
    checar('7.2 — NÃO usou o caminho antigo de blob (fallback) enquanto ainda dava pra usar a transação segura', window.eval('window.__blobCalls') === 0, window.eval('window.__blobCalls'));

    // Continua caindo pro blob quando GENUINAMENTE offline (comportamento antigo preservado)
    window.eval(`_fbOk = false;`);
    window.eval(`Escala.setStatus('333333', 4, 'FOLGA');`);
    await new Promise(r => setTimeout(r, 60));
    checar('7.3 — genuinamente offline (_fbOk=false) ainda usa o fallback (blob) — comportamento antigo preservado', window.eval('window.__blobCalls') > 0);
  }

  // ───────────────────────────────────────────────────────────
  // GRUPO 8 — Feriados/Calendário: laço infinito de re-render (microtask)
  // que CONGELAVA a aba (v6.87). Causa: Render.calendario chamava sempre
  // Feriados.carregar(ano).then(render) — com o ano já em cache, a promise
  // resolvia na hora → render → carregar → render... E com busca em
  // andamento, carregar devolvia null na hora → mesmo laço no Dashboard.
  // O wrapper abaixo corta o laço em 50 renders (senão o próprio teste
  // congelaria o CI) e conta quantas vezes a tela foi redesenhada.
  // ───────────────────────────────────────────────────────────
  {
    const { window, errosJs } = await bootApp();
    window.eval(`
      Auth.user = { rg:'ADM001', nome:'Admin Teste', posto:'CAP', admin:true };
      DB.set('efetivo', [{rg:'ADM001', nome:'Admin Teste', posto:'CAP', chefe:false, admin:true}], 'seed');
      window.__nCal = 0; window.__nDash = 0;
      const _c = Render.calendario, _d = Render.dashboard;
      Render.calendario = function(){ if(++window.__nCal > 50) return; return _c.apply(this, arguments); };
      Render.dashboard  = function(){ if(++window.__nDash > 50) return; return _d.apply(this, arguments); };
      const _ano = String(agoraCorrigido().getFullYear());
      Feriados._cache[_ano] = [{date:_ano+'-04-23', name:'Dia de São Jorge', type:'estadual'}];
    `);
    window.eval(`Nav.go('calendario');`);
    await new Promise(r => setTimeout(r, 120));
    const nCal = window.eval('window.__nCal');
    checar('8.1 — Calendário com ano já em cache NÃO entra em laço de re-render', nCal <= 3, nCal);

    window.eval(`
      const _ano = String(agoraCorrigido().getFullYear());
      delete Feriados._cache[_ano];
      Feriados._carregando[_ano] = new Promise(() => {}); // busca "em andamento" que ainda não voltou
      window.__nDash = 0;
      Nav.go('dashboard'); Render.dashboard(); // 2º render durante a busca (ex.: listener do Firebase)
    `);
    await new Promise(r => setTimeout(r, 120));
    const nDash = window.eval('window.__nDash');
    checar('8.2 — Dashboard com busca de feriados em andamento NÃO entra em laço de re-render', nDash <= 3, nDash);
    checar('8.3 — zero erro JS não tratado no grupo 8', errosJs.length === 0, errosJs.join(' | '));
  }

  // ───────────────────────────────────────────────────────────
  // GRUPO 9 — "Processos por Responsável" (Dashboard): nome com aspas
  // duplas/apóstrofo ia cru dentro do onclick e quebrava o clique
  // (SyntaxError), irmão não coberto pelo fix _safeArg da v6.86.
  // ───────────────────────────────────────────────────────────
  {
    const { window, errosJs } = await bootApp();
    const RESP = `D'ÁVILA "Chefe"`;
    window.eval(`
      Auth.user = { rg:'ADM001', nome:'Admin Teste', posto:'CAP', admin:true };
      DB.set('efetivo', [{rg:'ADM001', nome:'Admin Teste', posto:'CAP', chefe:false, admin:true}], 'seed');
      DB.set('processos', [
        {id:'P1', numero:'SEI-AAA', assunto:'X', resp:${JSON.stringify(RESP)}, status:'EM ANDAMENTO', prio:'ALTA'},
        {id:'P2', numero:'SEI-BBB', assunto:'Y', resp:'Outro', status:'EM ANDAMENTO', prio:'ALTA'},
      ], 'seed');
      Nav.go('dashboard');
    `);
    await new Promise(r => setTimeout(r, 80));
    const alvo = [...window.document.querySelectorAll('[onclick*="procresp"]')]
      .find(e => e.textContent.includes("D'ÁVILA"));
    checar('9.1 — card do responsável renderizou', !!alvo);
    if (alvo) alvo.click();
    await new Promise(r => setTimeout(r, 60));
    const corpo = window.document.getElementById('drw-body').innerHTML;
    checar('9.2 — drawer abriu filtrado no responsável certo (nome íntegro)', window.document.getElementById('drw-ttl').textContent === `Processos — ${RESP}` && corpo.includes('SEI-AAA') && !corpo.includes('SEI-BBB'), window.document.getElementById('drw-ttl').textContent);
    checar('9.3 — clique NÃO gera SyntaxError/erro JS não tratado', errosJs.length === 0, errosJs.join(' | '));
  }

  // ───────────────────────────────────────────────────────────
  // GRUPO 10 — ANTI-DESCONFIGURAÇÃO (v6.88). Bug real relatado: "o membro
  // marca a folga/dispensa e poucos dias depois não está mais marcado".
  // Causa reproduzida: aparelho com cache antigo abria o app, Motor.tick()
  // gerava a escala padrão antes da 1ª sincronização e o flush gravava o nó
  // escalaSemanas INTEIRO por cima, zerando as marcações dos OUTROS membros.
  // Usa o trecho REAL de sincronização inicial do index.html (extraído do
  // próprio arquivo, sem reescrever), porque o mock não simula
  // .info/connected.
  // ───────────────────────────────────────────────────────────
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf-8');
    const ini = src.indexOf('_fbDB.ref(FB_NODE).get().then(s=>{');
    const SYNC = src.slice(ini, src.indexOf('}).catch(()=>{});', ini) + 17);
    // Espera por CONDIÇÃO (até 5s), nunca tempo fixo — runner de CI mais lento
    // não pode virar falso negativo (mesma classe do flake conhecido de boot.js).
    const esperarAte = async (cond, max = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { try { if (cond()) return true; } catch (e) {} await new Promise(r => setTimeout(r, 25)); } return false; };
    const P = ['SERVIÇO','SERVIÇO','SERVIÇO','SERVIÇO','SERVIÇO','FOLGA','FOLGA'];

    // 10.1-10.3: celular com cache velho (sem as semanas novas) abre o app
    {
      const { window, store, errosJs } = await bootApp();
      window.eval(`DB.set('efetivo',[{rg:'111111',nome:'Fulano',posto:'SD'},{rg:'222222',nome:'Beltrano',posto:'CB'}],'seed');`);
      await new Promise(r => setTimeout(r, 40));
      const kA = window.eval('chaveDeData(calcSemana(0)[0].jsDate)'), kP = window.eval('chaveDeData(calcSemana(1)[0].jsDate)');
      store.spaei = store.spaei || {};
      store.spaei.escalaSemanas = { [kA]: { '111111': ['FOLGA', ...P.slice(1)] }, [kP]: { '111111': ['DISPENSA', 'DISPENSA', ...P.slice(2)] } };
      window.eval(`
        Auth.user = { rg:'222222', nome:'Beltrano', posto:'CB' };
        try{ localStorage.setItem(LS_PFX+'escalaSemanas__base', JSON.stringify({'2020-W01':{'111111':${JSON.stringify(P)}}})); }catch(e){}
        if(typeof _escBase!=='undefined') _escBase = undefined;
        _mem.escalaSemanas = {'2020-W01':{'111111':${JSON.stringify(P)}}};
        _fbOk = true; _fbSynced = false; _fbQueue.clear(); Object.keys(_pendentes).forEach(k=>delete _pendentes[k]);
        Motor.tick(); // exatamente o que App.init() faz ao abrir
      `);
      window.eval(SYNC);
      await esperarAte(() => window.eval('_fbSynced') && !window.eval('!!_pendentes.escalaSemanas') && store.spaei.escalaSemanas[kP] && store.spaei.escalaSemanas[kP]['222222']);
      const s = store.spaei.escalaSemanas;
      checar('10.1 — cache velho abrindo o app NÃO apaga folga/dispensa de OUTRO membro', s[kA]['111111'][0] === 'FOLGA' && s[kP]['111111'][0] === 'DISPENSA', JSON.stringify([s[kA]['111111'], s[kP]['111111']]));
      checar('10.2 — tela do aparelho passa a mostrar o dado real do servidor', window.eval(`Escala.getStatusByKey('111111','${kP}')[0]`) === 'DISPENSA');
      checar('10.3 — zero erro JS não tratado', errosJs.length === 0, errosJs.join(' | '));
    }

    // 10.4-10.6: marcação feita offline + ADM mudou outro dia/outro membro no servidor
    {
      const { window, store } = await bootApp();
      window.eval(`DB.set('efetivo',[{rg:'111111',nome:'Fulano',posto:'SD'},{rg:'222222',nome:'Beltrano',posto:'CB'}],'seed');`);
      await new Promise(r => setTimeout(r, 40));
      const kP = window.eval('chaveDeData(calcSemana(1)[0].jsDate)');
      store.spaei = store.spaei || {};
      store.spaei.escalaSemanas = { [kP]: { '222222': [...P], '111111': [...P] } };
      const base = JSON.stringify({ [kP]: { '222222': P, '111111': P } });
      window.eval(`
        Auth.user = { rg:'222222', nome:'Beltrano', posto:'CB' };
        try{ localStorage.setItem(LS_PFX+'escalaSemanas__base', ${JSON.stringify(base)}); }catch(e){}
        if(typeof _escBase!=='undefined') _escBase = undefined;
        _mem.escalaSemanas = ${base};
        _fbOk = false; _fbSynced = false; _fbQueue.clear(); Object.keys(_pendentes).forEach(k=>delete _pendentes[k]);
        DB.setCelulaEscala('${kP}','222222',2,'DISPENSA',defaultStatusSemana(false),'marcação offline');
      `);
      store.spaei.escalaSemanas[kP]['222222'][4] = 'FOLGA';
      store.spaei.escalaSemanas[kP]['111111'][0] = 'FOLGA';
      window.eval('_fbOk = true;');
      window.eval(SYNC);
      await esperarAte(() => window.eval('_fbSynced') && store.spaei.escalaSemanas[kP]['222222'][2] === 'DISPENSA' && !window.eval('!!_pendentes.escalaSemanas'));
      const s = store.spaei.escalaSemanas[kP];
      checar('10.4 — marcação feita offline chega ao servidor ao reconectar', s['222222'][2] === 'DISPENSA', JSON.stringify(s['222222']));
      checar('10.5 — alteração do ADM em outro dia da mesma linha preservada', s['222222'][4] === 'FOLGA');
      checar('10.6 — alteração do ADM em outro membro preservada', s['111111'][0] === 'FOLGA', JSON.stringify(s['111111']));
    }
  }

  // ───────────────────────────────────────────────────────────
  // GRUPO 11 — Integração SEI DIGITAL COE ↔ SPAEI (v6.89): status
  // 'Finalizado'/'Baixado' do SEI apareciam como EM ANDAMENTO; movimentação
  // pelo SPAEI gravava 'Concluído' (inexistente no SEI) e SUBSTITUÍA as
  // observações acumuladas do SEI em vez de acrescentar.
  // ───────────────────────────────────────────────────────────
  {
    const { window, store, errosJs } = await bootApp();
    const esperarAte = async (cond, max = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { try { if (cond()) return true; } catch (e) {} await new Promise(r => setTimeout(r, 25)); } return false; };
    store['sei-digital'] = { processos: { X1: { numero:'SEI-1', status:'Em Andamento', observacoes:'Despacho antigo - 01/09/2026', historico:[{data:'01/09/2026 10:00',por:'Sistema',texto:'criado'}], spaeiSync:true } } };
    store['spaei-digital'] = { 'sei-processos': { X1: { numero:'SEI-1', status:'Em Andamento', observacoes:'Despacho antigo - 01/09/2026' }, X2: { numero:'SEI-2', status:'Baixado' } } };
    window.eval(`Auth.user={rg:'ADM001',nome:'Admin Teste',posto:'CAP',admin:true}; _fbOk=true; _fbSynced=true; DB._listenRealtime(); _fbOk=true;`);
    await esperarAte(() => window.eval(`(getSeiProcs()||[]).length`) === 2);
    checar('11.1 — "Baixado"/"Finalizado" do SEI chegam como CONCLUÍDO', window.eval(`getSeiProcs().find(p=>p.id==='SEI-X2').status`) === 'CONCLUÍDO' && window.eval(`_mapStatus('Finalizado')`) === 'CONCLUÍDO');
    window.eval(`Nav.go('processos'); Render._pushMovSei('SEI-X1','CONCLUÍDO','Remetido a DOr');`);
    await esperarAte(() => store['spaei-digital']['sei-processos'].X1.status === 'Finalizado');
    const b = store['sei-digital'].processos.X1, e = store['spaei-digital']['sei-processos'].X1;
    checar('11.2 — SEI recebe status válido ("Finalizado")', b.status === 'Finalizado', b.status);
    checar('11.3 — observação acrescentada, despacho antigo preservado', /^Despacho antigo - 01\/09\/2026 - Remetido a DOr - /.test(b.observacoes || '') && e.observacoes === b.observacoes, b.observacoes);
    checar('11.4 — histórico do SEI registra a movimentação', Array.isArray(b.historico) && b.historico.length === 2 && /Remetido a DOr/.test(b.historico[1].texto));
    checar('11.5 — zero erro JS não tratado', errosJs.length === 0, errosJs.join(' | '));
  }

  // ───────────────────────────────────────────────────────────
  // GRUPO 12 — Arquivo permanente de escalas + relatório de semanas
  // anteriores (v6.90). Antes: relatório só lia a semana exibida; semana
  // passada era recalculada com efetivo/afastamentos de HOJE; afastamento
  // fora de ±10 semanas deixava de ser aplicado.
  // ───────────────────────────────────────────────────────────
  {
    const { window, store, errosJs } = await bootApp();
    const esperarAte = async (cond, max = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { try { if (cond()) return true; } catch (e) {} await new Promise(r => setTimeout(r, 25)); } return false; };
    const K = (off) => window.eval(`chaveDeData(calcSemana(${off})[0].jsDate)`);
    const k1 = K(-1), k2 = K(-2), k3 = K(-3), kAtual = K(0), kFut = K(2);

    // 12.1 — chave ISO ↔ datas: ida e volta para todas as semanas de 2026/2027; inválidas rejeitadas
    {
      const r = window.eval(`(()=>{ let ruim=[]; for(const ano of [2026,2027]){ for(let w=1;w<=53;w++){ const k=ano+'-W'+String(w).padStart(2,'0'); const d=Arquivo.dias(k); if(d){ if(chaveDeData(d[0].jsDate)!==k||d[0].lbl!=='SEG'||d[6].lbl!=='DOM') ruim.push(k); } else if(!(ano===2027&&w===53)) ruim.push('null:'+k); } } return JSON.stringify({ruim,w00:Arquivo.dias('2026-W00'),w54:Arquivo.dias('2026-W54'),lixo:Arquivo.dias('abc'),w53_2027:Arquivo.dias('2027-W53')}); })()`);
      const o = JSON.parse(r);
      checar('12.1 — Arquivo.dias confere com chaveDeData em 2026/2027; W00/W54/lixo/2027-W53 rejeitados', o.ruim.length === 0 && o.w00 === null && o.w54 === null && o.lixo === null && o.w53_2027 === null, r);
    }

    // 12.2 — _diasDaSemana: igual ao método antigo dentro de ±10 semanas e agora funciona além disso
    {
      const r = window.eval(`(()=>{ let dif=0; for(let off=-10;off<=10;off++){ const a=Afast._diasDaSemana(chaveDeData(calcSemana(off)[0].jsDate)); const b=calcSemana(off); if(!a||a[0].jsDate.toDateString()!==b[0].jsDate.toDateString()||a[6].jsDate.toDateString()!==b[6].jsDate.toDateString()) dif++; } const longe=Afast._diasDaSemana(chaveDeData(calcSemana(-40)[0].jsDate)); return JSON.stringify({dif,longe:!!longe}); })()`);
      checar('12.2 — _diasDaSemana idêntico ao antigo em ±10 semanas e válido a 40 semanas atrás', JSON.parse(r).dif === 0 && JSON.parse(r).longe === true, r);
    }

    // preparação: ADM, efetivo, escala de 3 semanas passadas + atual + futura
    const ontem = window.eval(`(()=>{ const d=calcSemana(-2); return d[0].dataStr+'|'+d[4].dataStr+'|'+d[6].dataStr; })()`).split('|');
    window.eval(`
      Auth.user = { rg:'ADM001', nome:'Admin Teste', posto:'CAP', admin:true };
      DB.set('efetivo', [
        {rg:'111111', nome:'Fulano de Tal', posto:'SD', chefe:false},
        {rg:'222222', nome:'Beltrano', posto:'CB', chefe:false},
        {rg:'333333', nome:'=HYPERLINK("x")', posto:'SGT', chefe:false},
      ], 'seed');
      const L=['SERVIÇO','SERVIÇO','SERVIÇO','SERVIÇO','SERVIÇO','FOLGA','FOLGA'];
      const esc={};
      ['${k1}','${k2}','${k3}','${kAtual}','${kFut}'].forEach(k=>{ esc[k]={'111111':[...L],'222222':[...L],'333333':[...L]}; });
      esc['${k3}']['999999']=[...L]; // militar que depois saiu do efetivo
      DB.set('escalaSemanas', esc, 'seed', {inteiro:true});
      // férias JÁ ENCERRADAS do 222222 cobrindo SEG-QUI de k2 (arquivadas em afastHist)
      const dk2=Arquivo.dias('${k2}');
      DB.set('afastHist', {'222222':[{tipo:'FERIAS',dataIni:dk2[0].dataStr,dataFim:dk2[3].dataStr,arquivadoEm:dk2[6].dataStr}]}, 'seed', {inteiro:true});
      // afastamento SEM data fim, arquivado em SEX de k3 (substituído) — não pode vazar para depois
      const dk3=Arquivo.dias('${k3}');
      DB.set('afastHist', Object.assign({}, DB.get('afastHist'), {'111111':[{tipo:'LICENCA',dataIni:dk3[0].dataStr,dataFim:'',arquivadoEm:dk3[4].dataStr}]}), 'seed', {inteiro:true});
      _fbOk=true; _fbSynced=true;
    `);
    await new Promise(r => setTimeout(r, 60));
    const linhaDe = (chave, rg) => JSON.parse(window.eval(`JSON.stringify(Arquivo.dadosSemana('${chave}').rows.find(r=>r[1]==='${rg}'))`));

    // 12.3 — reconstituição: férias já encerradas (afastHist) aparecem na semana passada
    {
      const l = linhaDe(k2, '222222');
      checar('12.3 — semana passada reconstituída mostra FÉRIAS já encerradas (SEG-QUI) e SERVIÇO depois', l.slice(3,7).every(x => x === 'FÉRIAS') && l[7] === 'SERVIÇO' && l[8] === 'FOLGA', JSON.stringify(l));
    }
    // 12.4 — afastamento sem data fim arquivado não vaza além da data de arquivamento nem para outras semanas
    {
      const a = linhaDe(k3, '111111'), b = linhaDe(k2, '111111');
      checar('12.4 — LICENÇA sem fim, arquivada na SEX, vale SEG-SEX da sua semana e NÃO vaza para a semana seguinte', a.slice(3,8).every(x => x === 'LICENÇA') && a[8] === 'FOLGA' && b.slice(3).every(x => x !== 'LICENÇA'), JSON.stringify([a, b]));
    }
    // 12.5 — militar que consta na escala mas saiu do efetivo continua no relatório da época
    {
      const nomes = JSON.parse(window.eval(`JSON.stringify(Arquivo.dadosSemana('${k3}').rows.map(r=>r[2]))`));
      checar('12.5 — RG fora do efetivo atual aparece marcado no relatório da semana', nomes.some(n => /fora do efetivo atual.*999999/.test(n)), JSON.stringify(nomes));
    }

    // 12.6 — congelar grava no servidor, escreve-uma-vez, e a foto não muda quando a escala muda depois
    {
      const ok1 = await window.eval(`Arquivo.congelar('${k2}')`);
      const snap1 = JSON.stringify(store.spaei.escalaArquivo && store.spaei.escalaArquivo[k2]);
      window.eval(`Escala.setStatus('222222', 6, 'DISPENSA');`); // muda DOM da semana ATUAL, não a k2 — mexe também na k2 abaixo
      window.eval(`DB.setCelulaEscala('${k2}','111111',0,'DISPENSA',defaultStatusSemana(false),'edicao tardia');`);
      await new Promise(r => setTimeout(r, 80));
      const ok2 = await window.eval(`Arquivo.congelar('${k2}')`);
      const snap2 = JSON.stringify(store.spaei.escalaArquivo[k2]);
      const l = linhaDe(k2, '111111');
      checar('12.6 — congelar grava a semana; 2ª chamada NÃO sobrescreve; relatório usa a foto, não a edição tardia', ok1 === true && ok2 === false && snap1 === snap2 && l[3] === 'SERVIÇO', JSON.stringify({ ok1, ok2, l }));
      const origem = JSON.parse(snap1);
      checar('12.7 — foto contém linhas, rótulo, datas, versão e nenhum undefined', Array.isArray(origem.linhas) && origem.linhas.length === 3 && origem.versao === window.eval('APP_VERSAO') && /^\d{2}\/\d{2}\/\d{4}$/.test(origem.de) && !/undefined/.test(snap1), snap1.slice(0, 120));
    }
    // 12.8 — roster mudou depois: relatório da semana arquivada ainda lista quem estava
    {
      window.eval(`DB.set('efetivo', DB.get('efetivo').filter(m=>m.rg!=='222222'), 'saiu', {inteiro:true});`);
      const nomes = JSON.parse(window.eval(`JSON.stringify(Arquivo.dadosSemana('${k2}').rows.map(r=>r[1]))`));
      checar('12.8 — militar que saiu do efetivo continua no relatório da semana arquivada', nomes.includes('222222'), JSON.stringify(nomes));
      window.eval(`DB.set('efetivo', DB.get('efetivo').concat([{rg:'222222', nome:'Beltrano', posto:'CB', chefe:false}]), 'volta', {inteiro:true});`);
    }
    // 12.9 — varredura: congela só encerradas e plausíveis; ignora atual, futura e ano implausível
    {
      window.eval(`const e=DB.get('escalaSemanas'); e['2019-W10']={'111111':['SERVIÇO','SERVIÇO','SERVIÇO','SERVIÇO','SERVIÇO','FOLGA','FOLGA']}; e['lixo']={}; _mem.escalaSemanas=e; Arquivo._varrEm=0;`);
      const n = await window.eval(`Arquivo.congelarEncerradas(true)`);
      const ks = Object.keys(store.spaei.escalaArquivo || {}).sort();
      checar('12.9 — varredura arquiva k3 e k1 (k2 já estava) e NÃO arquiva semana atual, futura, 2019 nem chave inválida', n === 2 && ks.length === 3 && ks.includes(k1) && ks.includes(k2) && ks.includes(k3), JSON.stringify({ n, ks }));
    }
    // 12.10 — membro comum e Modo TV nunca gravam no arquivo
    {
      const antes = JSON.stringify(store.spaei.escalaArquivo);
      window.eval(`Auth.user={rg:'111111',nome:'Fulano',posto:'SD',admin:false};`);
      const r1 = await window.eval(`Arquivo.congelar('${kAtual}')`);
      window.eval(`Auth.user={rg:'ADM001',nome:'Admin Teste',posto:'CAP',admin:true};`);
      const r2 = await window.eval(`(async()=>{ const orig=_tvBlock; _tvBlock=()=>true; try{ return await Arquivo.congelar('${kAtual}'); } finally { _tvBlock=orig; } })()`);
      checar('12.10 — membro comum e Modo TV não gravam no arquivo', r1 === false && r2 === false && antes === JSON.stringify(store.spaei.escalaArquivo), JSON.stringify({ r1, r2 }));
    }
    // 12.11 — card: lista semanas, seleção sobrevive a redesenho, botões de ADM só para ADM
    {
      window.eval(`Nav.go('relatorios');`);
      await new Promise(r => setTimeout(r, 120));
      window.eval(`Arquivo._sel.semana='${k3}'; Render.relatorios();`);
      const sel = window.eval(`(()=>{ const s=document.querySelector('#rel-arquivo-escalas select'); return s?s.value:null; })()`);
      const temAdm = window.eval(`/Backup das escalas/.test(document.getElementById('s-relatorios').innerHTML)`);
      window.eval(`Auth.user={rg:'111111',nome:'Fulano',posto:'SD',admin:false}; Render.relatorios();`);
      const semAdm = window.eval(`!/Backup das escalas/.test(document.getElementById('s-relatorios').innerHTML) && !!document.getElementById('rel-arquivo-escalas')`);
      window.eval(`Auth.user={rg:'ADM001',nome:'Admin Teste',posto:'CAP',admin:true};`);
      checar('12.11 — card mostra semana escolhida após redesenho; botões de backup só p/ ADM; membro vê o relatório', sel === k3 && temAdm && semAdm, JSON.stringify({ sel, temAdm, semAdm }));
    }
    // 12.12 — PDF: 1 semana = 1 folha com nota de fonte; período = N folhas, botão de imprimir 1x; relatório antigo segue 1 folha
    {
      const cap = [];
      window.open = () => ({ document: { write: (h) => cap.push(h), close() {} } });
      window.eval(`Arquivo._sel.semana='${k2}'; Arquivo.gerar('PDF');`);
      const h1 = cap.pop();
      window.eval(`Arquivo._sel.de='${k3}'; Arquivo._sel.ate='${k1}'; Arquivo.gerarPeriodo('PDF');`);
      const h2 = cap.pop();
      window.eval(`Render._gerarRel('processos','PDF');`);
      const h3 = cap.pop();
      const n = (h, re) => (h.match(re) || []).length;
      checar('12.12 — PDF de 1 semana: 1 folha, nota "arquivo permanente", 1 botão', n(h1, /class="folha"/g) === 1 && /arquivo permanente/.test(h1) && n(h1, /Imprimir \/ Salvar como PDF/g) === 1, `${n(h1, /class="folha"/g)} folhas`);
      checar('12.13 — PDF do período k3→k1: 3 folhas, botão só na última', n(h2, /class="folha"/g) === 3 && n(h2, /Imprimir \/ Salvar como PDF/g) === 1 && /break-before:page/.test(h2), `${n(h2, /class="folha"/g)} folhas`);
      checar('12.14 — relatório antigo (Processos) continua com 1 folha e 1 botão (sem regressão do _pdfWindow)', !!h3 && n(h3, /class="folha"/g) === 1 && n(h3, /Imprimir \/ Salvar como PDF/g) === 1);
      checar('12.15 — nome com fórmula (=HYPERLINK) sai escapado no HTML do PDF', !/<td>=HYPERLINK\("x"\)/.test(h1) && /&quot;x&quot;|=HYPERLINK/.test(h1));
    }
    // 12.16 — CSV: cabeçalho, injeção de fórmula neutralizada; período concatena semanas
    {
      const baixados = [];
      window.eval(`Arquivo._baixar=(c,m,n)=>{ window.__dl=window.__dl||[]; window.__dl.push({c,m,n}); };`);
      window.eval(`Arquivo._sel.semana='${k2}'; Arquivo.gerar('CSV'); Arquivo._sel.de='${k3}'; Arquivo._sel.ate='${k1}'; Arquivo.gerarPeriodo('CSV');`);
      const dl = window.__dl;
      const c1 = dl[0].c, c2 = dl[1].c;
      checar('12.16 — CSV da semana: cabeçalho, arquivo com a chave, fórmula neutralizada', /^\ufeff"POSTO","RG","NOME","SEMANA"/.test(c1) && dl[0].n === `SPAEI_Escala_${k2}.csv` && /"'=HYPERLINK/.test(c1) && !/,"=HYPERLINK/.test(c1), c1.slice(0, 90));
      checar('12.17 — CSV do período: linhas de 3 semanas (3 militares × 3 + RG saído) ', c2.trim().split('\n').length >= 1 + 3 * 3, `${c2.trim().split('\n').length} linhas`);
    }
    // 12.18 — backup das escalas: formato compatível com restauração, só chaves de FB_KEYS em "dados", legível
    {
      window.eval(`Arquivo._baixar=(c,m,n)=>{ window.__bk={c,m,n}; };`);
      await window.eval(`Arquivo.baixarBackup()`);
      const bk = JSON.parse(window.__bk.c);
      const chaves = Object.keys(bk.dados);
      const fbKeys = JSON.parse(window.eval(`JSON.stringify(FB_KEYS)`));
      checar('12.18 — backup das escalas: dados só com chaves restauráveis (FB_KEYS), inclui arquivo+escala+envios', chaves.length >= 2 && chaves.every(k => fbKeys.includes(k)) && chaves.includes('escalaArquivo') && chaves.includes('escalaSemanas') && /^SPAEI_Backup_Escalas_.*\.json$/.test(window.__bk.n), JSON.stringify(chaves));
      checar('12.19 — backup traz versão legível (semanasLegiveis) e _referencia fora de FB_KEYS', Array.isArray(bk._referencia.semanasLegiveis) && bk._referencia.semanasLegiveis.length >= 3 && !fbKeys.includes('_referencia'));
    }
    // 12.20 — backup geral (manual/automático) já inclui o arquivo; restauração grava de volta
    {
      const snap = JSON.parse(await window.eval(`Backup._gerarSnapshot().then(s=>JSON.stringify(s))`));
      checar('12.20 — Backup._gerarSnapshot inclui escalaArquivo (FB_KEYS)', !!snap.dados.escalaArquivo && !!snap.dados.escalaArquivo[k2]);
      delete store.spaei.escalaArquivo;
      await window.eval(`Backup.restaurar(${JSON.stringify(snap)}).then(n=>n)`);
      await esperarAte(() => store.spaei.escalaArquivo && store.spaei.escalaArquivo[k2]);
      checar('12.21 — restauração recoloca o arquivo de escalas no banco', !!(store.spaei.escalaArquivo && store.spaei.escalaArquivo[k2] && store.spaei.escalaArquivo[k3]));
    }
    // 12.22 — sincronizar traz semana arquivada por OUTRO aparelho sem apagar o local
    {
      store.spaei.escalaArquivo['2026-W20'] = { chave:'2026-W20', label:'x', linhas:[{rg:'1',posto:'SD',nome:'Remoto',funcao:'',chefe:false,foraEfetivo:false,st:['SERVIÇO','SERVIÇO','SERVIÇO','SERVIÇO','SERVIÇO','FOLGA','FOLGA']}], congeladoEm:new Date().toISOString(), origem:'automatico', versao:'6.90', de:'11/05/2026', ate:'17/05/2026' };
      const mudou = await window.eval(`Arquivo.sincronizar(true)`);
      const tem = window.eval(`!!(DB.get('escalaArquivo')['2026-W20'] && DB.get('escalaArquivo')['${k2}'])`);
      checar('12.22 — sincronizar soma a semana remota e preserva as locais', mudou === true && tem === true);
    }
    // 12.24 — seletores do card usam a classe do app (tema) e o período aparece ESCRITO (v6.91)
    {
      window.eval(`Auth.user={rg:'ADM001',nome:'Admin Teste',posto:'CAP',admin:true}; Arquivo._sel.de='${k3}'; Arquivo._sel.ate='${k1}'; Nav.go('relatorios'); Render.relatorios();`);
      await new Promise(r => setTimeout(r, 100));
      const r = JSON.parse(window.eval(`JSON.stringify({
        sels:[...document.querySelectorAll('#rel-arquivo-escalas select')].map(s=>({cls:s.className,style:s.getAttribute('style')||''})),
        resumo:(document.getElementById('arq-resumo')||{}).textContent||'',
        rotulos:/>DE</.test(document.getElementById('rel-arquivo-escalas').innerHTML)&&/>ATÉ</.test(document.getElementById('rel-arquivo-escalas').innerHTML)})`));
      checar('12.24 — 3 seletores com classe form-sel (tema), sem cor inventada; rótulos DE/ATÉ', r.sels.length === 3 && r.sels.every(x => /form-sel/.test(x.cls) && !/--surface|background/.test(x.style)) && r.rotulos, JSON.stringify(r.sels));
      checar('12.25 — período escrito por extenso com nº de semanas', /^📅 Período: .+ até .+ · 3 semana\(s\)$/.test(r.resumo), r.resumo);
      window.eval(`Arquivo._sel.de='${k1}'; Arquivo._sel.ate='${k3}'; Arquivo._atualizaResumo();`);
      const inv = window.eval(`document.getElementById('arq-resumo').textContent`);
      checar('12.26 — De/Até invertidos: texto avisa e o resumo atualiza ao trocar', /3 semana\(s\) \(De\/Até invertidos/.test(inv), inv);
    }
    checar('12.23 — zero erro JS não tratado no grupo 12', errosJs.length === 0, errosJs.join(' | '));
  }

  // ───────────────────────────────────────────────────────────
  // GRUPO 13 — Vínculo SEI DIGITAL COE → SPAEI (v6.92). Antes: o listener
  // de /spaei-digital/sei-processos não tinha callback de erro — se o
  // Firebase o cancelasse (ex.: permission_denied) ele morria PARA SEMPRE
  // e os processos do SEI paravam de chegar sem nenhum aviso na tela.
  // ───────────────────────────────────────────────────────────
  {
    const { window, store, errosJs } = await bootApp();
    const esperarAte = async (cond, max = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { try { if (cond()) return true; } catch (e) {} await new Promise(r => setTimeout(r, 25)); } return false; };
    store['spaei-digital'] = { 'sei-processos': {
      A1: { numero:'SEI-1', descricao:'Processo A', status:'Em Andamento', urgencia:'Alta', responsaveis:['SGT Gumiero','SGT Thiago'], atualizadoEm:1790000000000 },
      A2: { numero:'SEI-2', descricao:'Processo B', status:'Finalizado', responsaveis:{ '0':'SGT Aleixo', '2':'CAP Flávio' }, atualizadoEm:1791000000000 },
      A3: { numero:'SEI-3', descricao:'Processo C', status:'Aguardando' },
    } };
    window.eval(`Auth.user={rg:'ADM001',nome:'Admin Teste',posto:'CAP',admin:true}; _fbOk=true; _fbSynced=true; DB._listenRealtime(); _fbOk=true;`);
    await esperarAte(() => window.eval(`getSeiProcs().length`) === 3);
    const st = JSON.parse(window.eval(`JSON.stringify(_seiLink)`));
    checar('13.1 — vínculo registra qtd recebida, último envio e zero erro', st.recebidos === 3 && st.ultimoEnvio === 1791000000000 && st.erro === null, JSON.stringify(st));
    const resp = window.eval(`getSeiProcs().map(p=>p.resp).join(' | ')`);
    checar('13.2 — responsáveis em formato array E objeto esparso (RTDB) não quebram o listener', resp === 'SGT Gumiero, SGT Thiago | SGT Aleixo, CAP Flávio | —', resp);
    window.eval(`Nav.go('processos'); Render.processos();`);
    const linha = window.eval(`document.getElementById('s-processos').textContent`);
    checar('13.3 — tela de Processos mostra a linha de status do vínculo', /Vínculo SEI DIGITAL: 3 processo\(s\) recebido\(s\)/.test(linha), linha.slice(0, 160));
    window.eval(`_seiLinkFalhou({code:'PERMISSION_DENIED'}); clearTimeout(_seiLinkRetry);`);
    const aviso = window.eval(`document.getElementById('s-processos').textContent`);
    checar('13.4 — listener cancelado (permission_denied) mostra AVISO na tela de Processos', /Vínculo com o SEI DIGITAL COE indisponível \(PERMISSION_DENIED\)/.test(aviso), aviso.slice(0, 160));
    window.eval(`_listenSeiProcessos(); Render.processos();`);
    await esperarAte(() => window.eval(`_seiLink.erro`) === null);
    const ok = window.eval(`document.getElementById('s-processos').textContent`);
    checar('13.5 — reanexar o listener limpa o aviso e volta a mostrar o status', window.eval(`_seiLink.erro`) === null && !/indisponível/.test(ok) && /3 processo\(s\) recebido\(s\)/.test(ok));
    checar('13.6 — zero erro JS não tratado no grupo 13', errosJs.length === 0, errosJs.join(' | '));
  }

  // ───────────────────────────────────────────────────────────
  // GRUPO 14 — Sync SEI↔SPAEI (v6.93): notificação reivindicada por transação
  // (2+ aparelhos não enviam em dobro), execuções coalescidas, render coalescido
  // e movimentação que chega à base do SEI mesmo SEM cache local.
  // ───────────────────────────────────────────────────────────
  {
    const { window, store, errosJs } = await bootApp();
    const esperarAte = async (cond, max = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < max) { try { if (cond()) return true; } catch (e) {} await new Promise(r => setTimeout(r, 25)); } return false; };
    window.eval(`Auth.user={rg:'ADM001',nome:'Admin Teste',posto:'CAP',admin:true}; _fbOk=true; _fbSynced=true;`);
    const a = await window.eval(`_reivindicarNotif('spaei/teste/k1','ST1')`);
    const b = await window.eval(`_reivindicarNotif('spaei/teste/k1','ST1')`);
    const c = await window.eval(`_reivindicarNotif('spaei/teste/k1','ST2')`);
    checar('14.1 — reivindicação: 1º aparelho leva, 2º (mesmo estado) não, novo estado leva', a === true && b === false && c === true, [a, b, c].join(','));
    // 5 aparelhos "simultâneos" reivindicando a mesma notificação: só 1 vence
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => window.eval(`_reivindicarNotif('spaei/teste/k2','X')`)));
    checar('14.2 — 5 reivindicações simultâneas: exatamente 1 vence', rs.filter(Boolean).length === 1, rs.join(','));
    // coalescência: rajada de chamadas → uma única mensagem
    store.spaei = store.spaei || {};
    store.spaei.telegramVinculos = { '111111': { chatId: 1 } };
    window.eval(`
      DB.set('efetivo',[{rg:'111111',nome:'Fulano Gumiero',posto:'SGT',chefe:false}],'seed');
      _mem['sei_processos']=[{id:'SEI-P1',numero:'S1',assunto:'a',resp:'SGT Gumiero',status:'EM ANDAMENTO',prazo:'—'}];
      window.__env=0; _telegramNotificar=function(){ window.__env++; };
    `);
    await Promise.all([1, 2, 3, 4, 5, 6].map(() => window.eval(`_sincronizarNotificacoesProcessos()`)));
    await new Promise(r => setTimeout(r, 100));
    const env = window.eval(`window.__env`);
    checar('14.3 — rajada de 6 chamadas gera 1 única notificação', env === 1, env);
    window.eval(`window.__env=0`);
    await window.eval(`_sincronizarNotificacoesProcessos()`);
    checar('14.4 — mesmo estado de novo: não reenvia', window.eval(`window.__env`) === 0);
    // render coalescido
    window.eval(`window.__r=0; Nav.go('processos'); Render.processos=function(){window.__r++;};`);
    await new Promise(r => setTimeout(r, 120));
    window.eval(`window.__r=0; for(let i=0;i<10;i++) _renderSeiAgendado();`);
    await new Promise(r => setTimeout(r, 200));
    checar('14.5 — 10 eventos seguidos do listener = 1 render', window.eval(`window.__r`) === 1, window.eval(`window.__r`));
    checar('14.6 — zero erro JS não tratado no grupo 14', errosJs.length === 0, errosJs.join(' | '));
  }

  // ───────────────────────────────────────────────────────────
  // GRUPO 15 — Painel de Férias (v6.94): marcação pelo próprio policial,
  // dias calculados, sobreposição, gravação por RG, KPIs, relatórios.
  // ───────────────────────────────────────────────────────────
  {
    const { window, store, errosJs } = await bootApp();
    const espera = ms => new Promise(r => setTimeout(r, ms));
    window.eval(`
      DB.set('efetivo', [
        {rg:'111111', nome:'Fulano Alfa', posto:'SGT', funcao:'PROJETOS', chefe:false, admin:false},
        {rg:'222222', nome:'Beltrano Beta', posto:'CB', funcao:'PROJETOS', chefe:false, admin:false},
        {rg:'333333', nome:'Ciclano Gama', posto:'SD', funcao:'OPERAÇÕES', chefe:false, admin:false},
        {rg:'444444', nome:'Admin Delta', posto:'CAP', funcao:'CHEFIA', chefe:false, admin:true},
      ], 'seed');
      Auth.user = {rg:'111111', nome:'Fulano Alfa', posto:'SGT', admin:false};
      _fbOk = true; _fbSynced = true;
    `);
    await espera(50);
    // matemática de datas
    checar('15.1 — dias = fim - início + 1 (inclusivo) e retorno no dia seguinte', window.eval(`Ferias.dias('2026-11-03','2026-11-17')`) === 15 && window.eval(`Ferias._iso(Ferias._n('2026-12-31')+1)`) === '2027-01-01');
    checar('15.2 — data inválida (31/02) rejeitada', isNaN(window.eval(`Ferias._n('2026-02-31')`)));
    // abre o modal, preenche início + dias, confere fim calculado
    window.eval(`Nav.go('ferias'); Ferias.abrirModal();`);
    window.eval(`document.getElementById('fx-ini').value='2026-11-03'; document.getElementById('fx-dias').value='15'; Ferias._calc('dias');`);
    checar('15.3 — início + dias calcula o fim', window.eval(`document.getElementById('fx-fim').value`) === '2026-11-17', window.eval(`document.getElementById('fx-fim').value`));
    window.eval(`document.getElementById('fx-fim').value='2026-11-10'; Ferias._calc('fim');`);
    checar('15.4 — alterar o fim recalcula os dias', window.eval(`document.getElementById('fx-dias').value`) === '8');
    window.eval(`document.getElementById('fx-fim').value='2026-11-17'; Ferias._calc('fim'); Ferias.salvar();`);
    await espera(120);
    const ramo = store.spaei && store.spaei.ferias && store.spaei.ferias['111111'];
    const per = ramo && Object.values(ramo)[0];
    checar('15.5 — grava só no ramo do próprio RG (spaei/ferias/RG/id)', !!per && per.ini === '2026-11-03' && per.fim === '2026-11-17' && per.dias === 15, JSON.stringify(per));
    // sobreposição própria é bloqueada
    window.eval(`Ferias.abrirModal(); document.getElementById('fx-ini').value='2026-11-10'; document.getElementById('fx-dias').value='5'; Ferias._calc('dias'); Ferias.salvar();`);
    await espera(80);
    checar('15.6 — período sobreposto ao próprio é recusado', Object.keys(store.spaei.ferias['111111']).length === 1);
    // outro membro não consegue mexer nas férias alheias
    window.eval(`Ferias.excluir('222222','x')`);
    const podeOutro = window.eval(`Ferias.podeEditar('222222')`);
    checar('15.7 — membro não edita férias de outro; admin edita', podeOutro === false && window.eval(`(Auth.user.admin=true, Ferias.podeEditar('222222'))`) === true);
    window.eval(`Auth.user.admin=false;`);
    // dois militares marcam: coincidência detectada e KPIs
    window.eval(`Auth.user={rg:'222222',nome:'Beltrano Beta',posto:'CB',admin:false}; Ferias.abrirModal(); document.getElementById('fx-ini').value='2026-11-10'; document.getElementById('fx-dias').value='10'; Ferias._calc('dias');`);
    const prev = window.eval(`document.getElementById('fx-prev').textContent`);
    checar('15.8 — pré-visualização avisa colega em férias no mesmo intervalo', /Fulano Alfa/.test(prev), prev.slice(0, 160));
    window.eval(`Ferias.salvar();`);
    await espera(120);
    checar('15.9 — ramos separados por RG (sem pisar um no outro)', !!store.spaei.ferias['222222'] && !!store.spaei.ferias['111111'] && Object.keys(store.spaei.ferias).length === 2);
    // renderização completa sem erro e com conteúdo
    window.eval(`Ferias.ano=2026; Ferias.render();`);
    const html = window.eval(`document.getElementById('s-ferias').innerHTML`);
    checar('15.10 — painel renderiza KPIs, mapa de calor e linha do tempo', /PAINEL DE FÉRIAS/.test(html) && /fx-hm-c/.test(html) && /fx-bar/.test(html) && /Fulano Alfa/.test(html));
    checar('15.11 — XSS: nome/obs com HTML viram texto', (() => { window.eval(`DB.get('efetivo')[2].nome='<img src=x onerror=alert(1)>'; Ferias.render();`); const h = window.eval(`document.getElementById('s-ferias').innerHTML`); return !/<img src=x/.test(h); })());
    // relatórios
    const nom = window.eval(`JSON.stringify(Ferias._dadosRel('nominal'))`), resumo = window.eval(`JSON.stringify(Ferias._dadosRel('resumo'))`), mensal = window.eval(`JSON.stringify(Ferias._dadosRel('mensal'))`);
    const rn = JSON.parse(nom), rr = JSON.parse(resumo), rm = JSON.parse(mensal);
    checar('15.12 — relação nominal tem os 2 períodos com dias corretos', rn.rows.length === 2 && rn.rows.some(r => r[7] === 15) && rn.rows.some(r => r[7] === 10) && rn.rows.every(r => r[4] === 2026), JSON.stringify(rn.rows.map(r => r.slice(1, 8))));
    checar('15.13 — resumo por militar: saldo e "Sem marcação"', rr.rows.filter(r => r[4] === 2026).length === 4 && rr.rows.find(r => r[1] === 'Fulano Alfa' && r[4] === 2026)[7] === 15 && rr.rows.filter(r => r[4] === 2026 && r[9] === 'Sem marcação').length === 2, JSON.stringify(rr.rows.slice(0, 2)));
    checar('15.14 — mensal: novembro com 2 militares e pico simultâneo 2', rm.rows[10][1] === 2 && rm.rows[10][3] === 2 && rm.rows[10][2] === 25, JSON.stringify(rm.rows[10]));
    // exclusão
    window.eval(`Auth.user={rg:'111111',nome:'Fulano Alfa',posto:'SGT',admin:false}; window.confirm=()=>true;`);
    const idF = Object.keys(store.spaei.ferias['111111'])[0];
    window.eval(`Ferias.excluir('111111','${idF}')`);
    await espera(120);
    checar('15.15 — excluir remove o ramo do RG no banco', !(store.spaei.ferias && store.spaei.ferias['111111']) && !!store.spaei.ferias['222222']);
    // sugestão de melhor janela evita quem já está fora
    window.eval(`Auth.user={rg:'333333',nome:'x',posto:'SD',admin:false}; Ferias.abrirModal(); document.getElementById('fx-dias').value='5'; Ferias._sugerir();`);
    const ini = window.eval(`document.getElementById('fx-ini').value`);
    checar('15.16 — sugestão preenche início com janela de menor concentração', /^\d{4}-\d{2}-\d{2}$/.test(ini) && window.eval(`document.getElementById('fx-fim').value`) !== '', ini);
    // ── ano de referência (exercício) ≠ ano de gozo ──
    window.eval(`Auth.user={rg:'333333',nome:'Ciclano Gama',posto:'SD',admin:false}; DB.set('ferias',{},'x');`);
    window.eval(`Ferias.abrirModal(); document.getElementById('fx-ini').value='2027-01-11'; document.getElementById('fx-dias').value='15'; Ferias._calc('dias');`);
    checar('15.18 — sem histórico, exercício sugerido = ano atual (limite: não pode ser posterior ao ano corrente)', window.eval(`document.getElementById('fx-ref').value`) === String(window.eval(`Ferias.hojeAno()`)), window.eval(`document.getElementById('fx-ref').value`));
    // 15 dias do exercício 2026 gozados em 2027
    window.eval(`document.getElementById('fx-ref').value='2026'; Ferias._refManual(); Ferias.salvar();`);
    await espera(120);
    let pp = Object.values(store.spaei.ferias['333333'])[0];
    checar('15.19 — grava ref=2026 em período gozado em 2027', pp.ref === 2026 && pp.ini === '2027-01-11', JSON.stringify(pp));
    checar('15.20 — saldo do exercício 2026 = 15 dias marcados (de 30)', window.eval(`Ferias._diasRef('333333',2026)`) === 15 && window.eval(`Ferias._diasRef('333333',2027)`) === 0);
    // exercício 2026 iniciado e incompleto → próxima marcação sugere 2026 (mesmo gozada em 2027, a menos que seja de 2027)
    window.eval(`Ferias.abrirModal(); document.getElementById('fx-ini').value='2027-06-07'; document.getElementById('fx-dias').value='15'; Ferias._calc('dias');`);
    checar('15.21 — exercício anterior incompleto é sugerido para completar', window.eval(`document.getElementById('fx-ref').value`) === '2026', window.eval(`document.getElementById('fx-ref').value`));
    checar('15.22 — pré-visualização mostra saldo do exercício e gozo em ano posterior', /Exercício 2026/.test(window.eval(`document.getElementById('fx-prev').textContent`)) && /30\/30/.test(window.eval(`document.getElementById('fx-prev').textContent`)));
    window.eval(`Ferias.salvar();`);
    await espera(120);
    checar('15.23 — exercício 2026 fecha em 30/30 com 2 períodos gozados em 2027', window.eval(`Ferias._diasRef('333333',2026)`) === 30 && Object.keys(store.spaei.ferias['333333']).length === 2);
    // referência posterior ao ano de início é recusada
    window.eval(`Ferias.abrirModal(); document.getElementById('fx-ini').value='2026-11-30'; document.getElementById('fx-dias').value='3'; Ferias._calc('dias'); document.getElementById('fx-ref').value='2027'; document.getElementById('fx-ref').value; Ferias.salvar();`);
    await espera(60);
    checar('15.24 — referência > ano de início não é aceita', Object.keys(store.spaei.ferias['333333']).length === 2);
    // relatório de saldo por exercício e filtro
    const rs = JSON.parse(window.eval(`Ferias.ano=2027; JSON.stringify(Ferias._dadosRel('resumo'))`));
    const lc = rs.rows.find(r => r[2] === '333333' && r[4] === 2026);
    checar('15.25 — relatório "Saldo por exercício": 30/30, saldo 0, gozo em 2027, Completo', lc && lc[6] === 30 && lc[7] === 0 && lc[8] === '2027' && lc[9] === 'Completo', JSON.stringify(lc));
    window.eval(`Ferias.setRef('2025'); Ferias.ano=2027;`);
    checar('15.26 — filtro de exercício esvazia a relação nominal quando não há período dessa referência', JSON.parse(window.eval(`JSON.stringify(Ferias._dadosRel('nominal'))`)).rows.length === 0);
    window.eval(`Ferias.setRef(''); Ferias.render();`);
    checar('15.27 — "Minhas férias" mostra o exercício 2026 completo', /Ref\. 2026/.test(window.eval(`document.getElementById('s-ferias').textContent`)) && /30\/30/.test(window.eval(`document.getElementById('s-ferias').textContent`)));
    checar('15.17 — zero erro JS não tratado no grupo 15', errosJs.length === 0, errosJs.join(' | '));
  }

  const falhas = resultados.filter(r => !r).length;
  console.log('');
  console.log(falhas === 0 ? `=== TODOS OS ${resultados.length} TESTES PASSARAM ===` : `=== ${falhas} DE ${resultados.length} TESTE(S) FALHARAM ===`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch(e => { console.error('ERRO FATAL NA SUITE:', e); process.exit(1); });
