(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var S = null, offset = 0, loadErr = '', voting = false, voteMsg = '';
  var regMsg = '', regErr = '', loginErr = '', lastRegKey = '', lastLoginKey = '', lastExp = -1;
  var STATUS = { attente: 'Pas encore ouvert', ouvert: 'Vote ouvert', egalite: 'Égalité', clos: 'Terminé' };

  function now() { return Date.now() + offset; }
  function safeUrl(u) {
    try { var x = new URL(String(u)); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : null; }
    catch (e) { return null; }
  }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return 'lien'; } }
  function fmtLeft(ms) {
    var m = Math.max(1, Math.ceil(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    if (d) return d + ' j ' + h + ' h';
    if (h) return h + ' h ' + String(mm).padStart(2, '0') + ' min';
    return mm + ' min';
  }
  function fmtDate(ms) {
    return new Date(ms).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  var seed = '';
  try {
    seed = localStorage.getItem('arene-seed') || '';
    if (!seed) { seed = Math.random().toString(36).slice(2); localStorage.setItem('arene-seed', seed); }
  } catch (e) { seed = Math.random().toString(36).slice(2); }
  function flip(id) {
    var s = seed + id, h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 2 === 1;
  }
  function roundName(r) {
    var n = S.matches.filter(function (m) { return m.round === r; }).length;
    if (n === 1) return 'Finale';
    if (n === 2) return 'Demi-finales';
    if (n === 4) return 'Quarts de finale';
    return 'Tour ' + r;
  }

  async function api(path, body) {
    var r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    var j = {};
    try { j = await r.json(); } catch (e) { /* vide */ }
    if (!r.ok) { var err = new Error(j.error || 'Erreur'); err.status = r.status; throw err; }
    return j;
  }
  async function load() {
    try {
      S = await api('/api/state');
      offset = S.now - Date.now();
      loadErr = '';
    } catch (e) { loadErr = 'Impossible de joindre le serveur. Nouvel essai en cours…'; }
    renderAll();
  }

  /* ---------- rendu ---------- */
  function renderHead() {
    var t = S && S.t;
    $('ttl').textContent = t && t.name ? t.name : 'Arène des Openings';
    var h = '';
    if (t) {
      var st = { inscription: 'Inscriptions ouvertes', en_cours: 'Tournoi en cours', termine: 'Terminé' }[t.status] || '';
      h += '<span class="chip ' + (t.status === 'en_cours' ? 'ok' : '') + '">' + st + '</span>';
      if (t.status === 'en_cours') h += '<span class="chip">Tour ' + t.round + ' sur ' + t.roundsTotal + '</span>';
      if (t.entrantCount) h += '<span class="chip">' + t.entrantCount + ' participants</span>';
    }
    if (S && S.stats.codes) h += '<span class="chip">' + S.stats.codes + ' codes émis · ' + S.stats.voted + ' ont voté</span>';
    $('stats').innerHTML = h;
  }

  function renderNotice() {
    var m = '';
    if (loadErr) m = loadErr;
    else if (!S) m = 'Chargement…';
    else if (!S.t) m = 'L\'organisateur n\'a pas encore créé le tournoi. Reviens plus tard.';
    $('notice').innerHTML = m ? '<p>' + esc(m) + '</p>' : '';
  }

  function renderLogin() {
    var el = $('login');
    if (!S || !S.t) { el.hidden = true; return; }
    var key = JSON.stringify([!!S.me, loginErr]);
    if (key === lastLoginKey) return;
    lastLoginKey = key;
    el.hidden = false;
    if (S.me) {
      el.innerHTML = '<div class="row"><p class="note">Tu es connecté avec ton code d\'invitation.</p><button class="btn small" id="logoutBtn" type="button">Changer de code</button></div>';
    } else {
      el.innerHTML = '<h2>Entre ton code</h2><p class="lead">Pour voter ou t\'inscrire, utilise ton code d\'invitation personnel. Tu peux suivre les duels sans code. Pas de code ? Demande-le à l\'organisateur.</p>' +
        '<form id="loginForm" class="stack"><label for="code">Code d\'invitation</label>' +
        '<input id="code" class="codefield" name="code" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required>' +
        '<button class="btn primary" type="submit">Entrer</button>' + (loginErr ? '<p class="err">' + esc(loginErr) + '</p>' : '') + '</form>';
    }
  }

  function renderReg() {
    var el = $('reg');
    if (!S || !S.t || !S.me) { el.hidden = true; lastRegKey = ''; return; }
    var key = JSON.stringify([S.t.status, S.me.entry, regMsg, regErr, S.matches.length]);
    if (key === lastRegKey) return;
    lastRegKey = key;
    var h = '', e = S.me.entry;
    if (S.t.status === 'inscription') {
      var v = e || {};
      h = '<h2>' + (e ? 'Ton inscription' : 'Inscris ton opening') + '</h2>' +
        '<p class="lead">Ton opening reste anonyme jusqu\'à la fin de son duel. Tu peux modifier ton inscription jusqu\'au tirage au sort.</p>' +
        '<form id="regForm" class="stack">' +
        '<label for="f-name">Ton pseudo (affiché après le duel)</label><input id="f-name" name="name" maxlength="40" required value="' + esc(v.name) + '">' +
        '<label for="f-anime">Anime</label><input id="f-anime" name="anime" maxlength="60" required value="' + esc(v.anime) + '">' +
        '<label for="f-title">Titre de l\'opening</label><input id="f-title" name="title" maxlength="80" required value="' + esc(v.title) + '">' +
        '<label for="f-link">Lien pour l\'écouter</label><input id="f-link" name="link" type="url" inputmode="url" maxlength="300" placeholder="https://" required value="' + esc(v.link) + '">' +
        '<button class="btn primary" type="submit">' + (e ? 'Mettre à jour' : 'Enregistrer mon inscription') + '</button>' +
        (regMsg ? '<p class="okmsg">' + esc(regMsg) + '</p>' : '') + (regErr ? '<p class="err">' + esc(regErr) + '</p>' : '') + '</form>';
    } else if (e && e.matchId) {
      var m = S.matches.find(function (x) { return x.id === e.matchId; });
      h = '<h2>Tu participes</h2><p>Ton opening : <strong>' + esc(e.title) + '</strong> (' + esc(e.anime) + ').</p>' +
        (m && m.status !== 'clos' ? '<p class="note">Ton duel en cours : ' + esc(roundName(m.round)) + ', duel ' + m.idx + '. Tu ne votes pas dans ce duel.</p>' : '');
    } else { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = h;
  }

  function renderChamp() {
    var el = $('champ');
    if (!S || !S.t || S.t.status !== 'termine' || !S.t.champion) { el.hidden = true; return; }
    var c = S.t.champion, u = safeUrl(c.link);
    el.hidden = false;
    el.className = 'champ';
    el.innerHTML = '<p class="eyebrow">Vainqueur du tournoi</p><h2>' + esc(c.title) + '</h2><p>' + esc(c.anime) + ' · présenté par <strong>' + esc(c.name) + '</strong></p>' +
      (u ? '<p><a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">Écouter sur ' + esc(hostOf(u)) + ' ↗</a></p>' : '');
  }

  function eligible(m) {
    return !!(S.me && m.status === 'ouvert' && now() < m.closesAt && !(S.me.entry && S.me.entry.matchId === m.id));
  }

  function optHTML(side, pos, m, mode) {
    var u = safeUrl(side.link), picked = S.me && S.me.votes[m.id] === side.slot;
    var mine = !!(S.me && S.me.entry && S.me.entry.slot === side.slot);
    var h = '<div class="opt s' + pos + (picked && mode === 'vote' ? ' picked' : '') + '">' +
      '<span class="badge" aria-hidden="true">' + pos + '</span><div class="obody">' +
      '<p class="otitle">' + esc(side.title) + '</p><p class="oanime">' + esc(side.anime) + '</p>' +
      '<p class="olink">' + (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">Écouter sur ' + esc(hostOf(u)) + ' ↗</a>' : '') +
      (mine ? '<span class="tag">Ton opening</span>' : '') + '</p></div>';
    if (mode === 'vote') {
      var can = eligible(m);
      h += '<button class="vote" data-m="' + esc(m.id) + '" data-s="' + esc(side.slot) + '" aria-pressed="' + (picked ? 'true' : 'false') + '"' +
        (can && !voting ? '' : ' disabled') + ' aria-label="Voter pour l\'opening ' + pos + '">' + (picked ? 'Ton vote ✓' : 'Voter pour celui-ci') + '</button>';
    } else if (mode === 'result') {
      var tl = m.tally || { a: 0, b: 0, total: 0 };
      var n = side.slot === m.a.slot ? tl.a : tl.b, pct = tl.total ? Math.round(100 * n / tl.total) : 0;
      var won = m.winnerSlot === side.slot;
      var nm = m.reveal ? (side.slot === m.a.slot ? m.reveal.a : m.reveal.b) : null;
      h += '<div class="res">' + (nm ? '<p class="oanime">Présenté par <strong>' + esc(nm) + '</strong>' + (won ? ' <span class="chip ok">Qualifié</span>' : '') + '</p>' : '') +
        '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div>' +
        '<p class="nums"><span>' + n + ' voix</span><span>' + pct + ' %</span></p></div>';
    }
    return h + '</div>';
  }

  function duelHTML(m) {
    var t = now();
    if (m.bye) {
      return '<article class="duel"><div class="dhead"><h3>Duel ' + m.idx + '</h3><span class="chip ok">Qualifié d\'office</span></div>' +
        '<p class="note">Nombre impair de participants : <strong>' + esc(m.reveal && m.reveal.a) + '</strong> passe directement au tour suivant.</p></article>';
    }
    var live = m.status === 'ouvert' && t < m.closesAt;
    var chipCls = live ? 'ok' : (m.status === 'egalite' ? 'warn' : '');
    var chipTxt = m.status === 'ouvert' && !live ? 'Calcul en cours' : STATUS[m.status];
    var h = '<article class="duel"><div class="dhead"><h3>Duel ' + m.idx + '</h3><span class="chip ' + chipCls + '">' + chipTxt + '</span></div>';
    if (m.status === 'ouvert') {
      h += '<p class="timer">' + (live ? 'Se termine dans <span data-closes="' + m.closesAt + '">' + fmtLeft(m.closesAt - t) + '</span> · ' + esc(fmtDate(m.closesAt))
        : 'Le vote est terminé, le résultat arrive.') + '</p>';
    }
    var mode = (m.status === 'clos' || m.status === 'egalite') ? 'result' : (m.status === 'ouvert' ? 'vote' : 'plain');
    var order = [m.a, m.b];
    if (mode !== 'result' && flip(m.id)) order = [m.b, m.a];
    h += optHTML(order[0], 1, m, mode) + '<div class="vs" aria-hidden="true">VS</div>' + optHTML(order[1], 2, m, mode);
    if (m.status === 'egalite') h += '<p class="note">Égalité parfaite. L\'organisateur doit prolonger le vote pour départager les deux openings.</p>';
    if (m.status === 'clos' && m.tally) {
      h += '<p class="note">' + m.tally.total + ' vote' + (m.tally.total > 1 ? 's' : '') + ' compté' + (m.tally.total > 1 ? 's' : '') +
        (m.tally.ignored ? ', ' + m.tally.ignored + ' écarté' + (m.tally.ignored > 1 ? 's' : '') + ' (participants du duel)' : '') + '.</p>';
    }
    if (live && S.me && S.me.votes[m.id]) h += '<p class="okmsg">Ton vote est enregistré. Tu peux le changer jusqu\'à la fin du duel.</p>';
    if (live && S.me && S.me.entry && S.me.entry.matchId === m.id) h += '<p class="note">C\'est ton duel : tu ne votes pas ici.</p>';
    if (live && !S.me) h += '<p class="note">Entre ton code d\'invitation en haut de la page pour voter.</p>';
    return h + '</article>';
  }

  function renderDuels() {
    var el = $('duels');
    if (!S || !S.t) { el.innerHTML = ''; return; }
    if (S.t.status === 'inscription') {
      el.innerHTML = '<h2>Duels</h2><p class="lead">Les duels apparaîtront ici après le tirage au sort, avec les deux openings face à face.</p>';
      return;
    }
    var rounds = {};
    S.matches.forEach(function (m) { (rounds[m.round] = rounds[m.round] || []).push(m); });
    var keys = Object.keys(rounds).map(Number).sort(function (a, b) { return b - a; });
    var h = '<h2>Duels</h2>' + (voteMsg ? '<p class="err">' + esc(voteMsg) + '</p>' : '');
    keys.forEach(function (r) {
      var ms = rounds[r].sort(function (a, b) { return a.idx - b.idx; });
      h += '<div class="round"><div class="round-head"><h3>' + esc(roundName(r)) + '</h3><span class="chip">Tour ' + r + '</span></div>' + ms.map(duelHTML).join('') + '</div>';
    });
    el.innerHTML = h;
  }

  function renderLog() {
    var logs = S ? S.log : [];
    $('log').innerHTML = logs.length ? logs.map(function (l) {
      return '<li><time>' + esc(new Date(l.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })) + '</time><span>' + esc(l.text) + '</span></li>';
    }).join('') : '<li><span class="note">Aucune action pour l\'instant. Elles apparaîtront ici dès que l\'organisateur agira.</span></li>';
  }

  function renderAll() { renderHead(); renderNotice(); renderLogin(); renderReg(); renderChamp(); renderDuels(); renderLog(); }

  /* ---------- actions ---------- */
  async function castVote(mid, slot) {
    if (voting) return;
    voting = true; voteMsg = ''; renderDuels();
    try {
      await api('/api/vote', { matchId: mid, slot: slot });
      S.me.votes[mid] = slot;
    } catch (e) { voteMsg = e.message || 'Ton vote n\'a pas pu être enregistré.'; }
    voting = false; renderDuels(); load();
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.classList.contains('vote')) castVote(b.getAttribute('data-m'), b.getAttribute('data-s'));
    else if (b.id === 'logoutBtn') api('/api/logout', {}).then(function () { lastLoginKey = ''; lastRegKey = ''; return load(); });
  });

  document.addEventListener('submit', async function (e) {
    e.preventDefault();
    var f = e.target;
    if (f.id === 'loginForm') {
      loginErr = '';
      try { await api('/api/redeem', { code: f.elements.code.value }); lastLoginKey = ''; }
      catch (er) { loginErr = er.message; lastLoginKey = ''; }
      await load();
    } else if (f.id === 'regForm') {
      regMsg = ''; regErr = '';
      var d = {};
      ['name', 'anime', 'title', 'link'].forEach(function (k) { d[k] = f.elements[k].value; });
      try { await api('/api/entry', d); regMsg = 'Inscription enregistrée.'; }
      catch (er) { regErr = er.message; }
      lastRegKey = '';
      await load();
    }
  });

  setInterval(function () {
    var t = now();
    document.querySelectorAll('[data-closes]').forEach(function (s) {
      var left = Number(s.getAttribute('data-closes')) - t;
      if (left > 0) s.textContent = fmtLeft(left);
    });
    if (!S) return;
    var c = S.matches.filter(function (m) { return m.status === 'ouvert' && t >= m.closesAt; }).length;
    if (c !== lastExp) { lastExp = c; renderDuels(); if (c) load(); }
  }, 1000);
  setInterval(load, 10000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });

  renderAll();
  load();
})();
