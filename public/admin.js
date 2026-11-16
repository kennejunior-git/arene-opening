(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var A = null, authed = false, busy = false, err = '', info = '', armed = null, lastKey = '', lastExp = -1;
  var draft = { password: '', tname: '', count: '20', confirm: '', live: false };

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
  function fmtMin(m) { return m >= 60 && m % 60 === 0 ? (m / 60) + ' h' : m + ' min'; }
  function fmtLeft(ms) {
    var m = Math.max(1, Math.ceil(ms / 60000)), h = Math.floor(m / 60), mm = m % 60;
    return h ? h + ' h ' + String(mm).padStart(2, '0') + ' min' : mm + ' min';
  }
  function nowMs() { return Date.now() + (A ? A.now - fetchedAt : 0); }
  var fetchedAt = Date.now();

  async function load() {
    try { A = await api('/api/admin/state'); fetchedAt = Date.now(); authed = true; }
    catch (e) { if (e.status === 401) { authed = false; A = null; } else { err = 'Impossible de joindre le serveur.'; } }
    render(true);
  }

  function render(force) {
    var key = JSON.stringify([authed, A && A.t, A && A.entrantCount, A && A.stats, A && A.codes, A && A.players, A && A.bonuses, A && A.matches.map(function (m) { return [m.id, m.status, m.closesAt, m.votes, m.extensions]; }), busy, err, info, armed]);
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
      var allClosed = cur.length > 0 && cur.every(function (m) { return m.status === 'clos'; });
      var vm = A.cfg.voteMinutes, em = A.cfg.extendMinutes;
      h += '<p class="note">Tour ' + A.t.round + ' sur ' + A.t.roundsTotal + ' · ' + cur.length + ' duel' + (cur.length > 1 ? 's' : '') + '. Chaque vote dure ' + fmtMin(vm) +
        '. En cas d\'égalité, ' + fmtMin(em) + ' sont ajoutées automatiquement (jusqu\'à ' + A.cfg.maxExtensions + ' fois, puis le serveur tire au sort). La clôture se fait toute seule.</p>';
      h += '<ul class="dlist">' + cur.map(function (m) {
        var info = '', btn = '';
        if (m.bye) info = '<span class="chip ok">Qualifié d\'office</span>';
        else if (m.status === 'attente') {
          info = '<span class="chip">En attente</span>';
          btn = '<button class="btn small primary" data-act="open" data-m="' + esc(m.id) + '"' + dis + '>Ouvrir (' + fmtMin(vm) + ')</button>';
        } else if (m.status === 'ouvert') {
          info = '<span class="chip ok">Vote ouvert</span> <span class="note">' + m.votes + ' vote' + (m.votes > 1 ? 's' : '') + ' · fin dans <span data-closes="' + m.closesAt + '">' + fmtLeft(m.closesAt - nowMs()) + '</span>' +
            (m.extensions ? ' · prolongation ' + m.extensions : '') + (m.live ? ' · score en direct' : '') + '</span>';
        } else {
          info = '<span class="chip">Terminé</span> <span class="note">' + (m.tally ? m.tally.a + ' – ' + m.tally.b : '') + (m.byLot ? ' · tirage au sort' : '') + '</span>';
        }
        return '<li><div class="info"><strong>Duel ' + m.idx + '</strong><span>' + info + '</span></div>' + btn + '</li>';
      }).join('') + '</ul>';
      if (pend.length) {
        h += '<div class="block"><label class="check" for="live"><input id="live" type="checkbox"' + (draft.live ? ' checked' : '') + '> Afficher le score en direct pendant le vote</label>' +
          '<p class="hint">Décoché : le score reste caché jusqu\'à la clôture. Le choix est écrit dans le journal public et ne peut plus être changé une fois le duel ouvert.</p>' +
          (pend.length > 1 ? '<button class="btn primary" data-act="openall"' + dis + '>Ouvrir tous les duels en attente (' + pend.length + ')</button>' : '') + '</div>';
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

    /* bonus manuels */
    h += '<section class="panel"><h2>Bonus et pénalités</h2><p class="lead">Tu décides librement des points à ajouter ou retirer. 3 points sont attribués automatiquement par duel remporté ; les qualifications d’office ne rapportent aucun point. Chaque ajustement est conservé dans l’historique.</p>';
    if (A.players && A.players.length) {
      h += '<form id="bonusForm" class="stack"><label for="bonusPlayer">Participant</label><select id="bonusPlayer" name="playerId" required>' +
        A.players.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join('') +
        '</select><label for="bonusPoints">Points à ajouter ou retirer</label><input id="bonusPoints" name="points" type="number" min="-1000" max="1000" step="1" placeholder="Ex. 2 ou -1" required>' +
        '<label for="bonusReason">Raison obligatoire</label><input id="bonusReason" name="reason" maxlength="200" minlength="3" placeholder="Explique la décision" required>' +
        '<button class="btn primary" type="submit"' + dis + '>Enregistrer le bonus</button></form>';
    } else h += '<p class="note">Aucun participant avec pseudo pour le moment.</p>';
    if (A.bonuses && A.bonuses.length) {
      h += '<h3>Historique des ajustements</h3><ul class="history">' + A.bonuses.slice().reverse().slice(0, 30).map(function (b) {
        return '<li><strong>' + esc(b.playerName) + ' · ' + (b.points > 0 ? '+' : '') + b.points + ' pts</strong><span>' + esc(b.reason) + ' · ' + esc(b.tournamentName || '') + '</span></li>';
      }).join('') + '</ul>';
    } else h += '<p class="note">Aucun bonus attribué.</p>';
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
    try { A = await api('/api/admin/state'); fetchedAt = Date.now(); } catch (e) { /* ignoré */ }
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
    if (e.target.id === 'live') draft.live = e.target.checked;
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
    } else if (a === 'open') { var mid = b.getAttribute('data-m'); run(function () { return api('/api/admin/open', { matchId: mid, live: draft.live }); }, 'Vote ouvert.'); }
    else if (a === 'openall') run(function () { return api('/api/admin/open', { live: draft.live }); }, 'Votes ouverts.');
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
  setInterval(function () {
    if (!A) return;
    document.querySelectorAll('[data-closes]').forEach(function (sp) {
      var left = Number(sp.getAttribute('data-closes')) - nowMs();
      if (left > 0) sp.textContent = fmtLeft(left);
    });
    var c = A.matches.filter(function (m) { return m.status === 'ouvert' && nowMs() >= m.closesAt; }).length;
    if (c !== lastExp) { lastExp = c; if (c && authed && !busy) load(); }
  }, 1000);
  render(true);
  load();
})();
