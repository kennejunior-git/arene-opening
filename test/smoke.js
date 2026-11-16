'use strict';
// Test de bout en bout : lance le serveur (votes de 3 s, prolongations de 3 s) et joue un tournoi complet.
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = 'http://127.0.0.1:' + PORT;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arene-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WAIT = 3800; // un peu plus que 3 s

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
    env: Object.assign({}, process.env, {
      PORT: String(PORT), DATA_DIR: dataDir, ADMIN_PASSWORD: 'motdepasse-test', TICK_MS: '200',
      VOTE_MINUTES: '0.05', EXTEND_MINUTES: '0.05', MAX_EXTENSIONS: '1'
    }),
    stdio: ['ignore', 'inherit', 'inherit']
  });
  let ok = false;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/state'); break; } catch (e) { await sleep(100); } }

    const stats = await fetch(BASE + '/stats');
    assert.equal(stats.status, 200, 'page de statistiques servie');
    assert.ok((await stats.text()).includes('Statistiques'));

    const adm = client();
    assert.equal((await adm('GET', '/api/admin/state')).status, 401, 'admin sans connexion refusé');
    assert.equal((await adm('POST', '/api/admin/login', { password: 'faux' })).status, 401);
    assert.equal((await adm('POST', '/api/admin/login', { password: 'motdepasse-test' })).status, 200);
    assert.equal((await adm('POST', '/api/admin/create', { name: 'Test' })).status, 200);
    assert.equal((await adm('POST', '/api/admin/codes', { count: 10 })).status, 200);
    const codes = (await adm('GET', '/api/admin/state')).body.codes.map((c) => c.code);
    assert.equal(codes.length, 10);
    assert.match(codes[0], /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // 9 personnes : 5 participants (0-4) et 4 votants (5-8), pseudos Votant0..Votant8
    const people = [];
    for (let i = 0; i < 9; i++) {
      const c = client();
      assert.equal((await c('POST', '/api/redeem', { code: codes[i].toLowerCase().replace('-', ' '), name: 'Votant' + i })).status, 200, 'code accepté (casse et tiret libres)');
      people.push(c);
    }
    // pseudos
    assert.equal((await client()('POST', '/api/redeem', { code: codes[9] })).status, 400, 'pseudo obligatoire à la première connexion');
    assert.equal((await client()('POST', '/api/redeem', { code: codes[9], name: 'votant5' })).status, 409, 'pseudo déjà pris (casse ignorée)');
    const extra = client();
    assert.equal((await extra('POST', '/api/redeem', { code: codes[9], name: 'Extra' })).status, 200);
    assert.equal((await client()('POST', '/api/redeem', { code: codes[9] })).status, 200, 'même code sur un autre appareil sans pseudo');
    assert.equal((await client()('POST', '/api/redeem', { code: 'ZZZZ-ZZZZ' })).status, 401, 'faux code refusé');
    assert.equal((await client()('POST', '/api/entry', { name: 'x', anime: 'x', title: 'x', link: 'https://x.fr' })).status, 401, 'inscription sans code refusée');
    assert.equal((await people[5]('GET', '/api/state')).body.me.name, 'Votant5');

    for (let i = 0; i < 5; i++) {
      const r = await people[i]('POST', '/api/entry', { name: 'Pseudo' + i, anime: 'Anime' + i, title: 'Opening' + i, link: 'https://youtu.be/abc' + i });
      assert.equal(r.status, 200);
    }
    assert.equal((await people[0]('POST', '/api/entry', { name: 'a', anime: 'b', title: 'c', link: 'javascript:alert(1)' })).status, 400, 'lien dangereux refusé');
    assert.equal((await client()('GET', '/api/state')).body.stats.entrants, 5, 'compteur public d\'inscrits');
    assert.equal((await adm('POST', '/api/admin/draw')).status, 200);
    assert.equal((await people[0]('POST', '/api/entry', { name: 'a', anime: 'b', title: 'c', link: 'https://x.fr' })).status, 409, 'inscription fermée après le tirage');

    let st = (await adm('GET', '/api/admin/state')).body;
    assert.equal(st.t.roundsTotal, 3);
    assert.equal(st.cfg.voteMinutes, 0.05);
    assert.equal(st.matches.length, 3, '5 participants = 2 duels + 1 qualifié d\'office');
    assert.equal(st.matches.filter((m) => m.bye).length, 1);

    let tieDone = false, liveChecked = false, loops = 0;
    while (st.t.status !== 'termine') {
      assert.ok(++loops < 12, 'le tournoi doit se terminer');
      const cur = st.matches.filter((m) => m.round === st.t.round);
      if (cur.some((m) => m.status === 'attente')) {
        const finale = cur.length === 1;
        assert.equal((await adm('POST', '/api/admin/open', { live: finale })).status, 200);
        assert.equal((await adm('POST', '/api/admin/open', {})).status, 409, 'plus rien à ouvrir');
        const live = (await adm('GET', '/api/admin/state')).body.matches.filter((m) => m.round === st.t.round && m.status === 'ouvert');
        assert.ok(live.length >= 1);
        // personne sans code, ni l'organisateur, ne vote
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
            // égalité 2-2 sur le premier duel du premier tour
            const makeTie = !tieDone && m === live[0];
            const slot = (makeTie && v >= 7) ? m.b.slot : m.a.slot;
            assert.equal((await people[v]('POST', '/api/vote', { matchId: m.id, slot: slot })).status, 200);
          }
        }
        // ce que voit le public pendant le vote : nombre de votes, aucun nom de votant
        const pub = (await client()('GET', '/api/state')).body;
        const raw = JSON.stringify([pub.matches.filter((x) => x.status !== 'clos'), pub.me]); // les duels déjà terminés montrent légitimement leurs votants
        for (let i = 0; i < 9; i++) assert.ok(!raw.includes('Votant' + i), 'les pseudos des votants ne fuient pas pendant le vote');
        for (const m of live) {
          const pm = pub.matches.find((x) => x.id === m.id);
          assert.equal(pm.votes, 4, 'nombre de votes visible');
          assert.equal(pm.voters, undefined);
          if (finale) { assert.ok(pm.liveTally && pm.liveTally.a + pm.liveTally.b === 4, 'score en direct activé'); liveChecked = true; }
          else assert.equal(pm.liveTally, undefined, 'score caché par défaut');
        }
      }
      await sleep(WAIT);
      st = (await adm('GET', '/api/admin/state')).body;
      if (!tieDone) {
        const m = st.matches.find((x) => x.id === 'r1m1');
        assert.equal(m.status, 'ouvert', 'égalité : le vote continue');
        assert.equal(m.extensions, 1, 'une prolongation automatique');
        assert.ok(st.log.some((l) => l.text.includes('égalité 2 à 2') && l.text.includes('Prolongation 1')), 'prolongation écrite dans le journal');
        assert.equal(m.tally, undefined, 'score toujours caché');
        // un votant change d'avis pendant la prolongation
        assert.equal((await people[7]('POST', '/api/vote', { matchId: m.id, slot: m.a.slot })).status, 200);
        tieDone = true;
        await sleep(WAIT);
        st = (await adm('GET', '/api/admin/state')).body;
      }
      assert.ok(!st.matches.some((m) => m.status === 'ouvert'), 'tous les duels sont clos automatiquement');
      const curDone = st.matches.filter((m) => m.round === st.t.round);
      if (curDone.every((m) => m.status === 'clos')) {
        curDone.filter((m) => !m.bye).forEach((m) => {
          assert.ok(m.reveal && m.tally && m.tally.total > 0, 'noms et score publiés après clôture');
          const names = m.voters.a.concat(m.voters.b);
          assert.equal(names.length, m.tally.total, 'un nom par vote');
          names.forEach((n) => assert.match(n, /^Votant[5-8]$/));
          assert.equal(m.voters.a.length, m.tally.a);
        });
        assert.equal((await adm('POST', '/api/admin/next')).status, 200);
      }
      st = (await adm('GET', '/api/admin/state')).body;
    }
    assert.ok(liveChecked, 'le score en direct a été testé');
    const r1 = st.matches.find((m) => m.id === 'r1m1');
    assert.equal(r1.tally.a, 3, 'après changement de vote : 3 contre 1');
    assert.equal(r1.extensions, 1);
    assert.ok(st.t.champion && st.t.champion.name.startsWith('Pseudo'));
    assert.ok(st.log.length >= 8);

    // égalité persistante : après MAX_EXTENSIONS (1), le serveur tire au sort
    assert.equal((await adm('POST', '/api/admin/reset', { confirm: 'NOUVEAU' })).status, 200);
    assert.equal((await adm('POST', '/api/admin/create', { name: 'Egalite' })).status, 200);
    for (let i = 0; i < 2; i++) await people[i]('POST', '/api/entry', { name: 'P' + i, anime: 'A', title: 'T' + i, link: 'https://x.fr/' + i });
    assert.equal((await adm('POST', '/api/admin/draw')).status, 200);
    assert.equal((await adm('POST', '/api/admin/open', {})).status, 200);
    await sleep(WAIT * 2 + 800);
    st = (await adm('GET', '/api/admin/state')).body;
    assert.equal(st.matches[0].status, 'clos');
    assert.equal(st.matches[0].byLot, true, 'gagnant tiré au sort');
    assert.ok(st.log.some((l) => l.text.includes('tiré au sort')), 'tirage au sort écrit dans le journal');

    // les codes (et leurs pseudos) survivent à un nouveau tournoi
    assert.equal((await adm('GET', '/api/admin/state')).body.codes.length, 10);
    assert.equal((await people[5]('GET', '/api/state')).body.me.name, 'Votant5');
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
