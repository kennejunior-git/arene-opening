(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var DURS = [[10, '10 minutes (essai)'], [720, '12 heures'], [1440, '24 heures'], [2880, '48 heures'], [4320, '72 heures']];
  var A = null, authed = false, busy = false, err = '', info = '', armed = null, dur = 1440, lastKey = '', lastExp = -1;
  var draft = { password: '', tname: '', count: '20', confirm: '' };

  function fmtDate(ms) {
    return new Date(ms).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  async function api(path, body) {
    var r = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    var j = {};
    try { j = await r.json(); } catch (e) { /* vide */ }
    if (!r.ok) { var er = new Error(j.error || 'Erreur'); er.status = r.status; throw er; }
    return j;
  }
  function durSelect() {
    return '<select id="dur" aria-label="Durée du vote">' + DURS.map(function (d) {
      return '<option value="' + d[0] + '"' + (d[0] === dur ? ' selected' : '') + '>' + d[1] + '</option>';
    }).join('') + '</select>';
  }

  async function load() {
    try { A = await api('/api/admin/state'); authed = true; }
    catch (e) { if (e.status === 401) { authed = false; A = null; } else { err = 'Impossible de joindre le serveur.'; } }
    render(true);
  }

  function render(force) {
    var key = JSON.stringify([authed, A && A.t, A && A.entrantCount, A && A.stats, A && A.codes, A && A.matches.map(function (m) { return [m.id, m.status, m.closesAt]; }), busy, err, info, armed, dur]);
    if (!force && key === lastKey) return;
    if (key === lastKey) return;
    lastKey = key;
    $('logout').hidden = !authed;
    var el = $('app');
    if (!authed) {
      el.innerHTML = '<section class="panel"><h2>Connexion</h2><form id="loginForm" class="stack"><label for="pw">Mot de passe organisateur</label>' +
        '<input id="pw" type="password" autocomplete="current-password" required value="' + esc(draft.password) + '">' +
        '<button class="btn primary" type="submit">Se connecter</button>' + (err ? '<p class="err">' + esc(err) + '</p>' : '') + '</form></section>';
      return;
    }
    var dis = busy ? ' disabled' : '';
    var h = '';

    /* tournoi */
    h += '<section class="panel"><h2>Tournoi</h2>';
    if (!A.t) {
      h += '<form id="createForm" class="stack"><p class="lead">Donne un nom au tournoi. Les inscriptions s\'ouvrent tout de suite.</p>' +
        '<label for="tname">Nom du tournoi</label><input id="tname" maxlength="60" placeholder="Ex. Battle d\'openings, saison 1" required value="' + esc(draft.tname) + '">' +
        '<button class="btn primary" type="submit"' + dis + '>Créer le tournoi</button></form>';
    } else {
      var st = { inscription: 'Inscriptions ouvertes', en_cours: 'En cours', termine: 'Terminé' }[A.t.status];
      h += '<p><strong>' + esc(A.t.name) + '</strong> <span class="chip ' + (A.t.status === 'en_cours' ? 'ok' : '') + '">' + st + '</span></p>';
    }
    h += '</section>';

    /* codes */
    var unused = A.codes.filter(function (c) { return !c.used; });
    h += '<section class="panel"><h2>Codes d\'invitation</h2>' +
      '<p class="lead">Un code par personne, à envoyer en privé. Chaque code ne vote qu\'une fois par duel. Le nombre de codes émis est affiché publiquement : n\'en génère pas plus que de membres dans ton groupe.</p>' +
      '<form id="codesForm" class="row"><label for="count" class="note">Combien de codes ?</label><input id="count" type="number" min="1" max="300" value="' + esc(draft.count) + '" required>' +
      '<button class="btn primary" type="submit"' + dis + '>Générer</button></form>';
    if (A.codes.length) {
      h += '<p class="note">' + A.codes.length + ' émis · ' + (A.codes.length - unused.length) + ' déjà utilisés · ' + unused.length + ' à distribuer</p>' +
        '<div class="row"><button class="btn small" id="copyBtn" type="button"' + (unused.length ? '' : ' disabled') + '>Copier les codes non utilisés</button>' +
        '<button class="btn small" id="dlBtn" type="button">Télécharger tous les codes</button></div>' +
        '<ul class="codes">' + A.codes.map(function (c) { return '<li class="' + (c.used ? 'used' : '') + '">' + esc(c.code) + '</li>'; }).join('') + '</ul>';
    }
    h += '</section>';

    /* déroulement */
    h += '<section class="panel"><h2>Déroulement</h2>';
    if (!A.t) {
      h += '<p class="lead">Crée d\'abord le tournoi.</p>';
    } else if (A.t.status === 'inscription') {
      var n = A.entrantCount;
      h += '<div class="block"><p><strong>' + n + ' inscrit' + (n > 1 ? 's' : '') + '</strong> pour l\'instant.</p>' +
        '<p class="note">Le tirage au sort forme les binômes au hasard et mélange l\'ordre des deux openings. Il ferme les inscriptions. Avec un nombre impair d\'inscrits, un participant tiré au sort passe d\'office au tour suivant. Tu ne vois pas qui est inscrit : les duels restent anonymes pour toi aussi.</p>' +
        '<button class="btn ' + (armed === 'draw' ? 'armed' : 'primary') + '" data-act="draw"' + (n < 2 || busy ? ' disabled' : '') + '>' +
        (armed === 'draw' ? 'Confirmer : fermer et tirer au sort' : 'Fermer les inscriptions et tirer au sort') + '</button>' +
        (n < 2 ? '<p class="hint">Il faut au moins 2 inscrits.</p>' : '') + '</div>';
    } else if (A.t.status === 'en_cours') {
      var cur = A.matches.filter(function (m) { return m.round === A.t.round; });
      var pend = cur.filter(function (m) { return m.status === 'attente'; });
      var open = cur.filter(function (m) { return m.status === 'ouvert'; });
      var tie = cur.filter(function (m) { return m.status === 'egalite'; });
      var allClosed = cur.length > 0 && cur.every(function (m) { return m.status === 'clos'; });
      h += '<p class="note">Tour ' + A.t.round + ' sur ' + A.t.roundsTotal + ' · ' + cur.length + ' duel' + (cur.length > 1 ? 's' : '') + '.</p>';
      if (pend.length) {
        h += '<div class="block"><p><strong>' + pend.length + ' duel' + (pend.length > 1 ? 's' : '') + '</strong> prêt' + (pend.length > 1 ? 's' : '') + ' à ouvrir.</p>' +
          '<div class="row">' + durSelect() + '<button class="btn primary" data-act="open"' + dis + '>Ouvrir les votes</button></div></div>';
      }
      if (open.length) {
        var last = Math.max.apply(null, open.map(function (m) { return m.closesAt; }));
        h += '<div class="block"><p class="note">Votes ouverts. Clôture <strong>automatique</strong> le ' + esc(fmtDate(last)) + ' : le serveur compte les voix et publie les scores sans toi.</p></div>';
      }
      if (tie.length) {
        h += '<div class="block"><p><strong>' + tie.length + ' duel' + (tie.length > 1 ? 's' : '') + ' à égalité.</strong> Prolonge le vote pour les départager.</p>' +
          '<div class="row">' + durSelect() + '<button class="btn primary" data-act="extend"' + dis + '>Prolonger le vote</button></div></div>';
      }
      if (allClosed) {
        h += '<div class="block"><p>Tous les duels du tour sont terminés.</p><button class="btn primary" data-act="next"' + dis + '>' +
          (cur.length === 1 ? 'Couronner le vainqueur' : 'Lancer le tour suivant') + '</button></div>';
      }
    } else {
      h += '<p class="lead">Le tournoi est terminé. Le journal public garde la trace de toutes les actions.</p>';
    }
    if (busy) h += '<p class="note">Action en cours…</p>';
    if (info) h += '<p class="okmsg">' + esc(info) + '</p>';
    if (err) h += '<p class="err">' + esc(err) + '</p>';
    h += '</section>';

    /* nouveau tournoi */
    if (A.t) {
      h += '<section class="panel"><h2>Nouveau tournoi</h2><p class="lead">Archive le tournoi actuel (inscriptions, duels, votes) et repart de zéro. Les codes d\'invitation sont conservés : les membres gardent le leur.</p>' +
        '<form id="resetForm" class="row"><label for="confirm" class="note">Tape NOUVEAU</label><input id="confirm" autocomplete="off" value="' + esc(draft.confirm) + '">' +
        '<button class="btn small" type="submit"' + dis + '>Archiver et recommencer</button></form></section>';
    }
    el.innerHTML = h;
  }

  async function run(fn, okMsg) {
    if (busy) return;
    busy = true; err = ''; info = ''; render();
    try { await fn(); info = okMsg || ''; } catch (e) { err = e.message || 'Action impossible.'; if (e.status === 401) authed = false; }
    busy = false; armed = null;
    try { A = await api('/api/admin/state'); } catch (e) { /* ignoré */ }
    render();
  }

  function codesText(list) { return list.map(function (c) { return c.code; }).join('\n'); }

  document.addEventListener('input', function (e) {
    var id = e.target.id;
    if (id === 'pw') draft.password = e.target.value;
    else if (id === 'tname') draft.tname = e.target.value;
    else if (id === 'count') draft.count = e.target.value;
    else if (id === 'confirm') draft.confirm = e.target.value;
  });
  document.addEventListener('change', function (e) {
    if (e.target.id === 'dur') { dur = Number(e.target.value) || 1440; render(); }
  });
  document.addEventListener('click', async function (e) {
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    var a = b.getAttribute('data-act');
    if (b.id === 'logout') { await api('/api/admin/logout', {}); authed = false; A = null; render(true); }
    else if (b.id === 'copyBtn') {
      var txt = codesText(A.codes.filter(function (c) { return !c.used; }));
      try { await navigator.clipboard.writeText(txt); info = 'Codes copiés.'; err = ''; }
      catch (er) { err = 'Copie impossible : télécharge le fichier à la place.'; }
      render();
    } else if (b.id === 'dlBtn') {
      var url = URL.createObjectURL(new Blob([codesText(A.codes) + '\n'], { type: 'text/plain' }));
      var l = document.createElement('a'); l.href = url; l.download = 'codes-invitation.txt'; document.body.appendChild(l); l.click(); l.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    } else if (a === 'draw') {
      if (armed !== 'draw') { armed = 'draw'; render(); setTimeout(function () { if (armed === 'draw') { armed = null; render(); } }, 6000); }
      else run(function () { return api('/api/admin/draw', {}); }, 'Tirage au sort effectué.');
    } else if (a === 'open') run(function () { return api('/api/admin/open', { minutes: dur }); }, 'Votes ouverts.');
    else if (a === 'extend') run(function () { return api('/api/admin/extend', { minutes: dur }); }, 'Vote prolongé.');
    else if (a === 'next') run(function () { return api('/api/admin/next', {}); }, 'Tour suivant prêt.');
  });
  document.addEventListener('submit', async function (e) {
    e.preventDefault();
    var f = e.target.id;
    if (f === 'loginForm') {
      err = '';
      try { await api('/api/admin/login', { password: draft.password }); draft.password = ''; await load(); }
      catch (er) { err = er.message; render(true); }
    } else if (f === 'createForm') run(function () { return api('/api/admin/create', { name: draft.tname }); }, 'Tournoi créé.');
    else if (f === 'codesForm') run(function () { return api('/api/admin/codes', { count: Number(draft.count) }); }, 'Codes générés.');
    else if (f === 'resetForm') run(function () { return api('/api/admin/reset', { confirm: draft.confirm }).then(function () { draft.confirm = ''; }); }, 'Nouveau tournoi prêt.');
  });

  setInterval(function () { if (authed && !busy) load(); }, 10000);
  render(true);
  load();
})();
