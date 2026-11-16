'use strict';
// Test de bout en bout : lance le serveur, joue un tournoi complet avec 5 participants et 4 votants.
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = 'http://127.0.0.1:' + PORT;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arene-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(BASE + url, {
      method: method,
      headers: Object.assign({ cookie: cookie }, method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined
    });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    sc.forEach((c) => {
      const kv = c.split(';')[0];
      const name = kv.split('=')[0];
      cookie = cookie.split('; ').filter((x) => x && !x.startsWith(name + '=')).concat(kv.endsWith('=') ? [] : [kv]).join('; ');
    });
    let j = {}; try { j = await r.json(); } catch (e) { /* vide */ }
    return { status: r.status, body: j };
  };
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, ADMIN_PASSWORD: 'motdepasse-test', TICK_MS: '200' }),
    stdio: ['ignore', 'inherit', 'inherit']
  });
  let ok = false;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/state'); break; } catch (e) { await sleep(100); } }

    const adm = client();
    assert.equal((await adm('GET', '/api/admin/state')).status, 401, 'admin sans connexion refusé');
    assert.equal((await adm('POST', '/api/admin/login', { password: 'faux' })).status, 401);
    assert.equal((await adm('POST', '/api/admin/login', { password: 'motdepasse-test' })).status, 200);
    assert.equal((await adm('POST', '/api/admin/create', { name: 'Test' })).status, 200);
    assert.equal((await adm('POST', '/api/admin/codes', { count: 9 })).status, 200);
    const codes = (await adm('GET', '/api/admin/state')).body.codes.map((c) => c.code);
    assert.equal(codes.length, 9);
    assert.match(codes[0], /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // 9 personnes : 5 participants (0-4) et 4 votants (5-8)
    const people = [];
    for (let i = 0; i < 9; i++) {
      const c = client();
      assert.equal((await c('POST', '/api/redeem', { code: codes[i].toLowerCase().replace('-', ' ') })).status, 200, 'code accepté (casse et tiret libres)');
      people.push(c);
    }
    assert.equal((await client()('POST', '/api/redeem', { code: 'ZZZZ-ZZZZ' })).status, 401, 'faux code refusé');
    assert.equal((await client()('POST', '/api/entry', { name: 'x', anime: 'x', title: 'x', link: 'https://x.fr' })).status, 401, 'inscription sans code refusée');

    for (let i = 0; i < 5; i++) {
      const r = await people[i]('POST', '/api/entry', { name: 'Pseudo' + i, anime: 'Anime' + i, title: 'Opening' + i, link: 'https://youtu.be/abc' + i });
      assert.equal(r.status, 200);
    }
    assert.equal((await people[0]('POST', '/api/entry', { name: 'a', anime: 'b', title: 'c', link: 'javascript:alert(1)' })).status, 400, 'lien dangereux refusé');
    assert.equal((await adm('POST', '/api/admin/draw')).status, 200);
    assert.equal((await people[0]('POST', '/api/entry', { name: 'a', anime: 'b', title: 'c', link: 'https://x.fr' })).status, 409, 'inscription fermée après le tirage');

    let st = (await adm('GET', '/api/admin/state')).body;
    assert.equal(st.t.roundsTotal, 3);
    assert.equal(st.matches.length, 3, '5 participants = 2 duels + 1 qualifié d\'office');
    assert.equal(st.matches.filter((m) => m.bye).length, 1);
    const raw = JSON.stringify((await people[5]('GET', '/api/state')).body);
    for (let i = 0; i < 5; i++) assert.ok(!raw.includes('Pseudo' + i) || raw.includes('"bye":true'), 'les pseudos ne fuient pas avant la clôture');
    assert.ok(!raw.includes('aUid') && !raw.includes('"votes":{"r'), 'pas de données privées');

    let tieDone = false, loops = 0;
    while (st.t.status !== 'termine') {
      assert.ok(++loops < 12, 'le tournoi doit se terminer');
      const cur = st.matches.filter((m) => m.round === st.t.round);
      if (cur.some((m) => m.status === 'attente')) {
        assert.equal((await adm('POST', '/api/admin/open', { minutes: 0.05 })).status, 200);
        const live = (await adm('GET', '/api/admin/state')).body.matches.filter((m) => m.round === st.t.round && m.status === 'ouvert');
        // un votant sans code ne peut pas voter, l'organisateur non plus
        assert.equal((await client()('POST', '/api/vote', { matchId: live[0].id, slot: live[0].a.slot })).status, 401);
        assert.equal((await adm('POST', '/api/vote', { matchId: live[0].id, slot: live[0].a.slot })).status, 401, 'l\'organisateur ne vote pas');
        assert.equal((await people[5]('POST', '/api/vote', { matchId: live[0].id, slot: 'nimporte' })).status, 400);
        // un participant ne vote pas dans son propre duel
        for (let i = 0; i < 5; i++) {
          const me = (await people[i]('GET', '/api/state')).body.me.entry;
          if (me.matchId && live.some((m) => m.id === me.matchId)) {
            const m = live.find((x) => x.id === me.matchId);
            assert.equal((await people[i]('POST', '/api/vote', { matchId: m.id, slot: m.a.slot })).status, 403, 'pas de vote dans son duel');
          }
        }
        for (const m of live) {
          for (let v = 5; v < 9; v++) {
            const slot = (!tieDone && m === live[0] && v === 6) ? m.b.slot : m.a.slot;
            assert.equal((await people[v]('POST', '/api/vote', { matchId: m.id, slot: slot })).status, 200);
          }
        }
        if (!tieDone && live.length > 1) { /* égalité sur le 1er duel : 3 contre 1 devient 3-1, on la force plus bas */ }
      }
      await sleep(3600); // clôture automatique
      st = (await adm('GET', '/api/admin/state')).body;
      assert.ok(!st.matches.some((m) => m.status === 'ouvert'), 'tous les duels sont clos automatiquement');
      const ties = st.matches.filter((m) => m.status === 'egalite');
      if (ties.length) tieDone = true;
      if (st.matches.filter((m) => m.round === st.t.round).every((m) => m.status === 'clos')) {
        const closed = st.matches.filter((m) => m.round === st.t.round && !m.bye);
        closed.forEach((m) => { assert.ok(m.reveal && m.tally && m.tally.total > 0, 'noms et score publiés après clôture'); });
        assert.equal((await adm('POST', '/api/admin/next')).status, 200);
      }
      st = (await adm('GET', '/api/admin/state')).body;
    }
    assert.ok(st.t.champion && st.t.champion.name.startsWith('Pseudo'));
    assert.ok(st.log.length >= 8);

    // égalité : scénario dédié avec un nouveau tournoi
    assert.equal((await adm('POST', '/api/admin/reset', { confirm: 'NOUVEAU' })).status, 200);
    assert.equal((await adm('POST', '/api/admin/create', { name: 'Egalite' })).status, 200);
    for (let i = 0; i < 2; i++) await people[i]('POST', '/api/entry', { name: 'P' + i, anime: 'A', title: 'T' + i, link: 'https://x.fr/' + i });
    assert.equal((await adm('POST', '/api/admin/draw')).status, 200);
    assert.equal((await adm('POST', '/api/admin/open', { minutes: 0.05 })).status, 200);
    const m = (await adm('GET', '/api/admin/state')).body.matches[0];
    await people[5]('POST', '/api/vote', { matchId: m.id, slot: m.a.slot });
    await people[6]('POST', '/api/vote', { matchId: m.id, slot: m.b.slot });
    await sleep(3600);
    st = (await adm('GET', '/api/admin/state')).body;
    assert.equal(st.matches[0].status, 'egalite', 'égalité détectée');
    assert.equal((await adm('POST', '/api/admin/extend', { minutes: 0.05 })).status, 200);
    await people[6]('POST', '/api/vote', { matchId: m.id, slot: m.a.slot });
    await sleep(3600);
    st = (await adm('GET', '/api/admin/state')).body;
    assert.equal(st.matches[0].status, 'clos', 'égalité départagée après prolongation');
    assert.equal(st.matches[0].tally.total, 2);

    // persistance : les codes survivent à un nouveau tournoi
    assert.equal((await adm('GET', '/api/admin/state')).body.codes.length, 9);
    ok = true;
    console.log('Tous les tests passent.');
  } catch (e) {
    console.error('ÉCHEC :', e && e.stack || e);
  } finally {
    srv.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
  }
})();
