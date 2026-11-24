// Reproduz o relato real de 24/11/2026: "marco a folga e quando olho de novo
// não está marcado". SDK real: transaction() dispara os listeners NA HORA com
// o valor local (applyLocally). Se o app fecha / o celular dorme antes do
// servidor confirmar, a marcação precisa sobreviver e chegar ao servidor.
const { bootApp } = require('./boot');
const espera = ms => new Promise(r => setTimeout(r, ms));
async function cenario(checar) {
  const store = { '.info': { connected: true }, spaei: {} };
  const EF = [{ rg: 'ADM001', nome: 'Admin Teste', posto: 'CAP', admin: true }, { rg: '444444', nome: 'Membro Teste', posto: 'SD' }];
  store.spaei.efetivo = EF;
  // ── Aparelho do membro: abre, marca a folga, a rede não confirma, fecha ──
  const A = await bootApp({ store, otimista: true, conectar: true });
  A.window.eval(`Auth.user={rg:'444444',nome:'Membro Teste',posto:'SD'};`);
  await espera(2500);
  checar('22.0a — (pré-condição) 1º boot conectou, sincronizou e ouve o servidor', A.window.eval('_fbOk && _fbSynced && !!DB._realtimeInstalado'));
  const w = A.window.eval(`chaveDeData(calcSemana(1)[0].jsDate)`);
  A.ctl.congelado = true;
  A.window.eval(`DB.setCelulaEscala('${w}','444444',2,'FOLGA',defaultStatusSemana(false),'Escala de folgas');`);
  await espera(300);
  const localA = A.window.eval(`(DB.get('escalaSemanas')['${w}']||{})['444444']`);
  checar('22.1 — tela do membro mostra a FOLGA logo após marcar', localA && localA[2] === 'FOLGA', JSON.stringify(localA));
  const ls = {}; for (let i = 0; i < A.window.localStorage.length; i++) { const k = A.window.localStorage.key(i); ls[k] = A.window.localStorage.getItem(k); }
  A.window.close();
  const noServidor1 = store.spaei.escalaSemanas && store.spaei.escalaSemanas[w] && store.spaei.escalaSemanas[w]['444444'];
  checar('22.2 — (pré-condição) servidor ainda NÃO recebeu (rede congelada)', !noServidor1 || noServidor1[2] !== 'FOLGA');
  // ── Abre de novo o app no mesmo aparelho, rede normal ──
  const B = await bootApp({ store, otimista: true, conectar: true, localStorage: ls });
  B.window.eval(`Auth.user={rg:'444444',nome:'Membro Teste',posto:'SD'};`);
  await espera(2500);
  checar('22.0b — (pré-condição) 2º boot conectou e sincronizou de verdade', B.window.eval('_fbOk && _fbSynced'));
  const srv = store.spaei.escalaSemanas && store.spaei.escalaSemanas[w] && store.spaei.escalaSemanas[w]['444444'];
  checar('22.3 — ao reabrir, a FOLGA marcada chega ao servidor sozinha', !!srv && srv[2] === 'FOLGA', JSON.stringify(srv));
  const localB = B.window.eval(`(DB.get('escalaSemanas')['${w}']||{})['444444']`);
  checar('22.4 — e continua aparecendo marcada na tela', localB && localB[2] === 'FOLGA', JSON.stringify(localB));
  checar('22.5 — zero erro JS não tratado', A.errosJs.length + B.errosJs.length === 0, A.errosJs.concat(B.errosJs).join('; '));
  // ── Mesma sessão: rede cai no meio, evento otimista não pode "dar baixa" ──
  {
    const store2 = { '.info': { connected: true }, spaei: { efetivo: EF } };
    const C = await bootApp({ store: store2, otimista: true, conectar: true });
    C.window.eval(`Auth.user={rg:'444444',nome:'Membro Teste',posto:'SD'};`);
    await espera(2500);
    const w2 = C.window.eval(`chaveDeData(calcSemana(1)[0].jsDate)`);
    C.ctl.congelado = true;
    C.window.eval(`DB.setCelulaEscala('${w2}','444444',0,'DISPENSA',defaultStatusSemana(false),'Escala de folgas');`);
    await espera(300);
    checar('22.6 — sem confirmação do servidor a marcação continua na caixa de saída (pendente)', C.window.eval(`escOutN()===1 && !!_pendentes['escalaSemanas']`));
    // ADM em OUTRO aparelho marca outro dia da MESMA linha enquanto isso
    store2.spaei.escalaSemanas = store2.spaei.escalaSemanas || {}; store2.spaei.escalaSemanas[w2] = store2.spaei.escalaSemanas[w2] || {};
    const linhaSrv = (store2.spaei.escalaSemanas[w2]['444444'] || ['SERVIÇO','SERVIÇO','SERVIÇO','SERVIÇO','SERVIÇO','FOLGA','FOLGA']).slice();
    linhaSrv[4] = 'FOLGA'; store2.spaei.escalaSemanas[w2]['444444'] = linhaSrv;
    C.ctl.congelado = false;               // rede volta
    C.window.eval(`EscSync._voo={}; EscSync.flush('teste');`);
    await espera(600);
    const fin = store2.spaei.escalaSemanas[w2]['444444'];
    checar('22.7 — rede voltou: chega ao servidor sem apagar o dia marcado pelo ADM (merge por dia)', fin[0] === 'DISPENSA' && fin[4] === 'FOLGA', JSON.stringify(fin));
    checar('22.8 — caixa de saída esvazia e a pendência é limpa só após confirmação', C.window.eval(`escOutN()===0 && !_pendentes['escalaSemanas']`));
    // transação devolvendo erro: continua pendente e reenvia sozinha
    C.window.eval(`window.__orig=_fbDB.ref.bind(_fbDB); window.__falhar=true;
      _fbDB.ref=function(p){ const r=window.__orig(p); if(window.__falhar && String(p).includes('/escalaSemanas/')){ r.transaction=function(fn,cb){ setTimeout(()=>cb(new Error('falha simulada'),false,null),5); }; } return r; };
      DB.setCelulaEscala('${w2}','444444',1,'FOLGA',defaultStatusSemana(false),'Escala de folgas');`);
    await espera(200);
    checar('22.9 — erro de transação: marcação NÃO é descartada (segue na caixa)', C.window.eval(`escOutN()===1`));
    C.window.eval(`window.__falhar=false; EscSync.flush('teste');`);
    await espera(600);
    checar('22.10 — reenvio entrega o dia que falhou', store2.spaei.escalaSemanas[w2]['444444'][1] === 'FOLGA' && C.window.eval('escOutN()===0'), JSON.stringify(store2.spaei.escalaSemanas[w2]['444444']));
    // indicadores visuais na tela real de Folgas (navegação real)
    C.ctl.congelado = true;
    C.window.eval(`DB.setCelulaEscala('${w2}','444444',3,'FOLGA',defaultStatusSemana(false),'Escala de folgas'); Nav.current='folgas'; Render.folgas();`);
    await espera(200);
    // checagem no DOM real (nunca no texto serializado: o HTML inclui o próprio código-fonte do app)
    const domTem = (txt) => [...C.window.document.querySelectorAll('div')].some(d => d.textContent.trim().startsWith(txt));
    checar('22.12 — tela de Folgas mostra ⏳ e o aviso de "aguardando confirmação" enquanto pendente', C.window.document.querySelectorAll('span.esc-pend').length === 1 && domTem('⏳ 1 marcação(ões) aguardando'));
    C.ctl.congelado = false; C.window.eval(`EscSync._voo={}; EscSync.flush('teste');`);
    await espera(600);
    C.window.eval(`Render.folgas();`);
    checar('22.13 — após confirmar: some o ⏳ e aparece "✓ Escala confirmada no servidor"', C.window.document.querySelectorAll('span.esc-pend').length === 0 && domTem('✓ Escala confirmada no servidor') && !domTem('⏳ 1 marcação'));
    checar('22.11 — zero erro JS não tratado (cenário mesma sessão)', C.errosJs.length === 0, C.errosJs.join('; '));
  }
}
module.exports = { cenario };
if (require.main === module) {
  let falhas = 0;
  cenario((n, ok, x) => { console.log(`${ok ? '✅' : '❌'} ${n}${x !== undefined ? ' — ' + String(x).slice(0, 160) : ''}`); if (!ok) falhas++; })
    .then(() => { console.log(falhas ? `${falhas} FALHA(S)` : 'OK'); process.exit(falhas ? 1 : 0); });
  setTimeout(() => process.exit(2), 60000);
}
