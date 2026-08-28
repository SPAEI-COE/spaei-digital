// Testa o database.rules.json (proposta versionada, item 4) contra o
// Firebase RTDB Emulator de verdade — roda só em CI (job separado), nunca
// no sandbox de desenvolvimento (sem rede pra baixar o emulador ali).
// Confirma que a regra .validate aceita o formato certo (7 dias) e rejeita
// o formato errado, sem precisar confiar só na leitura humana do JSON.
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: 'spaei-digital-coe-teste',
    database: {
      rules: fs.readFileSync(path.join(__dirname, '..', '..', 'database.rules.json'), 'utf8'),
      host: '127.0.0.1',
      port: 9000,
    },
  });

  const db = testEnv.unauthenticatedContext().database();
  const resultados = [];
  function checar(nome, ok) { console.log((ok ? '✅' : '❌') + ' ' + nome); resultados.push(ok); }

  checar(
    'escalaSemanas com 7 dias é aceito',
    await assertSucceeds(
      db.ref('spaei/escalaSemanas/2026-W36/111111')
        .set(['SERVIÇO', 'SERVIÇO', 'SERVIÇO', 'SERVIÇO', 'SERVIÇO', 'FOLGA', 'FOLGA'])
        .then(() => true)
    )
  );

  checar(
    'escalaSemanas com 5 dias (formato errado) é REJEITADO',
    await assertFails(
      db.ref('spaei/escalaSemanas/2026-W36/222222')
        .set(['SERVIÇO', 'SERVIÇO', 'SERVIÇO', 'SERVIÇO', 'SERVIÇO'])
    ).then(() => true).catch(() => false)
  );

  checar(
    'pins exige hash+salt — sem hash é REJEITADO',
    await assertFails(
      db.ref('spaei/pins/333333').set({ salt: 'abc', criado: '01/01/2026', ativo: true })
    ).then(() => true).catch(() => false)
  );

  checar(
    'pins com hash+salt é aceito',
    await assertSucceeds(
      db.ref('spaei/pins/444444').set({ hash: 'xyz', salt: 'abc', criado: '01/01/2026', ativo: true }).then(() => true)
    )
  );

  await testEnv.cleanup();
  const falhas = resultados.filter(r => !r).length;
  console.log('');
  console.log(falhas === 0 ? `=== TODOS OS ${resultados.length} TESTES DE REGRAS PASSARAM ===` : `=== ${falhas} FALHA(S) ===`);
  process.exit(falhas === 0 ? 0 : 1);
}

main().catch(e => { console.error('ERRO FATAL:', e); process.exit(1); });
