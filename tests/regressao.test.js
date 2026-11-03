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

  // ───────────────────────────────────────────────────────────
  // GRUPO 16 — Processos com VÁRIOS responsáveis (v6.96): cada pessoa conta os
  // processos compartilhados (antes só contava onde era a única responsável).
  // ───────────────────────────────────────────────────────────
  {
    const { window, errosJs } = await bootApp();
    const espera = ms => new Promise(r => setTimeout(r, ms));
    window.eval(`
      DB.set('efetivo', [
        {rg:'82061', nome:'ELOMIR GUMIERO DE MORAES', posto:'2º SGT PM', funcao:'PROJETOS', chefe:false, admin:false},
        {rg:'90001', nome:'THIAGO SOUZA LIMA', posto:'SGT PM', funcao:'PROJETOS', chefe:false, admin:false},
      ], 'seed');
      DB.set('processos', [], 'seed');
      Auth.user = {rg:'82061', nome:'ELOMIR GUMIERO DE MORAES', posto:'2º SGT PM', admin:false};
      _fbOk = true; _fbSynced = true;
      const mk=(i,resp,st)=>({id:'SEI-p'+i,numero:'N'+i,assunto:'a'+i,resp,status:st||'EM ANDAMENTO',prazo:'—',prio:'MÉDIA'});
      _mem['sei_processos']=[
        mk(1,'SGT Gumiero'),mk(2,'SGT Gumiero'),mk(3,'SGT Gumiero','CONCLUÍDO'),
        mk(4,'SGT Gumiero, SGT Thiago'),mk(5,'SGT Thiago, SGT Gumiero'),mk(6,'SGT Gumiero,SGT Thiago, SGT Gumiero'),
        mk(7,'SGT Thiago'),mk(8,'')
      ];
    `);
    await espera(50);
    checar('16.1 — _respNomes separa por vírgula, tira espaços/duplicatas e vazio vira —', JSON.stringify(window.eval(`[_respNomes({resp:'SGT Gumiero, SGT Thiago'}),_respNomes({resp:'SGT Gumiero,SGT Thiago, SGT Gumiero'}),_respNomes({resp:''})]`)) === '[["SGT Gumiero","SGT Thiago"],["SGT Gumiero","SGT Thiago"],["—"]]');
    const rows = JSON.parse(window.eval(`JSON.stringify(Render._relDadosBI('produtividade'))`) || 'null');
    const g = rows && rows.rows.find(r => r[1] === '82061');
    const t = rows && rows.rows.find(r => r[1] === '90001');
    checar('16.2 — produtividade: Gumiero conta 6 (3 sozinho + 3 compartilhados), não só os sozinho', g && g[3] === 6, JSON.stringify(g));
    checar('16.3 — produtividade: Thiago conta 4 (1 sozinho + 3 compartilhados)', t && t[3] === 4, JSON.stringify(t));
    window.eval(`Render.dashboard()`);
    const dash = window.document.getElementById('s-dashboard').textContent.replace(/\s+/g, ' ');
    checar('16.4 — dashboard "Processos por Responsável": Gumiero 6 total / 5 ativos', /SGT Gumiero 5 ativo\(s\) · 6 total/.test(dash), dash.slice(dash.indexOf('Processos por Responsável'), dash.indexOf('Processos por Responsável') + 200));
    checar('16.5 — dashboard não cria "grupos" com nomes juntados por vírgula', !/SGT Gumiero, SGT Thiago/.test(dash) && !/SGT Thiago, SGT Gumiero/.test(dash));
    window.eval(`Drawer.open('procresp','SGT Gumiero')`);
    const drw = window.document.body.textContent.replace(/\s+/g, ' ');
    checar('16.6 — gaveta do responsável lista os 6 (5 ativos, 1 concluído)', /Ativos: 5/.test(drw) && /Concluídos: 1/.test(drw));
    checar('16.7 — zero erro JS não tratado no grupo 16', errosJs.length === 0, errosJs.join(' | '));
  }


  // ───────────────────────────────────────────────────────────
  // GRUPO 17 — Planejamento COE (v6.97): equipes das unidades, processos SEI,
  // painel, alertas, relatórios, auditoria, permissões e segurança de interface.
  // ───────────────────────────────────────────────────────────
  {
    const { window, store, errosJs } = await bootApp();
    const espera = ms => new Promise(r => setTimeout(r, ms));
    const ev = c => window.eval(c);
    const J = c => JSON.parse(window.eval(`JSON.stringify(${c})`));
    window.eval(`
      DB.set('efetivo', [{rg:'82061', nome:'ELOMIR GUMIERO DE MORAES', posto:'2º SGT PM', chefe:false, admin:true}], 'seed');
      Auth.user = {rg:'82061', nome:'ELOMIR GUMIERO DE MORAES', posto:'2º SGT PM', admin:true};
      _fbOk = true; _fbSynced = true;
      window.__addDias = (n)=>{ const d=new Date(Plan._n(Plan._hoje())*86400000 + n*86400000); return d.toISOString().slice(0,10); };
    `);
    await espera(50);
    const efetivoAntes = JSON.stringify(ev(`DB.get('efetivo')`));
    const processosAntes = JSON.stringify(ev(`DB.get('processos')`));

    checar('17.1 — versão 7.00 e módulo registrado na navegação', ev(`APP_VERSAO`) === '7.00' && ev(`NAV_ITEMS.some(n=>n.id==='planejamento')`) && ev(`typeof Render.planejamento`) === 'function');
    ev(`buildNav()`);
    checar('17.2 — menu lateral tem o botão "Equipe de Planejamento das Unidades Subordinadas"', /Equipe de Planejamento das Unidades Subordinadas/.test(window.document.getElementById('sb-nav').textContent));

    // estado inicial: sem dados fictícios
    ev(`Nav.go('planejamento')`); await espera(30);
    let txt = window.document.getElementById('s-planejamento').textContent;
    checar('17.3 — estado inicial vazio, sem dado inventado (oferece criar as 6 unidades)', /Nenhuma unidade cadastrada/.test(txt) && ev(`Plan.unidades().length`) === 0 && ev(`Plan.processos().length`) === 0);
    checar('17.4 — inicializarUnidades cria exatamente as 6 siglas, sem nome inventado, e é idempotente', ev(`Plan.inicializarUnidades()`) === 6 && ev(`Plan.inicializarUnidades()`) === 0
      && JSON.stringify(ev(`Plan.unidades().map(u=>u.sigla)`)) === '["CHOQUE","BOPE","BAC","GAM","CIEsPP","BTM"]' && ev(`Plan.unidades().every(u=>u.nome==='')`));

    // permissões: consulta não grava
    ev(`Auth.user = {rg:'90001', nome:'CONSULTA', posto:'SD', admin:false}`);
    await espera(150);
    const rNeg = J(`Plan.salvarUnidade({sigla:'XYZ'})`);
    await espera(60);
    const nPlanUnid = Object.keys(store.spaei.planUnid || {}).length;
    checar('17.5 — perfil sem administração: gravação recusada na função (não só escondida na tela)', rNeg.ok === false && ev(`Plan.unidades().length`) === 6 && nPlanUnid === 6
      && J(`Plan.salvarMembro({unidadeId:'1',papel:'chefe',posto:'CAP',nome:'X',idFuncional:'1'})`).ok === false && J(`Plan.salvarProcesso({sei:'1'})`).ok === false);
    ev(`Nav.go('planejamento')`);
    checar('17.6 — perfil de consulta não vê botões de edição nem a aba Configurações', !/Novo processo|Editar unidade|Configurações/.test(window.document.getElementById('s-planejamento').textContent));
    ev(`Auth.user = {rg:'82061', nome:'ELOMIR GUMIERO DE MORAES', posto:'2º SGT PM', admin:true}`);

    // integrantes: validação
    const m0 = (o) => JSON.stringify(Object.assign({unidadeId:'1',papel:'chefe',posto:'MAJ PM',nome:'CHEFE UM',idFuncional:'111111',cpf:'',tel:'(21) 99999-0001',email:'chefe@exemplo.org',designadoEm:'2026-01-10'}, o||{}));
    checar('17.7 — integrante sem posto/nome/ID é recusado com mensagens', J(`Plan.salvarMembro(${m0({posto:'',nome:'',idFuncional:''})})`).ok === false && J(`Plan.salvarMembro(${m0({posto:'',nome:'',idFuncional:''})})`).erros.length >= 3);
    checar('17.8 — CPF inválido recusado; e-mail e telefone inválidos recusados', J(`Plan.salvarMembro(${m0({cpf:'111.111.111-11'})})`).ok === false && J(`Plan.salvarMembro(${m0({email:'sem-arroba'})})`).ok === false && J(`Plan.salvarMembro(${m0({tel:'123'})})`).ok === false);
    const rCh = J(`Plan.salvarMembro(${m0({cpf:'529.982.247-25'})})`);
    checar('17.9 — chefe válido salvo; CPF gravado SOMENTE mascarado (nunca completo no banco)', rCh.ok === true && /\*\*\*\.982\.247-\*\*/.test(ev(`Plan.membro('${rCh.id}').cpfMask`)) && !JSON.stringify(store).includes('52998224725') && !JSON.stringify(store).includes('529.982.247-25') && ev(`Plan.membro('${rCh.id}').cpf`) === undefined);
    checar('17.10 — ID funcional duplicado recusado', J(`Plan.salvarMembro(${m0({nome:'OUTRO',papel:'auxiliar',funcao:'Apoio'})})`).ok === false);
    checar('17.11 — segundo chefe na mesma unidade recusado (chefe único)', J(`Plan.salvarMembro(${m0({nome:'SEGUNDO CHEFE',idFuncional:'222222'})})`).ok === false);

    // auxiliares ilimitados + promoção + saída + exclusão lógica
    const aux = (n, o) => JSON.stringify(Object.assign({unidadeId:'1',papel:'auxiliar',posto:'SGT PM',nome:'AUX '+n,idFuncional:String(300000+n),tel:'(21) 98888-'+String(1000+n),funcao:'Planejamento',ingressoEm:'2026-02-01'}, o||{}));
    const ids = [];
    for (let i = 1; i <= 62; i++) { const r = J(`Plan.salvarMembro(${aux(i)})`); if (r.ok) ids.push(r.id); }
    await espera(80);
    checar('17.12 — equipe com mais de 60 auxiliares: todos salvos (sem limite) e gravados por id no banco', ids.length === 62 && Object.keys(store.spaei.planMemb).length === 63, Object.keys(store.spaei.planMemb).length);
    const idAux1 = ids[0], idChefe = rCh.id;
    checar('17.13 — promover auxiliar a chefe troca os papéis sem apagar ninguém', J(`Plan.promoverChefe('${idAux1}')`).ok === true && ev(`Plan.chefe('1').id`) === idAux1 && ev(`Plan.membro('${idChefe}').papel`) === 'auxiliar' && ev(`Plan.membros('1').filter(m=>m.papel==='chefe').length`) === 1);
    checar('17.14 — saída da equipe preserva o cadastro e o histórico', J(`Plan.registrarSaida('${ids[1]}','2026-05-01','Transferência')`).ok === true && ev(`Plan.membro('${ids[1]}').ativo`) === false && ev(`Plan.membros('1',true).some(m=>m.id==='${ids[1]}')`) && ev(`Object.values(Plan._map('planHist')).some(h=>h.registroId==='${ids[1]}'&&/sa[ií]da/i.test(h.acao))`));
    const _e1 = J(`Plan.excluirMembro('${ids[2]}')`).ok === true && !ev(`Plan.membros('1').some(m=>m.id==='${ids[2]}')`);
    await espera(100);
    const _e2 = store.spaei.planMemb[ids[2]].excluido === true;
    const _e3 = J(`Plan.restaurarMembro('${ids[2]}')`).ok === true && ev(`Plan.membros('1').some(m=>m.id==='${ids[2]}')`);
    checar('17.15 — exclusão é lógica: some das listas, permanece no banco e pode ser restaurada', _e1 && _e2 && _e3, [_e1,_e2,_e3].join(','));
    checar('17.16 — reordenar auxiliares funciona e não mexe no chefe', J(`Plan.moverMembro('${ids[4]}',-1)`).ok === true && ev(`Plan.chefe('1').id`) === idAux1);

    // processos
    const pr = (o) => JSON.stringify(Object.assign({sei:'SEI-330001/000123/2026',unidadeId:'1',demandante:'Seção X',categoriaId:'c01',objeto:'Aquisição de material de teste',descricao:'',statusId:'s01',respPrincipalId:idChefe,envolvidos:[],abertura:'2026-03-01',inclusaoSpaei:'2026-03-02',proxProv:'Enviar ao setor',prazo:window.eval('__addDias(30)'),pendencias:'',link:''}, o||{}));
    checar('17.17 — processo inválido: sem SEI/objeto/categoria, prazo antes da abertura, link não http(s)', J(`Plan.salvarProcesso(${pr({sei:'',objeto:'',categoriaId:''})})`).ok === false && J(`Plan.salvarProcesso(${pr({prazo:'2026-01-01'})})`).ok === false && J(`Plan.salvarProcesso(${pr({link:'javascript:alert(1)'})})`).ok === false);
    const p1 = J(`Plan.salvarProcesso(${pr({})})`);
    checar('17.18 — processo válido salvo; SEI duplicado (mesmos dígitos, outro formato) recusado', p1.ok === true && J(`Plan.salvarProcesso(${pr({sei:'330001/000123/2026'})})`).ok === false);
    ev(`Plan.salvarProcesso(${pr({sei:'SEI-330002/000001/2026',objeto:'Obra teste',categoriaId:'c04',statusId:'s13',prazo:''})})`);
    ev(`Plan.salvarProcesso(${pr({sei:'SEI-330003/000001/2026',objeto:'Suspenso teste',statusId:'s12'})})`);
    await espera(50);
    let st = J(`Plan.stats()`);
    checar('17.19 — indicadores calculados dos registros reais (3 processos: 1 andamento, 1 concluído, 1 suspenso)', st.processos === 3 && st.andamento === 1 && st.concluidos === 1 && st.suspensos === 1 && st.policiais === 62 && st.chefes === 1 && st.auxiliares === 61, JSON.stringify({p:st.processos,a:st.andamento,c:st.concluidos,s:st.suspensos,pol:st.policiais}));
    ev(`Plan.salvarProcesso(${pr({statusId:'s13'})}, '${p1.id}')`);
    st = J(`Plan.stats()`);
    checar('17.20 — concluir um processo atualiza os indicadores e grava a data de conclusão', st.andamento === 0 && st.concluidos === 2 && /^\d{4}-\d{2}-\d{2}$/.test(ev(`Plan.processo('${p1.id}').concluidoEm`)));
    const hProc = J(`Object.values(Plan._map('planHist')).filter(h=>h.registroId==='${p1.id}'&&h.acao==='editou')`);
    checar('17.21 — histórico guarda quem, quando, unidade e valores ANTES/DEPOIS', hProc.length === 1 && hProc[0].autorNome === 'ELOMIR GUMIERO DE MORAES' && !!hProc[0].ts && hProc[0].unidadeSigla === 'CHOQUE' && hProc[0].mudancas.some(m => m.campo === 'Fase atual' && m.antes === 'Em planejamento' && m.depois === 'Concluído'), JSON.stringify(hProc[0] && hProc[0].mudancas));
const _x1 = J(`Plan.excluirProcesso('${p1.id}')`).ok && ev(`Plan.processos().length`) === 2;
    await espera(100);
    const _x2 = store.spaei.planProc[p1.id].excluido === true;
    const _x3 = J(`Plan.restaurarProcesso('${p1.id}')`).ok && ev(`Plan.processos().length`) === 3;
    checar('17.22 — exclusão lógica de processo + restauração, com histórico', _x1 && _x2 && _x3, [_x1,_x2,_x3].join(','));

    // alertas
    const pa = J(`Plan.salvarProcesso(${pr({sei:'SEI-330009/000001/2026',objeto:'Alerta teste',statusId:'s06',prazo:window.eval('__addDias(3)'),pendencias:'Falta parecer'})})`);
    const setDias = (id, n) => ev(`(function(){ const p=Plan.processo('${id}'); Plan._gravar('planProc','${id}',{...p,atualizadoEmData:__addDias(${-n})},'t'); })()`);
    setDias(pa.id, 20);
    let al = J(`Plan.alertasProcesso(Plan.processo('${pa.id}'))`);
    checar('17.23 — 20 dias sem atualização: 1º alerta sim, 2º não; prazo próximo; pendência', al.sem1 === true && al.sem2 === false && al.prazoProximo === true && al.comPendencia === true && ev(`Plan.rotuloAtualizacao(Plan.alertasProcesso(Plan.processo('${pa.id}')))`) === 'Necessita atualização');
    setDias(pa.id, 40);
    al = J(`Plan.alertasProcesso(Plan.processo('${pa.id}'))`);
    checar('17.24 — 40 dias sem atualização dispara o 2º alerta', al.sem1 === true && al.sem2 === true);
    setDias(pa.id, 5);
    checar('17.25 — 5 dias: sem alerta de atualização', J(`Plan.alertasProcesso(Plan.processo('${pa.id}'))`).sem1 === false);
    ev(`Plan._gravar('planProc','${pa.id}',{...Plan.processo('${pa.id}'),prazo:__addDias(-2)},'t')`);
    checar('17.26 — prazo vencido detectado', J(`Plan.alertasProcesso(Plan.processo('${pa.id}'))`).prazoVencido === true);
    const cfgBase = J(`Plan.cfg()`);
    checar('17.27 — períodos de alerta são configuráveis (10 dias passa a alertar os 5 dias? não; 3 dias sim)', J(`Plan.salvarCfg({...Plan.cfg(),alertas:{sem1:3,sem2:9,prazo:7}})`).ok && J(`Plan.alertasProcesso(Plan.processo('${pa.id}'))`).sem1 === true);
    checar('17.28 — configuração inválida recusada (2º < 1º, fora de 1–365, status em uso removido)', J(`Plan.salvarCfg({...Plan.cfg(),alertas:{sem1:10,sem2:5,prazo:7}})`).ok === false && J(`Plan.salvarCfg({...Plan.cfg(),alertas:{sem1:0,sem2:5,prazo:7}})`).ok === false && J(`Plan.salvarCfg({...Plan.cfg(),statuses:Plan.cfg().statuses.filter(s=>s.id!=='s06')})`).ok === false);
    ev(`Plan.salvarCfg({...Plan.cfg(),alertas:{sem1:15,sem2:30,prazo:7}})`);
    checar('17.29 — 14 status padrão e categorias existem e são editáveis (renomear status)', cfgBase.statuses.length === 14 && J(`Plan.salvarCfg({...Plan.cfg(),statuses:Plan.cfg().statuses.map(s=>s.id==='s01'?{...s,nome:'Planejamento inicial'}:s)})`).ok && ev(`Plan.status('s01').nome`) === 'Planejamento inicial');
    ev(`Plan.salvarCfg({...Plan.cfg(),statuses:Plan.cfg().statuses.map(s=>s.id==='s01'?{...s,nome:'Em planejamento'}:s)})`);

    // XSS: dados maliciosos viram texto
    const xss = '<img src=x onerror="window.__x=1">';
    ev(`Plan.salvarMembro({unidadeId:'2',papel:'chefe',posto:'CAP PM',nome:${JSON.stringify(xss)},idFuncional:'777001',tel:'(21) 97777-0001',designadoEm:'2026-01-01'})`);
    ev(`Plan.salvarProcesso({sei:'SEI-999/1/2026',unidadeId:'2',categoriaId:'c01',objeto:${JSON.stringify('"><script>window.__x=2</script>' + xss)},statusId:'s01',inclusaoSpaei:Plan._hoje()})`);
    for (const t of ['geral', 'u:2', 'proc', 'hist']) { ev(`Plan.ir('${t}')`); }
    ev(`Plan.ir('u:2')`);
    const dom = window.document.getElementById('s-planejamento');
    checar('17.30 — nome/objeto com HTML malicioso aparece como TEXTO (nenhum <img>/<script> injetado, nada executa)', !dom.querySelector('img[src="x"]') && !dom.querySelector('script') && window.__x === undefined && /<img src=x/.test(dom.textContent));
    ev(`Plan.ficha(Plan.processos().find(p=>p.unidadeId==='2').id)`);
    checar('17.31 — ficha do processo escapa conteúdo malicioso', !window.document.getElementById('modal-body').querySelector('img[src="x"]') && !window.document.getElementById('modal-body').querySelector('script') && window.__x === undefined);
    ev(`Modal.close()`);
    // foto adulterada no banco não quebra atributo
    ev(`(function(){ const m=Plan.chefe('2'); Plan._gravar('planFotos',String(m.id),'x" onerror="window.__x=3',"t"); })()`);
    ev(`Plan.ir('u:2')`);
    checar('17.32 — foto adulterada no banco é ignorada (só data:image válida vira <img>)', window.__x === undefined && !window.document.getElementById('s-planejamento').querySelector('img[onerror]'));
    checar('17.33 — _imgOk aceita data:image/png;base64 e recusa javascript:/http', ev(`Plan._imgOk('data:image/png;base64,iVBORw0KGgo=')`) !== null && ev(`Plan._imgOk('javascript:alert(1)')`) === null && ev(`Plan._imgOk('http://x/y.png')`) === null);

    // telas: nenhuma aba pode dar erro
    const abas = ['geral', 'u:1', 'u:2', 'u:3', 'u:4', 'u:5', 'u:6', 'proc', 'rel', 'hist', 'cfg'];
    let abasOk = true; let abasDet = '';
    for (const a of abas) { try { ev(`Plan.ir('${a}')`); const t = window.document.getElementById('s-planejamento').textContent; if (/Não foi possível desenhar/.test(t) || t.length < 50) { abasOk = false; abasDet += a + ' '; } } catch (e) { abasOk = false; abasDet += a + ':' + e.message + ' '; } }
    checar('17.34 — todas as abas (geral, 6 unidades, processos, relatórios, histórico, configurações) desenham sem erro', abasOk, abasDet);
    ev(`Plan.ir('geral')`);
    txt = window.document.getElementById('s-planejamento').textContent.replace(/\s+/g, ' ');
    checar('17.35 — visão geral mostra os 11 indicadores, os 6 gráficos e o PAINEL GERAL', ['Unidades', 'Policiais nas equipes', 'Chefes de seção', 'Auxiliares', 'Processos SEI', 'Em andamento', 'Concluídos', 'Suspensos', 'Com pendências', 'Prazo próximo/vencido', 'Sem atualização recente'].every(k => txt.includes(k)) && window.document.querySelectorAll('#s-planejamento .pl-chart').length === 6 && /PAINEL GERAL DE ACOMPANHAMENTO DOS PROCESSOS/.test(txt));
    checar('17.36 — nunca usa a palavra "parado" para processo (só "Necessita atualização")', !/parado/i.test(txt) && /Necessita atualização|Sem atualização/.test(txt + ev(`Plan.rotuloAtualizacao({sem1:true})`)));
    checar('17.37 — gráficos e tabela usam só dados reais (rosca soma = processos com categoria)', ev(`Plan.stats().porCategoria.reduce((s,x)=>s+x.n,0)`) === ev(`Plan.processos().length`));

    // painel: filtro, busca, ordenação, paginação
    for (let i = 0; i < 40; i++) ev(`Plan.salvarProcesso({sei:'SEI-${500000 + i}/000001/2026',unidadeId:'${(i % 3) + 1}',categoriaId:'c0${(i % 9) + 1}',objeto:'Objeto de teste ${i}',statusId:'s0${(i % 8) + 1}',inclusaoSpaei:Plan._hoje(),prazo:__addDias(${i})})`);
    await espera(120);
    ev(`Plan._fProc={q:'',un:'',resp:'',cat:'',sit:'',ord:'prazo',dir:1,pag:1,exc:false}`);
    const r0 = J(`(function(){const r=Plan.procLinhas();return {total:r.total,paginas:r.paginas,n:r.linhas.length}})()`);
    checar('17.38 — paginação: 15 por página, total e páginas coerentes', r0.total >= 45 && r0.n === 15 && r0.paginas === Math.ceil(r0.total / 15), JSON.stringify(r0));
    checar('17.39 — filtro por unidade, categoria e busca por número SEI (só dígitos)', J(`(function(){Plan._fProc.un='2';const a=Plan.procLinhas().todas.every(x=>x.p.unidadeId==='2');Plan._fProc.un='';Plan._fProc.q='500007';const b=Plan.procLinhas().todas.map(x=>x.p.sei);Plan._fProc.q='';Plan._fProc.cat='c03';const c=Plan.procLinhas().todas.every(x=>x.p.categoriaId==='c03');Plan._fProc.cat='';return a&&b.length===1&&/500007/.test(b[0])&&c})()`));
    checar('17.40 — ordenação alterna crescente/decrescente por coluna', J(`(function(){Plan._fProc.ord='sei';Plan._fProc.dir=1;const a=Plan.procLinhas().todas[0].p.sei;Plan._fProc.dir=-1;const b=Plan.procLinhas().todas[0].p.sei;Plan._fProc.ord='prazo';Plan._fProc.dir=1;return a!==b})()`));
    checar('17.41 — filtro "prazo próximo/vencido" e "sem responsável" funcionam', J(`(function(){Plan._fProc.sit='prazo';const a=Plan.procLinhas().todas.every(x=>x.a.prazoProximo||x.a.prazoVencido);Plan._fProc.sit='semresp';const b=Plan.procLinhas().todas.every(x=>x.a.semResp);Plan._fProc.sit='';return a&&b})()`));
    ev(`Plan.ir('proc')`);
    checar('17.42 — tabela do painel desenha 15 linhas clicáveis e o calendário administrativo', window.document.querySelectorAll('#pl-painel-tab tbody tr').length === 15 && /Calendário administrativo/.test(window.document.getElementById('s-planejamento').textContent));
    ev(`Plan._pagina(1)`);
    checar('17.43 — próxima página mostra outros processos', /página 2 de/.test(window.document.getElementById('pl-painel-tab').textContent));

    // busca global
    checar('17.44 — busca global encontra unidade, integrante (por ID funcional) e processo', J(`(function(){const a=Plan.buscar('choque');const b=Plan.buscar('777001');const c=Plan.buscar('500007');return a.un.length===1&&b.mem.length===1&&c.proc.length===1})()`));

    // distribuição / pendências
    checar('17.45 — distribuição de demandas e painel de pendências por unidade coerentes', ev(`Plan.pendenciasPorUnidade().length`) === 6 && J(`Plan.distribuicao()`).linhas.length >= 60);

    // relatórios
    window.eval(`window.__html=''; window.open=function(){ return {document:{write:function(h){ window.__html+=h; },close:function(){}}}; };`);
    const rels = [1, 2, 3, 4, 5].map(n => J(`Plan.dadosRelatorio(${n})`));
    checar('17.46 — os 5 relatórios geram dados reais (colunas = linhas)', rels.every(r => r.rows.length > 0 && r.rows.every(l => l.length === r.thead.length)), rels.map(r => r.rows.length).join(','));
    checar('17.47 — relatório 1 mostra CPF só mascarado; relatório 3 tem linha TOTAL', !JSON.stringify(rels[0]).includes('52998224725') && rels[0].rows.some(l => /\*\*\*/.test(l[5])) && rels[2].rows.some(l => l[0] === 'TOTAL') && rels[2].secoes.length === 2);
    ev(`Plan.exportar(2,'PDF')`);
    checar('17.48 — PDF: cabeçalho institucional, data e conteúdo escapado', /SPAEI DIGITAL/.test(window.__html) && /Gerado em/.test(window.__html) && /Processos SEI por Unidade/.test(window.__html) && !/<script>window\.__x=2/.test(window.__html) && !/<img src=x/.test(window.__html) && /&lt;img/.test(window.__html));
    window.__html = '';
    ev(`Plan.exportar(3,'PDF')`);
    checar('17.49 — PDF do consolidado tem 2 folhas (resumo + relação de processos)', (window.__html.match(/class="folha"/g) || []).length === 2);
    ev(`Plan.exportar(2,'PDF','2')`); 
    checar('17.50 — filtro por unidade vai para o título/nota do relatório', /CHOQUE|BOPE/.test(window.__html) && /Unidade: BOPE/.test(window.__html));
    // CSV
    let blobTxt = '';
    window.eval(`URL.createObjectURL=function(b){ window.__blob=b; return 'blob:x'; }; URL.revokeObjectURL=function(){};`);
    ev(`Plan.salvarProcesso({sei:'SEI-880/1/2026',unidadeId:'3',categoriaId:'c01',objeto:'=HYPERLINK("http://mal")',statusId:'s01',inclusaoSpaei:Plan._hoje()})`);
    ev(`Plan.exportar(2,'CSV','3')`);
    blobTxt = await new Promise(res => { const fr = new (window.FileReader)(); fr.onload = () => res(fr.result); fr.readAsText(window.__blob); });
    checar('17.51 — CSV protegido contra injeção de fórmula e com BOM/cabeçalho', /^﻿?"UNIDADE"/.test(blobTxt) && blobTxt.includes(`"'=HYPERLINK`) && !/,"=HYPERLINK/.test(blobTxt));
    checar('17.52 — relatório sem dados avisa em vez de exportar vazio', (() => { ev(`Toast.warning=function(m){ window.__warn=m; }`); ev(`Plan.exportar(1,'CSV','6')`); return /Não há registros/.test(window.__warn || ''); })());

    // ficha individual
    window.__html = '';
    ev(`Plan.fichas('1','${idAux1}')`);
    checar('17.53 — ficha individual imprimível: dados do integrante, CPF mascarado, sem HTML injetado', /FICHA INDIVIDUAL/.test(window.__html) && /AUX 1/.test(window.__html) && !/<img src=x/.test(window.__html));
    window.__html = '';
    ev(`Plan.fichas('2')`);
    checar('17.54 — ficha da equipe com nome malicioso fica escapada', /&lt;img src=x/.test(window.__html) && !/<img src=x/.test(window.__html));

    // comunicados / unidade / logomarca
    checar('17.55 — comunicado publicado e exclusão lógica', J(`Plan.salvarComunicado({titulo:'Aviso',texto:'Atualizar cadastros',unidadeId:''})`).ok && ev(`Plan.comunicados().length`) === 1 && J(`Plan.excluirComunicado(Plan.comunicados()[0].id)`).ok && ev(`Plan.comunicados().length`) === 0);
    checar('17.56 — editar dados da unidade e registrar no histórico com antes/depois', J(`Plan.salvarUnidade({sigla:'CHOQUE',nome:'Batalhão de Choque (teste)',secao:'Seção de Projetos',situacao:'Ativa',obs:''},'1')`).ok && ev(`Object.values(Plan._map('planHist')).some(h=>h.entidade==='unidade'&&h.mudancas.some(m=>m.campo==='Nome completo'&&m.depois==='Batalhão de Choque (teste)'))`));
    checar('17.57 — sigla de unidade duplicada recusada', J(`Plan.salvarUnidade({sigla:'bope',nome:'',secao:'',situacao:'Ativa'})`).ok === false);
    checar('17.58 — logomarca: grava, aparece na aba e pode ser removida', ev(`Plan.salvarLogo('1','data:image/png;base64,iVBORw0KGgo=')`) === true && (ev(`Plan.ir('u:1')`), /Logomarca CHOQUE/.test(window.document.getElementById('s-planejamento').innerHTML)) && ev(`Plan.salvarLogo('1',null)`) === true && ev(`Plan.logoUnidade('1')`) === null);
    checar('17.59 — cadastro incompleto sinalizado (unidades sem nome/chefe/auxiliares)', ev(`Plan.equipeIncompleta(Plan.unidade('5')).incompleta`) === true && ev(`Plan.stats().equipesIncompletas`) >= 4);

    // persistência no "banco"
    await espera(150);
    checar('17.60 — tudo persistido no RTDB mock por id (unidades, integrantes, processos, histórico, config)', ['planUnid', 'planMemb', 'planProc', 'planHist', 'planCfg'].every(k => store.spaei[k] && Object.keys(store.spaei[k]).length > 0) && Object.keys(store.spaei.planProc).length === ev(`Plan.processos(true).length`));
    checar('17.61 — dados existentes (efetivo, processos antigos) permanecem intactos', JSON.stringify(ev(`DB.get('efetivo')`)) === efetivoAntes && JSON.stringify(ev(`DB.get('processos')`)) === processosAntes);
    checar('17.62 — histórico é append-only (nenhuma entrada some após as edições)', ev(`Object.keys(Plan._map('planHist')).length`) === Object.keys(store.spaei.planHist).length && Object.keys(store.spaei.planHist).length > 100);

    // modo TV bloqueia gravação
    ev(`safeSet('local','SPAEI_TV_MODE','1')`);
    const antesTV = Object.keys(store.spaei.planUnid).length;
    checar('17.63 — Modo TV: tela desenha sem edição e nenhuma gravação ocorre', J(`Plan.salvarUnidade({sigla:'ZZZ'})`).ok === false && (ev(`Plan.ir('geral')`), !/Novo processo/.test(window.document.getElementById('s-planejamento').textContent)) && ev(`Plan.unidades().length`) === 6);
    ev(`safeSet('local','SPAEI_TV_MODE','0')`);

    checar('17.64 — zero erro JS não tratado no grupo 17', errosJs.length === 0, errosJs.join(' | '));
  }


  // ───────────────────────────────────────────────────────────
  // GRUPO 18 — (a) unidades "sumiam" ao reabrir o app: o Firebase devolve ARRAY
  // quando as chaves são inteiros sequenciais ("1".."6"); (b) sincronização dos
  // processos do SEI Gerenciador para as unidades do módulo Planejamento.
  // ───────────────────────────────────────────────────────────
  {
    const { window, store, errosJs } = await bootApp();
    const espera = ms => new Promise(r => setTimeout(r, ms));
    const ev = c => window.eval(c);
    const J = c => JSON.parse(window.eval(`JSON.stringify(${c})`));
    window.eval(`
      Auth.user = {rg:'82061', nome:'ELOMIR GUMIERO DE MORAES', posto:'2º SGT PM', admin:true};
      _fbOk = true; _fbSynced = true;
    `);
    await espera(50);

    // (a) bug das unidades
    ev(`Plan.inicializarUnidades()`);
    ev(`Plan.salvarUnidade({sigla:'BOPE',nome:'Batalhão de Operações Especiais (teste)',secao:'Seção de Planejamento',situacao:'Ativa',obs:''},'2')`);
    ev(`Plan.salvarLogo('2','data:image/png;base64,iVBORw0KGgo=')`);
    await espera(120);
    // exatamente o que o Firebase faz com chaves "1".."6": devolve ARRAY com posição 0 nula
    const comoFirebase = o => { const a = []; Object.keys(o).forEach(k => { a[+k] = o[k]; }); return a; };
    window.__arrU = comoFirebase(JSON.parse(JSON.stringify(store.spaei.planUnid)));
    window.__arrL = comoFirebase(JSON.parse(JSON.stringify(store.spaei.planLogos)));
    ev(`_mem['planUnid']=window.__arrU; _mem['planLogos']=window.__arrL;`);
    checar('18.1 — premissa: o banco devolve ARRAY para as unidades (id "1".."6")', ev(`Array.isArray(DB.get('planUnid'))`) === true && ev(`DB.get('planUnid')[0]`) == null);
    checar('18.2 — com o array do Firebase as 6 unidades continuam visíveis (antes: 0)', ev(`Plan.unidades().length`) === 6 && ev(`Plan.unidade('2').nome`) === 'Batalhão de Operações Especiais (teste)');
    ev(`Plan.ir('geral')`);
    checar('18.3 — a tela NÃO oferece mais "Criar as 6 unidades"', !/Nenhuma unidade cadastrada|Criar as 6 unidades/.test(window.document.getElementById('s-planejamento').textContent) && window.document.querySelectorAll('#s-planejamento .pl-tab').length >= 8);
    checar('18.4 — inicializarUnidades nunca recria nem sobrescreve unidades existentes', ev(`Plan.inicializarUnidades()`) === 0 && ev(`Plan.unidade('2').nome`) === 'Batalhão de Operações Especiais (teste)');
    checar('18.5 — logomarca também é lida do array', ev(`Plan.logoUnidade('2')`) !== null);
    ev(`_mem['planUnid']=[]`);   // mesmo "vazio" vindo do banco não deve permitir sobrescrever nada existente no servidor
    checar('18.6 — salvar nova unidade com o cache em array usa o próximo id sem colidir', (ev(`_mem['planUnid']=window.__arrU`), J(`Plan.salvarUnidade({sigla:'NOVA',nome:'',secao:'',situacao:'Ativa'})`).id === '7'));

    // (b) sincronização com o SEI Gerenciador
    ev(`Plan.salvarMembro({unidadeId:'2',papel:'chefe',posto:'MAJ PM',nome:'CHEFE BOPE TESTE',idFuncional:'710001',tel:'(21) 99999-1111',designadoEm:'2026-01-01'})`);
    const sei = (n, un, o) => Object.assign({ id: 'SEI-fb' + n, numero: `SEI-35001${n}/000${100 + n}/2026`, assunto: 'Assunto do processo ' + n, resp: 'SGT Gumiero, SGT Thiago', status: 'EM ANDAMENTO', prio: 'ALTA', tipo: 'EXTERNO', criado: '15/10/2026', prazo: '30/12/2026', unidade: un, observacoes: 'obs ' + n, pca: null, _seiSync: true }, o || {});
    window.__sei = [
      sei(1, 'BOPE'), sei(2, 'BPChq', { status: 'CONCLUÍDO' }), sei(3, 'CIESPP', { status: 'SUSPENSO', resp: '—' }), sei(4, 'GAM', { status: 'FASE PREPARATÓRIA' }),
      sei(5, 'BAC', { status: 'CANCELADO' }), sei(6, 'BTM', { status: 'AGUARDANDO', prazo: '—' }), sei(7, 'COE'), sei(8, 'COE'), sei(9, 'Outra Unidade'),
      sei(10, 'BOPE', { numero: 'sem numero' }), sei(11, 'bope - 1º batalhão', {}),
      sei(12, 'BOPE', { assunto: '<img src=x onerror="window.__x=18">', resp: '<script>window.__x=19</script>' }),
    ];
    ev(`_mem['sei_processos']=window.__sei; localStorage.setItem(LS_PFX+'sei_processos',JSON.stringify(window.__sei))`);
    checar('18.7 — mapeamento de unidade: BPChq→CHOQUE, "bope - 1º batalhão"→BOPE, COE e desconhecidas → nenhuma', ev(`Plan.unidadePorTextoSei('BPChq').sigla`) === 'CHOQUE' && ev(`Plan.unidadePorTextoSei('bope - 1º batalhão').sigla`) === 'BOPE' && ev(`Plan.unidadePorTextoSei('CIESPP').sigla`) === 'CIEsPP' && ev(`Plan.unidadePorTextoSei('COE')`) === null && ev(`Plan.unidadePorTextoSei('')`) === null);
    checar('18.8 — mapeamento de status do SEI por GRUPO (concluído/suspenso/cancelado→arquivado/andamento)', ev(`['CONCLUÍDO','SUSPENSO','CANCELADO','FASE PREPARATÓRIA','AGUARDANDO','EM ANDAMENTO'].map(x=>Plan.status(Plan.statusPlanDeSei(x)).grupo).join(',')`) === 'concluido,suspenso,arquivado,andamento,andamento,andamento');

    ev(`Auth.user = {rg:'90001', nome:'CONSULTA', posto:'SD', admin:false}`);
    checar('18.9 — perfil sem administração não sincroniza (nenhum processo criado)', J(`Plan.sincronizarSei({})`).ok === false && ev(`Plan.processos(true).length`) === 0);
    ev(`Auth.user = {rg:'82061', nome:'ELOMIR GUMIERO DE MORAES', posto:'2º SGT PM', admin:true}`);
    ev(`_fbCfg = _fbCfg || {x:1}; _fbSynced = false`);
    checar('18.10 — antes da sincronização inicial com o banco, recusa (não escreve por cima do servidor)', J(`Plan.sincronizarSei({})`).aguardando === true && ev(`Plan.processos(true).length`) === 0);
    ev(`_fbSynced = true`);

    const r1 = J(`Plan.sincronizarSei({})`);
    await espera(200);
    checar('18.11 — 1ª sincronização: importa só os das 6 unidades (8 de 12; 4 ficam de fora)', r1.ok && r1.lidos === 12 && r1.criados === 8 && r1.semNumero === 1 && r1.ignorados.COE === 2 && r1.ignorados['Outra Unidade'] === 1, JSON.stringify(r1));
    const porSei = n => J(`Plan.processos(true).find(p=>Plan._seiKey(p.sei)===Plan._seiKey('SEI-35001${n}/000${100 + n}/2026'))`);
    const p1 = porSei(1), p2 = porSei(2), p3 = porSei(3), p5 = porSei(5), p6 = porSei(6);
    checar('18.12 — cada processo caiu na unidade certa (BOPE, BPChq→CHOQUE, CIEsPP, BTM…)', ev(`Plan.siglaUnidade('${p1.unidadeId}')`) === 'BOPE' && ev(`Plan.siglaUnidade('${p2.unidadeId}')`) === 'CHOQUE' && ev(`Plan.siglaUnidade('${p3.unidadeId}')`) === 'CIEsPP' && ev(`Plan.siglaUnidade('${p6.unidadeId}')`) === 'BTM');
    checar('18.13 — dados corretos: objeto, prazo ISO, atualização do SEI, status por grupo, concluído com data', p1.objeto === 'Assunto do processo 1' && p1.prazo === '2026-12-30' && p1.atualizadoEmData === '2026-10-15' && ev(`Plan.grupoDe(Plan.processo('${p2.id}'))`) === 'concluido' && p2.concluidoEm === '2026-10-15' && ev(`Plan.grupoDe(Plan.processo('${p3.id}'))`) === 'suspenso' && ev(`Plan.grupoDe(Plan.processo('${p5.id}'))`) === 'arquivado' && p6.prazo === '');
    checar('18.14 — nada inventado: sem categoria, sem responsável vinculado (texto do SEI só como referência)', p1.categoriaId === '' && p1.respPrincipalId === '' && p1.respSeiTexto === 'SGT Gumiero, SGT Thiago' && p3.respSeiTexto === '' && p1.origemSei === 'SEI-fb1');
    checar('18.15 — id determinístico a partir do nº SEI e histórico "importou do SEI Gerenciador"', p1.id === '88' + ev(`Plan._seiKey('SEI-350011/000101/2026')`) && ev(`Object.values(Plan._map('planHist')).filter(h=>/importou do SEI/.test(h.acao)).length`) === 8);
    const r2 = J(`Plan.sincronizarSei({})`);
    await espera(100);
    checar('18.16 — sincronizar de novo é idempotente: 0 criados, 0 atualizados, 0 duplicados', r2.criados === 0 && r2.atualizados === 0 && r2.iguais === 8 && ev(`Plan.processos(true).length`) === 8, JSON.stringify(r2));
    checar('18.17 — persistido por id no banco (nó planProc) sem duplicatas', Object.keys(store.spaei.planProc).length === 8);

    // estatísticas e telas
    const st = J(`Plan.stats()`);
    checar('18.18 — indicadores refletem os importados (8 processos; "A classificar" na categoria)', st.processos === 8 && st.porCategoria.some(x => x.c.nome === 'A classificar' && x.n === 8) && st.porCategoria.reduce((a, x) => a + x.n, 0) === 8);
    let abasOk = true, det = '';
    for (const a of ['geral', 'u:1', 'u:2', 'u:3', 'u:4', 'u:5', 'u:6', 'proc', 'rel', 'hist']) { try { ev(`Plan.ir('${a}')`); const t = window.document.getElementById('s-planejamento').textContent; if (/Não foi possível desenhar/.test(t)) { abasOk = false; det += a + ' '; } } catch (e) { abasOk = false; det += a + ':' + e.message; } }
    checar('18.19 — todas as abas desenham com os processos importados', abasOk, det);
    ev(`Plan._fProc={q:'',un:'',resp:'',cat:'',sit:'',ord:'sei',dir:1,pag:1,exc:false}; Plan.ir('proc')`);
    const tabTxt = window.document.getElementById('pl-painel-tab').textContent.replace(/\s+/g, ' ');
    checar('18.20 — painel mostra "A classificar", "SEI Gerenciador" e o responsável do SEI como referência', /A classificar/.test(tabTxt) && /SEI Gerenciador/.test(tabTxt) && /SGT Gumiero, SGT Thiago \(SEI\)/.test(tabTxt));
    checar('18.21 — SEI com HTML malicioso aparece como texto (nada injetado/executado)', window.__x === undefined && !window.document.getElementById('s-planejamento').querySelector('img[src="x"], script') && /<img src=x/.test(window.document.getElementById('s-planejamento').textContent));
    checar('18.22 — filtro "A classificar" e busca pelo responsável do SEI', J(`(function(){Plan._fProc.cat='__sem';const a=Plan.procLinhas().total;Plan._fProc.cat='';Plan._fProc.q='thiago';const b=Plan.procLinhas().total;Plan._fProc.q='';return a===8&&b>=5})()`));
    ev(`Plan.ficha('${p1.id}')`);
    const fi = window.document.getElementById('modal-body').textContent.replace(/\s+/g, ' ');
    checar('18.23 — ficha mostra origem SEI Gerenciador, situação e responsável no SEI, e o aviso de classificar', /Origem: SEI Gerenciador/.test(fi) && /Situação no SEI: EM ANDAMENTO/.test(fi) && /Falta classificar a categoria/.test(fi));
    ev(`Modal.close()`);
    ev(`Plan.fichas`);
    const rel = J(`Plan.dadosRelatorio(2,'')`);
    checar('18.24 — relatório de processos inclui origem e "A classificar"', rel.thead.includes('ORIGEM') && rel.rows.some(l => l.includes('SEI Gerenciador') && l.includes('A classificar')) && rel.rows.every(l => l.length === rel.thead.length));

    // edição manual é soberana
    const rEd = J(`Plan.salvarProcesso({sei:'${p1.sei}',unidadeId:'${p1.unidadeId}',objeto:'Objeto REVISADO pela SPAEI',categoriaId:'',statusId:'s05',respPrincipalId:'',prazo:'${p1.prazo}',inclusaoSpaei:'${p1.inclusaoSpaei}'}, '${p1.id}')`);
    checar('18.25 — ao editar um importado a categoria passa a ser obrigatória (classificação)', rEd.ok === false && /categoria/i.test(rEd.erros.join(' ')));
    const rEd2 = J(`Plan.salvarProcesso({sei:'${p1.sei}',unidadeId:'${p1.unidadeId}',objeto:'Objeto REVISADO pela SPAEI',categoriaId:'c03',statusId:'s05',respPrincipalId:'${ev(`Plan.chefe('2').id`)}',prazo:'${p1.prazo}',inclusaoSpaei:'${p1.inclusaoSpaei}'}, '${p1.id}')`);
    const p1b = porSei(1);
    checar('18.26 — edição manual salva e preserva a origem SEI (origemSei, situação e responsável do SEI)', rEd2.ok === true && p1b.origemSei === 'SEI-fb1' && p1b.statusSei === 'EM ANDAMENTO' && p1b.respSeiTexto === 'SGT Gumiero, SGT Thiago' && !!p1b.seiBase);
    // SEI muda: processo 1 (editado) e 6 (intocado)
    window.__sei = window.__sei.map(x => x.id === 'SEI-fb1' ? Object.assign({}, x, { assunto: 'NOVO assunto vindo do SEI', status: 'CONCLUÍDO', prazo: '01/02/2027', resp: 'SGT Novo', criado: '20/10/2026' }) : x.id === 'SEI-fb6' ? Object.assign({}, x, { assunto: 'Assunto 6 alterado no SEI', status: 'CONCLUÍDO', prazo: '10/01/2027', criado: '21/10/2026' }) : x);
    ev(`_mem['sei_processos']=window.__sei`);
    const r3 = J(`Plan.sincronizarSei({})`);
    await espera(100);
    const p1c = porSei(1), p6c = porSei(6);
    checar('18.27 — mudança no SEI atualiza o que não foi editado aqui (processo 6: objeto, fase, prazo, data de conclusão)', p6c.objeto === 'Assunto 6 alterado no SEI' && ev(`Plan.grupoDe(Plan.processo('${p6c.id}'))`) === 'concluido' && p6c.prazo === '2027-01-10' && p6c.concluidoEm === '2026-10-21' && r3.atualizados >= 2, JSON.stringify(r3));
    checar('18.28 — o que foi editado manualmente NÃO é sobrescrito (objeto e fase do processo 1), mas o prazo não editado e a referência do SEI atualizam', p1c.objeto === 'Objeto REVISADO pela SPAEI' && p1c.statusId === 's05' && p1c.categoriaId === 'c03' && p1c.respPrincipalId === ev(`Plan.chefe('2').id`) && p1c.prazo === '2027-02-01' && p1c.statusSei === 'CONCLUÍDO' && p1c.respSeiTexto === 'SGT Novo');
    checar('18.29 — alterações vindas do SEI ficam no histórico com antes/depois', ev(`Object.values(Plan._map('planHist')).some(h=>/atualizou a partir do SEI/.test(h.acao)&&h.registroId==='${p6c.id}'&&h.mudancas.some(m=>m.campo==='Prazo estimado'&&m.depois==='2027-01-10'))`));

    // exclusão respeitada; duplicata manual; auto-sync
    ev(`Plan.excluirProcesso('${p3.id}')`);
    window.__sei = window.__sei.concat([sei(20, 'GAM', { numero: 'SEI-350099/000999/2026' })]);
    ev(`Plan.salvarProcesso({sei:'350099/000999/2026',unidadeId:'4',categoriaId:'c01',objeto:'Cadastrado à mão antes',statusId:'s01',inclusaoSpaei:Plan._hoje()})`);
    ev(`_mem['sei_processos']=window.__sei`);
    const r4 = J(`Plan.sincronizarSei({})`);
    await espera(100);
    checar('18.30 — processo excluído aqui não ressuscita; o já cadastrado à mão (mesmo nº SEI) não duplica', r4.respeitadosExcluidos === 1 && r4.jaCadastrados === 1 && ev(`Plan.processos(true).filter(p=>Plan._seiKey(p.sei)==='350099000999' + '2026').length`) === 1 && ev(`Plan.processo('${p3.id}').excluido`) === true);
    // auto-sincronização ao abrir o módulo (1x a cada 10 min)
    window.__sei = window.__sei.concat([sei(30, 'BAC', { numero: 'SEI-350077/000777/2026' })]);
    ev(`_mem['sei_processos']=window.__sei; Plan._syncUlt=0; Nav.go('planejamento')`);
    await espera(150);
    checar('18.31 — ao abrir o módulo, um Administrador recebe os novos processos automaticamente', ev(`Plan.processos().some(p=>Plan._seiKey(p.sei)==='3500770007772026')`));
    window.__sei = window.__sei.concat([sei(31, 'BAC', { numero: 'SEI-350078/000778/2026' })]);
    ev(`_mem['sei_processos']=window.__sei; Nav.go('planejamento')`);
    checar('18.32 — dentro dos 10 min o automático não roda de novo (sem laço de gravação)', !ev(`Plan.processos().some(p=>Plan._seiKey(p.sei)==='3500780007782026')`));
    ev(`Auth.user = {rg:'90001', nome:'CONSULTA', posto:'SD', admin:false}; Plan._syncUlt=0; Nav.go('planejamento')`);
    checar('18.33 — perfil de consulta abrindo o módulo não dispara sincronização', !ev(`Plan.processos().some(p=>Plan._seiKey(p.sei)==='3500780007782026')`));
    ev(`Auth.user = {rg:'82061', nome:'ELOMIR GUMIERO DE MORAES', posto:'2º SGT PM', admin:true}`);
    ev(`Plan.ir('proc'); Plan.sincronizarManual()`);
    const mod = window.document.getElementById('modal-body').textContent.replace(/\s+/g, ' ');
    checar('18.34 — botão manual mostra o resumo (lidos, importados, atualizados, unidades fora do módulo)', /Processos lidos do SEI/.test(mod) && /Importados agora/.test(mod) && /fora das 6 do módulo/.test(mod) && /COE: 2/.test(mod));
    ev(`Modal.close()`);
    checar('18.35 — ids de histórico não colidem em laço rápido', ev(`(function(){const s=new Set();for(let i=0;i<5000;i++)s.add(Plan._id());return s.size})()`) === 5000);
    checar('18.36 — dados do SEI e demais nós existentes ficam intactos (a sincronização só LÊ o SEI)', JSON.stringify(ev(`_mem['sei_processos']`).map(x => x.id)) === JSON.stringify(window.__sei.map(x => x.id)));
    checar('18.37 — zero erro JS não tratado no grupo 18', errosJs.length === 0, errosJs.join(' | '));
  }


  // ───────────────────────────────────────────────────────────
  // GRUPO 19 — "Cadastro incompleto" aparecia mesmo com os nomes preenchidos:
  // a regra misturava dado faltando com equipe ainda não cadastrada e cobrava
  // campos que o formulário não exige. Três conceitos agora separados.
  // ───────────────────────────────────────────────────────────
  {
    const { window, store, errosJs } = await bootApp();
    const espera = ms => new Promise(r => setTimeout(r, ms));
    const ev = c => window.eval(c);
    const J = c => JSON.parse(window.eval(`JSON.stringify(${c})`));
    window.eval(`Auth.user = {rg:'82061', nome:'ELOMIR GUMIERO DE MORAES', posto:'2º SGT PM', admin:true}; _fbOk = true; _fbSynced = true;`);
    const NOMES = { 1: 'Batalhão de Polícia de Choque', 2: 'Batalhão de Operações Policiais Especiais', 3: 'Companhia Independente de Ensino e Pesquisa', 4: 'Grupamento Aeromóvel', 5: 'Batalhão de Ações com Cães', 6: 'Batalhão de Treinamento e Manutenção' };
    ev(`Plan.inicializarUnidades()`);
    // o administrador preenche o NOME COMPLETO de cada unidade pelo formulário real (DOM)
    for (const id of Object.keys(NOMES)) {
      ev(`Plan.formUnidade('${id}')`);
      window.document.getElementById('pl-u-nome').value = NOMES[id];
      window.document.getElementById('pl-u-secao').value = 'Seção de Projetos e Planejamento';
      ev(`Plan._salvarFormUnidade('${id}')`);
    }
    await espera(150);
    // o Firebase devolve as unidades como ARRAY ao reabrir o app
    window.__arr = (o => { const a = []; Object.keys(o).forEach(k => { a[+k] = o[k]; }); return a; })(JSON.parse(JSON.stringify(store.spaei.planUnid)));
    ev(`_mem['planUnid']=window.__arr`);
    checar('19.1 — nomes gravados pelo formulário e relidos do array do banco (6 de 6 com nome completo)', ev(`Plan.unidades().filter(u=>u.nome&&u.secao).length`) === 6 && ev(`Plan.unidade('3').nome`) === NOMES[3]);
    const e1 = J(`Plan.equipeIncompleta(Plan.unidade('1'))`);
    checar('19.2 — unidade com nome completo e sem membros NÃO é "cadastro incompleto"', e1.incompleta === false && e1.unidade.length === 0 && e1.integrantes.length === 0);
    checar('19.3 — mas fica sinalizada à parte como "equipe a cadastrar" (chefe + auxiliares)', e1.equipe.join('|') === 'chefe da seção|auxiliares');
    const st = J(`Plan.stats()`);
    checar('19.4 — indicadores: 0 incompletas, 6 equipes a cadastrar', st.equipesIncompletas === 0 && st.equipesACadastrar === 6);
    checar('19.5 — tabela de acompanhamento: coluna Cadastro "completo" e Equipe "a cadastrar" para as 6', J(`Plan.pendenciasPorUnidade().every(r=>r.cadastro===0&&r.equipe.length===2)`));
    ev(`Plan.ir('u:1')`);
    let tx = window.document.getElementById('s-planejamento').textContent.replace(/\s+/g, ' ');
    checar('19.6 — aba da unidade: sem "Cadastro incompleto"; mostra "Equipe a cadastrar" e dados da unidade completos', !/Cadastro incompleto/.test(tx) && /Equipe a cadastrar/.test(tx) && /Os dados da unidade estão completos/.test(tx));
    ev(`Plan.ir('geral')`);
    tx = window.document.getElementById('s-planejamento').textContent.replace(/\s+/g, ' ');
    const linhasTab = [...window.document.querySelectorAll('#s-planejamento table.pl-t')].find(t => /Cadastro incompleto/.test(t.textContent));
    checar('19.7 — painel geral: 6 linhas "completo" + "a cadastrar", nenhuma contagem de itens faltando', !!linhasTab && (linhasTab.textContent.match(/completo/g) || []).length >= 6 && (linhasTab.textContent.match(/a cadastrar/g) || []).length === 6 && !/item\(ns\)/.test(linhasTab.textContent));
    const rel = J(`Plan.dadosRelatorio(4,'')`);
    checar('19.8 — relatório de pendências: sem "Cadastro incompleto"; com 6 linhas "Equipe a cadastrar"', !rel.rows.some(l => /Cadastro incompleto/.test(l.join(' '))) && rel.rows.filter(l => l.includes('Equipe a cadastrar')).length === 6);

    // unidade realmente sem nome continua sendo incompleta
    ev(`Plan.salvarUnidade({sigla:'TESTE',nome:'',secao:'',situacao:'Ativa'})`);
    await espera(80);
    const idT = J(`Plan.unidades().find(u=>u.sigla==='TESTE').id`);
    const eT = J(`Plan.equipeIncompleta(Plan.unidade('${idT}'))`);
    ev(`Plan.ir('u:${idT}')`);
    tx = window.document.getElementById('s-planejamento').textContent.replace(/\s+/g, ' ');
    checar('19.9 — unidade sem nome completo continua "Cadastro incompleto: falta nome completo"', eT.incompleta === true && eT.unidade[0] === 'nome completo' && /Cadastro incompleto\. Unidade: falta nome completo/.test(tx));
    ev(`_mem['planUnid']=Object.fromEntries(Object.entries(Object.assign({}, _mem['planUnid'])).filter(([k])=>k!=='${idT}'))`);   // tira a unidade de teste do cache

    // chefe com SÓ os campos obrigatórios do formulário (*): não pode ficar "incompleto"
    ev(`Plan.ir('u:1')`);
    const rc = J(`Plan.salvarMembro({unidadeId:'1',papel:'chefe',posto:'MAJ PM',nome:'CHEFE UM DA SILVA',idFuncional:'800001'})`);
    await espera(100);
    const e2 = J(`Plan.equipeIncompleta(Plan.unidade('1'))`);
    ev(`Plan.ir('u:1')`);
    tx = window.document.getElementById('s-planejamento').textContent.replace(/\s+/g, ' ');
    checar('19.10 — chefe só com campos obrigatórios (posto, nome, ID): salva, NÃO fica incompleto', rc.ok === true && e2.incompleta === false && e2.integrantes.length === 0 && !/Falta \(obrigatório\)/.test(tx) && !/Cadastro incompleto/.test(tx));
    checar('19.11 — "equipe a cadastrar" passa a pedir só os auxiliares; contato/data viram sugestão opcional', e2.equipe.join('|') === 'auxiliares' && /Dados complementares \(opcionais\)/.test(tx) && /contato \(telefone ou e-mail\)/.test(tx) && /data de designação/.test(tx));
    checar('19.12 — o nome da unidade continua gravado depois de salvar integrante (sem sobrescrita por cópia velha)', ev(`Plan.unidade('1').nome`) === NOMES[1] && store.spaei.planUnid['1'].nome === NOMES[1]);
    // auxiliar completo
    ev(`Plan.salvarMembro({unidadeId:'1',papel:'auxiliar',posto:'1º SGT PM',nome:'AUXILIAR UM',idFuncional:'800002',tel:'(21) 98888-1111',funcao:'Analista de processos'})`);
    ev(`Plan.salvarMembro({unidadeId:'1',papel:'chefe',posto:'MAJ PM',nome:'CHEFE UM DA SILVA',idFuncional:'800001',tel:'(21) 97777-1111',designadoEm:'2026-01-05'}, '${J(`Plan.chefe('1').id`)}')`);
    await espera(120);
    const e3 = J(`Plan.equipeIncompleta(Plan.unidade('1'))`);
    ev(`Plan.ir('u:1')`);
    tx = window.document.getElementById('s-planejamento').textContent.replace(/\s+/g, ' ');
    checar('19.13 — equipe completa: nenhum aviso (nem incompleto, nem a cadastrar, nem complementos)', e3.incompleta === false && e3.equipe.length === 0 && e3.complementos.length === 0 && !/Cadastro incompleto|Equipe a cadastrar|Dados complementares/.test(tx));
    const st2 = J(`Plan.stats()`);
    checar('19.14 — indicadores acompanham: 5 equipes ainda a cadastrar', st2.equipesACadastrar === 5 && st2.equipesIncompletas === 0);

    // integrante legado/importado sem dado OBRIGATÓRIO continua apontado
    ev(`_mem['planMemb']=Object.assign({}, _mem['planMemb'], {'990001':{id:'990001',unidadeId:'2',papel:'auxiliar',posto:'',nome:'SEM POSTO',idFuncional:'',ativo:true,excluido:false,ordem:9}})`);
    const e4 = J(`Plan.equipeIncompleta(Plan.unidade('2'))`);
    checar('19.15 — integrante sem posto/ID funcional (dado obrigatório) segue como "incompleto", listando o que falta', e4.incompleta === true && e4.integrantes[0].faltas.join('|') === 'posto/graduação|ID funcional');
    ev(`Plan.ir('u:2')`);
    tx = window.document.getElementById('s-planejamento').textContent.replace(/\s+/g, ' ');
    checar('19.16 — aviso informa quantos e quais integrantes', /1 integrante\(s\) com dados obrigatórios faltando \(SEM\)/.test(tx));
    ev(`_mem['planMemb']=Object.fromEntries(Object.entries(_mem['planMemb']).filter(([k])=>k!=='990001'))`);

    // integrante com nome vazio não derruba a tela (nome.split)
    ev(`_mem['planMemb']=Object.assign({}, _mem['planMemb'], {'990002':{id:'990002',unidadeId:'3',papel:'auxiliar',posto:'CB PM',nome:'',idFuncional:'5',ativo:true,excluido:false,ordem:9}})`);
    let okTela = true; try { ev(`Plan.ir('u:3')`); okTela = !/Não foi possível desenhar/.test(window.document.getElementById('s-planejamento').textContent); } catch (e) { okTela = false; }
    checar('19.17 — integrante com nome vazio não quebra a aba da unidade', okTela);
    ev(`_mem['planMemb']=Object.fromEntries(Object.entries(_mem['planMemb']).filter(([k])=>k!=='990002'))`);

    // processos importados do SEI continuam funcionando junto
    ev(`Plan.ir('geral')`);
    checar('19.18 — painel geral desenha sem erro após a mudança', !/Não foi possível desenhar/.test(window.document.getElementById('s-planejamento').textContent) && window.document.querySelectorAll('#s-planejamento .pl-kpi').length >= 10);
    checar('19.19 — zero erro JS não tratado no grupo 19', errosJs.length === 0, errosJs.join(' | '));
  }


  // ───────────────────────────────────────────────────────────
  // GRUPO 20 — varredura do checklist: todos os relatórios, todos os formulários,
  // ida-e-volta de edição pelo formulário real e XSS em atributos/telas.
  // ───────────────────────────────────────────────────────────
  {
    const { window, store, errosJs } = await bootApp();
    const espera = ms => new Promise(r => setTimeout(r, ms));
    const ev = c => window.eval(c);
    const J = c => JSON.parse(window.eval(`JSON.stringify(${c})`));
    window.eval(`Auth.user = {rg:'82061', nome:'ELOMIR GUMIERO DE MORAES', posto:'2º SGT PM', admin:true}; _fbOk = true; _fbSynced = true;`);
    window.__x = undefined;
    const XS = `"><img src=x onerror="window.__x=20">`;
    ev(`Plan.inicializarUnidades()`);
    ev(`Plan.salvarUnidade({sigla:'BOPE',nome:${JSON.stringify('Nome "com aspas" ' + XS)},secao:${JSON.stringify(XS)},situacao:'Ativa',obs:${JSON.stringify(XS)}},'2')`);
    const rch = J(`Plan.salvarMembro({unidadeId:'2',papel:'chefe',posto:'MAJ PM',nome:'CHEFE BOPE',idFuncional:'900001',tel:'(21) 99999-0001',designadoEm:'2026-02-02',email:'chefe@exemplo.com',emailInst:'secao@exemplo.com',ramal:'1234',obs:${JSON.stringify(XS)}})`);
    const raux = J(`Plan.salvarMembro({unidadeId:'2',papel:'auxiliar',posto:'1º SGT PM',nome:${JSON.stringify('AUX ' + XS)},idFuncional:'900002',tel:'(21) 99999-0002',funcao:${JSON.stringify(XS)}})`);
    ev(`Plan.salvarProcesso({sei:'SEI-350010/000123/2026',unidadeId:'2',categoriaId:'c01',objeto:${JSON.stringify(XS)},statusId:'s01',respPrincipalId:'${rch.id}',inclusaoSpaei:Plan._hoje(),pendencias:${JSON.stringify(XS)},obsSpaei:${JSON.stringify(XS)}})`);
    await espera(150);
    checar('20.1 — base do cenário criada (unidade, chefe, auxiliar, processo)', rch.ok && raux.ok && ev(`Plan.processos().length`) === 1);

    // relatórios: todos, geral e por unidade
    let relOk = true, relDet = '';
    for (const n of [1, 2, 3, 4, 5]) for (const uid of ['', '1', '2', '6']) {
      try { const r = J(`Plan.dadosRelatorio(${n},'${uid}')`); if (!r.thead || !r.rows.every(l => l.length === r.thead.length)) { relOk = false; relDet += `r${n}/u${uid}:colunas `; } }
      catch (e) { relOk = false; relDet += `r${n}/u${uid}:${e.message} `; }
    }
    checar('20.2 — 5 relatórios × (geral + 3 unidades): sem exceção e linhas com o nº de colunas do cabeçalho', relOk, relDet);

    // formulários abrem e fecham
    let fOk = true, fDet = '';
    const forms = [`Plan.formUnidade(null)`, `Plan.formUnidade('2')`, `Plan.formMembro('2',null,'chefe')`, `Plan.formMembro('2',null,'auxiliar')`, `Plan.formMembro('2','${rch.id}')`, `Plan.formMembro('2','${raux.id}')`, `Plan.formProcesso(null,'2')`, `Plan.formProcesso('${J(`Plan.processos()[0].id`)}')`, `Plan.formComunicado(null)`, `Plan.formComunicado('2')`, `Plan.formSaida('${raux.id}')`];
    for (const f of forms) { try { ev(f); const mb = window.document.getElementById('modal-body'); if (!mb || mb.textContent.length < 20) { fOk = false; fDet += f + ':vazio '; } ev(`Modal.close()`); } catch (e) { fOk = false; fDet += f + ':' + e.message + ' '; } }
    checar('20.3 — os 11 formulários abrem com conteúdo e fecham sem erro', fOk, fDet);

    // XSS: nada executa em nenhuma aba, ficha, formulário
    let xssOk = true;
    const telas = [`Plan.ir('geral')`, `Plan.ir('u:2')`, `Plan.ir('proc')`, `Plan.ir('rel')`, `Plan.ir('hist')`, `Plan.ficha('${J(`Plan.processos()[0].id`)}')`, `Plan.formUnidade('2')`, `Plan.formMembro('2','${rch.id}')`, `Plan.formMembro('2','${raux.id}')`, `Plan.formProcesso('${J(`Plan.processos()[0].id`)}')`, `Plan.fichas('2')`];
    for (const t of telas) { try { ev(t); } catch (e) { xssOk = false; } if (window.document.querySelector('#s-planejamento img[onerror], #modal-body img[onerror], img[src="x"]')) xssOk = false; ev(`typeof Modal!=='undefined'&&Modal.close()`); }
    checar('20.4 — texto malicioso em unidade/seção/obs/integrante/função/processo não cria elemento nem executa (11 telas)', xssOk && window.__x === undefined);

    // ida e volta pelo formulário real: editar só o telefone do chefe preserva o restante
    ev(`Plan.formMembro('2','${rch.id}')`);
    window.document.getElementById('pl-m-tel').value = '(21) 98888-7777';
    ev(`Plan._salvarFormMembro('2','${rch.id}','chefe')`);
    await espera(120);
    const ch = J(`Plan.membro('${rch.id}')`);
    checar('20.5 — editar só o telefone do chefe pelo formulário preserva posto, nome, ID, e-mails, ramal, designação', ch.tel === '(21) 98888-7777' && ch.posto === 'MAJ PM' && ch.nome === 'CHEFE BOPE' && ch.idFuncional === '900001' && ch.email === 'chefe@exemplo.com' && ch.emailInst === 'secao@exemplo.com' && ch.ramal === '1234' && ch.designadoEm === '2026-02-02');
    ev(`Plan.formMembro('2','${raux.id}')`);
    window.document.getElementById('pl-m-func').value = 'Analista';
    ev(`Plan._salvarFormMembro('2','${raux.id}','auxiliar')`);
    await espera(120);
    const ax = J(`Plan.membro('${raux.id}')`);
    checar('20.6 — editar a função do auxiliar preserva o restante e gravou exatamente o digitado', ax.funcao === 'Analista' && ax.idFuncional === '900002' && ax.tel === '(21) 99999-0002' && ax.nome.startsWith('AUX '));
    ev(`Plan.formUnidade('2')`);
    const nomeNoCampo = window.document.getElementById('pl-u-nome').value;
    ev(`Plan._salvarFormUnidade('2')`);
    await espera(100);
    checar('20.7 — nome com aspas e HTML faz ida-e-volta idêntica pelo formulário (sem corromper nem duplicar escape)', nomeNoCampo === ev(`Plan.unidade('2').nome`) && ev(`Plan.unidade('2').nome`).includes('"com aspas"') && store.spaei.planUnid['2'].nome === nomeNoCampo);

    // regras de unicidade
    const dup = J(`Plan.salvarMembro({unidadeId:'3',papel:'chefe',posto:'CAP PM',nome:'OUTRO',idFuncional:'900001'})`);
    const dup2 = J(`Plan.salvarMembro({unidadeId:'2',papel:'chefe',posto:'CAP PM',nome:'SEGUNDO CHEFE',idFuncional:'900099'})`);
    const dup3 = J(`Plan.salvarProcesso({sei:'350010/000123/2026',unidadeId:'3',categoriaId:'c01',objeto:'dup',statusId:'s01',inclusaoSpaei:Plan._hoje()})`);
    checar('20.8 — bloqueia ID funcional repetido, 2º chefe na mesma unidade e nº SEI repetido (com ou sem prefixo)', !dup.ok && !dup2.ok && !dup3.ok);

    // perfil de consulta
    ev(`Auth.user = {rg:'90001', nome:'CONSULTA', posto:'SD', admin:false}`);
    ev(`Plan.ir('u:2')`);
    const txC = window.document.getElementById('s-planejamento').textContent;
    ev(`Plan.formUnidade('2')`);
    const abriu = window.document.getElementById('modal-body') && window.document.getElementById('modal-body').textContent.length > 20 && window.document.getElementById('modal-body').offsetParent !== null && /Editar unidade/.test(window.document.getElementById('modal-body').parentElement.textContent);
    const rSave = J(`Plan.salvarUnidade({sigla:'HACK',nome:'x'})`);
    checar('20.9 — consulta: sem botões de edição, sem formulário e escrita recusada', !/Editar unidade|Adicionar integrante|Novo processo|Sincronizar com o SEI/.test(txC) && rSave.ok === false && !abriu);
    ev(`Auth.user = {rg:'82061', nome:'ELOMIR GUMIERO DE MORAES', posto:'2º SGT PM', admin:true}`);
    checar('20.10 — zero erro JS não tratado no grupo 20', errosJs.length === 0, errosJs.join(' | '));
  }

  const falhas = resultados.filter(r => !r).length;
  console.log('');
  console.log(falhas === 0 ? `=== TODOS OS ${resultados.length} TESTES PASSARAM ===` : `=== ${falhas} DE ${resultados.length} TESTE(S) FALHARAM ===`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch(e => { console.error('ERRO FATAL NA SUITE:', e); process.exit(1); });
