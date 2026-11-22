(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var A = null, storage = { archives: [] }, storageErr = '', authed = false, busy = false, err = '', info = '', armed = null, lastKey = '', lastExp = -1;
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
    if (authed) { try { storage = await api('/api/admin/storage'); storageErr = ''; } catch (e) { storageErr = e.message || 'Stockage indisponible.'; } }
    render(true);
  }

  function render(force) {
    var key = JSON.stringify([authed, A && A.t, A && A.entrantCount, A && A.stats, A && A.codes, A && A.players, A && A.bonuses, A && A.prizeConfig, A && A.prizePayouts, A && A.moderationVideos, storage, storageErr, A && A.matches.map(function (m) { return [m.id, m.status, m.closesAt, m.votes, m.extensions]; }), busy, err, info, armed]);
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
    if (A.t && A.t.status === 'inscription') {
      var pc = A.prizeConfig || { enabled: false, amounts: {} }, pa = pc.amounts || {};
      h += '<section class="panel"><h2>Récompenses financières</h2><p class="lead">Annonce avant le tirage si le tournoi est doté. Les montants sont en FCFA. Les paiements seront effectués manuellement après le tournoi.</p>' +
        '<form id="prizeConfigForm" class="stack"><label class="check"><input type="checkbox" name="enabled"' + (pc.enabled ? ' checked' : '') + '> Ce tournoi comporte des récompenses</label>' +
        '<label for="prizeFirst">1re place (FCFA)</label><input id="prizeFirst" name="first" type="number" min="0" step="1" value="' + Number(pa.first || 0) + '">' +
        '<label for="prizeSecond">2e place (FCFA, 0 si aucune)</label><input id="prizeSecond" name="second" type="number" min="0" step="1" value="' + Number(pa.second || 0) + '">' +
        '<label for="prizeThird">3e place (FCFA, 0 si aucune)</label><input id="prizeThird" name="third" type="number" min="0" step="1" value="' + Number(pa.third || 0) + '">' +
        '<p class="hint">La 3e place sera déterminée par un duel entre les deux perdants des demi-finales.</p>' +
        '<button class="btn primary" type="submit"' + dis + '>Enregistrer et annoncer les récompenses</button></form></section>';
    } else if (A.t && A.t.prizeConfig && A.t.prizeConfig.enabled) {
      var pc2 = A.t.prizeConfig.amounts || {};
      h += '<section class="panel"><h2>Récompenses annoncées</h2><p>1re : ' + Number(pc2.first || 0).toLocaleString('fr-FR') + ' FCFA · 2e : ' + Number(pc2.second || 0).toLocaleString('fr-FR') + ' FCFA · 3e : ' + Number(pc2.third || 0).toLocaleString('fr-FR') + ' FCFA</p></section>';
    }
    if (A.t && A.t.status === 'termine' && A.prizePayouts && A.prizePayouts.length) {
      h += '<section class="panel"><h2>Versement des récompenses</h2><p class="lead">Effectue le transfert manuellement sur MTN Mobile Money ou Orange Money, puis marque-le comme envoyé. Le joueur devra confirmer la réception.</p>';
      h += A.prizePayouts.map(function (p) {
        var player = (A.players || []).find(function (x) { return x.id === p.playerId; });
        var mm = player && player.mobileMoney;
        var status = { a_payer: 'À payer', envoye: 'Envoyé · confirmation attendue', recu: 'Réception confirmée', non_recu: 'Non reçu · à vérifier' }[p.status] || p.status;
        return '<div class="block"><p><strong>' + p.place + (p.place === 1 ? 're' : 'e') + ' place · ' + esc(p.playerName) + ' · ' + Number(p.amount).toLocaleString('fr-FR') + ' FCFA</strong></p><p class="note">' + status + '</p>' +
          (mm ? '<p>Coordonnées privées : <strong>' + esc(mm.provider === 'MTN' ? 'MTN Mobile Money' : 'Orange Money') + '</strong> · <strong>' + esc(mm.number) + '</strong></p>' : '<p class="err">Le joueur n’a pas encore enregistré de numéro Mobile Money.</p>') +
          (p.status === 'a_payer' || p.status === 'non_recu' ? '<form id="prizePaymentForm" class="stack prizePaymentForm"><input type="hidden" name="playerId" value="' + esc(p.playerId) + '"><label>Moyen utilisé</label><select name="method" required><option value="MTN"' + (mm && mm.provider === 'MTN' ? ' selected' : '') + '>MTN Mobile Money</option><option value="ORANGE"' + (mm && mm.provider === 'ORANGE' ? ' selected' : '') + '>Orange Money</option></select><label>Référence du transfert (facultatif)</label><input name="reference" maxlength="80"><button class="btn small primary" type="submit"' + (mm ? dis : ' disabled') + '>Marquer comme envoyé</button></form>' : '') +
          (p.playerNote ? '<p class="note">Message du joueur : ' + esc(p.playerNote) + '</p>' : '') + '</div>';
      }).join('');
      h += '</section>';
    } else if (A.t && A.t.status === 'termine' && A.t.prizeConfig && A.t.prizeConfig.enabled) {
      h += '<section class="panel"><h2>Récompenses</h2><p class="note">Aucun paiement à effectuer pour le moment. Vérifie que les places 1 à 3 ont bien été déterminées.</p></section>';
    }
    h += '</section>';

    /* tableau de bord */
    var activeVideos = A.moderationVideos || [];
    var archiveMo = ((storage.archives || []).reduce(function(n,x){return n+Number(x.bytes||0);},0) / 1048576).toFixed(1);
    var activeMo = (activeVideos.reduce(function(n,v){return n+Number(v.size||0);},0) / 1048576).toFixed(1);
    h += '<section class="panel"><h2>Tableau de bord</h2><div class="profile-stats">' +
      '<div><strong>' + Number(A.stats && A.stats.entrants || 0) + '</strong><span>Participants inscrits</span></div>' +
      '<div><strong>' + Number(A.stats && A.stats.codes || 0) + '</strong><span>Codes générés</span></div>' +
      '<div><strong>' + Number(A.stats && A.stats.voted || 0) + '</strong><span>Joueurs ayant voté</span></div>' +
      '<div><strong>' + activeVideos.length + '</strong><span>Vidéos actives</span></div>' +
      '<div><strong>' + activeMo + ' Mo</strong><span>Stockage des vidéos actives</span></div>' +
      '<div><strong>' + (storage.archives || []).length + '</strong><span>Tournois archivés</span></div>' +
      '<div><strong>' + archiveMo + ' Mo</strong><span>Stockage libérable dans les archives</span></div>' +
      '</div></section>';

    /* modération vidéo */
    h += '<section class="panel"><h2>Modération des vidéos</h2><p class="lead">Supprime les vidéos qui enfreignent le règlement : contenu adulte, violence explicite, contenu choquant ou autre contenu interdit. Le fichier et ses références sont supprimés, y compris dans les archives. Les votes, scores et résultats restent conservés.</p>';
    if (!activeVideos.length) h += '<p class="note">Aucune vidéo disponible à modérer.</p>';
    activeVideos.forEach(function(v) {
      var size = v.size ? (v.size / 1048576).toFixed(1) + ' Mo' : 'Taille inconnue';
      h += '<div class="block"><p><strong>' + esc(v.playerName) + '</strong> · ' + esc(v.title || 'Vidéo sans titre') + '</p>' +
        '<video class="media-video" controls preload="metadata" src="/video/' + encodeURIComponent(v.file) + '"></video>' +
        '<p class="note">' + esc(v.anime || '') + (v.order ? ' · ordre ' + v.order : '') + ' · ' + size + (v.duration ? ' · ' + Math.round(v.duration) + ' s' : '') + '</p>' +
        '<form class="stack videoModerationForm"><input type="hidden" name="file" value="' + esc(v.file) + '">' +
        '<label>Motif de suppression</label><input name="reason" maxlength="200" minlength="3" placeholder="Ex. contenu adulte contraire au règlement" required>' +
        '<label>Tape SUPPRIMER VIDEO pour confirmer</label><input name="confirm" autocomplete="off" required>' +
        '<button class="btn small" type="submit"' + dis + '>Supprimer définitivement cette vidéo</button></form></div>';
    });
    h += '</section>';

    /* codes */
    var unused = A.codes.filter(function (c) { return !c.used; });
    h += '<section class="panel"><h2>Codes d\'invitation</h2>' +
      '<p class="lead">Un code par personne, à envoyer en privé. Pour ce tournoi vidéo, chaque code vote une fois par affrontement (3 votes par duel). Le nombre de codes émis est affiché publiquement : n\'en génère pas plus que de membres dans ton groupe.</p>' +
      '<form id="codesForm" class="row"><label for="count" class="note">Combien de codes ?</label><input id="count" type="number" min="1" max="300" value="' + esc(draft.count) + '" required>' +
      '<button class="btn primary" type="submit"' + dis + '>Générer</button></form>';
    if (A.codes.length) {
      h += '<p class="note">' + A.codes.length + ' émis · ' + (A.codes.length - unused.length) + ' déjà utilisés · ' + unused.length + ' à distribuer</p>' +
        '<div class="row"><button class="btn small" id="copyBtn" type="button"' + (unused.length ? '' : ' disabled') + '>Copier les codes non utilisés</button>' +
        '<button class="btn small" id="dlBtn" type="button">Télécharger tous les codes</button></div>' +
        '<ul class="codes">' + A.codes.map(function (c) { return '<li class="' + (c.used ? 'used' : '') + '"><strong>' + esc(c.code) + '</strong>' + (c.name ? ' <span>— ' + esc(c.name) + '</span>' : (c.used ? ' <span>— Pseudo non renseigné</span>' : ' <span>— Non distribué</span>')) + '</li>'; }).join('') + '</ul>';
    }
    h += '</section>';

    /* déroulement */
    h += '<section class="panel"><h2>Déroulement</h2>';
    if (!A.t) {
      h += '<p class="lead">Crée d\'abord le tournoi.</p>';
    } else if (A.t.status === 'inscription') {
      var n = A.entrantCount;
      h += '<div class="block"><p><strong>' + n + ' inscrit' + (n > 1 ? 's' : '') + '</strong> pour l\'instant.</p>' +
        '<p class="note">Le tirage au sort forme les binômes au hasard. Chaque participant choisit l’ordre de ses 3 vidéos : l’affrontement 1 oppose les vidéos classées 1, puis les affrontements 2 et 3 suivent le même principe. Le tirage ferme les inscriptions. Avec un nombre impair d\'inscrits, un participant tiré au sort passe d\'office au tour suivant. Tu ne vois pas qui est inscrit : les duels restent anonymes pour toi aussi.</p>' +
        '<button class="btn ' + (armed === 'draw' ? 'armed' : 'primary') + '" data-act="draw"' + (n < 2 || busy ? ' disabled' : '') + '>' +
        (armed === 'draw' ? 'Confirmer : fermer et tirer au sort' : 'Fermer les inscriptions et tirer au sort') + '</button>' +
        (n < 2 ? '<p class="hint">Il faut au moins 2 inscrits.</p>' : '') + '</div>';
    } else if (A.t.status === 'en_cours') {
      var cur = A.matches.filter(function (m) { return m.round === A.t.round; });
      var pend = cur.filter(function (m) { return m.status === 'attente'; });
      var allClosed = cur.length > 0 && cur.every(function (m) { return m.status === 'clos'; });
      var vm = A.cfg.voteMinutes, em = A.cfg.extendMinutes;
      h += '<p class="note">' + (A.t.thirdPlaceRound === A.t.round ? 'Duel spécial pour déterminer la 3e place' : 'Tour ' + A.t.round + ' sur ' + A.t.roundsTotal) + ' · ' + cur.length + ' duel' + (cur.length > 1 ? 's' : '') + '. Chaque vote dure ' + fmtMin(vm) +
        '. En cas d\'égalité, ' + fmtMin(em) + ' sont ajoutées automatiquement (jusqu\'à ' + A.cfg.maxExtensions + ' fois, puis le serveur tire au sort). La clôture se fait toute seule.</p>';
      h += '<ul class="dlist">' + cur.map(function (m) {
        var info = '', btn = '';
        var matchTitle = m.round === A.t.thirdPlaceRound ? 'Duel pour la 3e place' : 'Duel ' + m.idx;
        if (m.bye) info = '<span class="chip ok">Qualifié d\'office</span>';
        else if (m.status === 'attente') {
          info = '<span class="chip">En attente</span>';
          btn = '<button class="btn small primary" data-act="open" data-m="' + esc(m.id) + '"' + dis + '>' + (m.encounters ? 'Ouvrir affrontement ' + m.currentEncounter + '/3' : 'Ouvrir') + ' (' + fmtMin(vm) + ')</button>';
        } else if (m.status === 'ouvert') {
          info = '<span class="chip ok">Vote ouvert</span> <span class="note">' + m.votes + ' vote' + (m.votes > 1 ? 's' : '') + ' · fin dans <span data-closes="' + m.closesAt + '">' + fmtLeft(m.closesAt - nowMs()) + '</span>' +
            (m.extensions ? ' · prolongation ' + m.extensions : '') + (m.live ? ' · score en direct' : '') + '</span>';
        } else {
          info = '<span class="chip">Terminé</span> <span class="note">' + (m.tally ? m.tally.a + ' – ' + m.tally.b + (m.encounters ? ' votes · ' + m.tally.winsA + '–' + m.tally.winsB + ' affrontements gagnés' : '') : '') + (m.byLot ? ' · tirage au sort' : '') + '</span>';
        }
        return '<li><div class="info"><strong>' + matchTitle + '</strong><span>' + info + '</span></div>' + btn + '</li>';
      }).join('') + '</ul>';
      if (pend.length) {
        h += '<div class="block"><label class="check" for="live"><input id="live" type="checkbox"' + (draft.live ? ' checked' : '') + '> Afficher le score en direct pendant le vote</label>' +
          '<p class="hint">Décoché : le score reste caché jusqu\'à la clôture. Le choix est écrit dans le journal public et ne peut plus être changé une fois le duel ouvert.</p>' +
          (pend.length > 1 ? '<button class="btn primary" data-act="openall"' + dis + '>Ouvrir tous les duels en attente (' + pend.length + ')</button>' : '') + '</div>';
      }
      if (allClosed) {
        h += '<div class="block"><p>Tous les duels du tour sont terminés.</p><button class="btn primary" data-act="next"' + dis + '>' +
          (cur.length === 1 && A.t.hasThirdPlacePlayoff && !A.t.thirdPlaceRound ? 'Lancer le duel pour la 3e place' : cur.length === 1 ? 'Couronner le vainqueur' : 'Lancer le tour suivant') + '</button></div>';
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

    /* nettoyage des archives audio */
    h += '<section class="panel"><h2>Libérer le stockage audio et vidéo</h2><p class="lead">Supprime uniquement les fichiers audio et vidéo des tournois archivés sélectionnés. Les résultats, les votes, les vainqueurs et les statistiques restent conservés. Les fichiers utilisés par le tournoi actif ou une autre archive sont protégés.</p>';
    if (storageErr) h += '<p class="err">' + esc(storageErr) + '</p>';
    var archives = storage && storage.archives ? storage.archives : [];
    if (!archives.length) h += '<p class="note">Aucun tournoi archivé pour le moment.</p>';
    archives.forEach(function (ar) {
      var size = ar.bytes < 1048576 ? Math.round(ar.bytes / 1024) + ' Ko' : (ar.bytes / 1048576).toFixed(1) + ' Mo';
      h += '<div class="block"><p><strong>' + esc(ar.name) + '</strong> <span class="chip">Archive #' + ar.id + '</span></p>' +
        '<p class="note">' + ar.audioCount + ' fichier(s) audio/vidéo référencé(s) · ' + ar.deletableCount + ' supprimable(s) · ' + ar.sharedCount + ' partagé(s) protégé(s) · environ ' + size + ' libérables' +
        (ar.pendingCount ? ' · ' + ar.pendingCount + ' suppression(s) à reprendre' : '') + '</p>';
      if (ar.deletableCount || ar.pendingCount) {
        h += '<form class="stack storageForm"><input type="hidden" name="archiveId" value="' + ar.id + '"><label for="storageConfirm' + ar.id + '">Pour confirmer, tape SUPPRIMER MÉDIAS</label>' +
          '<input id="storageConfirm' + ar.id + '" name="confirm" autocomplete="off" placeholder="SUPPRIMER AUDIO" required>' +
          '<button class="btn small" type="submit"' + dis + '>Supprimer les audios de cette archive</button></form>';
      }
      h += '</div>';
    });
    h += '</section>';

    /* suppression du tournoi non commencé */
    if (A.t && A.t.status === 'inscription' && Object.keys(A.matches || {}).length === 0) {
      h += '<section class="panel"><h2>Supprimer ce tournoi</h2><p class="lead">Réservé à un tournoi dont les inscriptions sont ouvertes et dont aucun affrontement n’a commencé. Le tournoi et ses vidéos seront supprimés. Les codes des membres et les anciennes archives seront conservés.</p>' +
        '<form id="deleteUnstartedForm" class="stack"><label for="deleteTournamentConfirm">Tape SUPPRIMER TOURNOI pour confirmer</label><input id="deleteTournamentConfirm" name="confirm" autocomplete="off" required>' +
        '<button class="btn small" type="submit"' + dis + '>Supprimer définitivement ce tournoi</button></form></section>';
    }
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
    try { A = await api('/api/admin/state'); storage = await api('/api/admin/storage'); storageErr = ''; fetchedAt = Date.now(); } catch (e) { storageErr = e.message || 'Stockage indisponible.'; }
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
    else if (f === 'deleteUnstartedForm') {
      var df = new FormData(e.target);
      if (df.get('confirm') !== 'SUPPRIMER TOURNOI') { err = 'Confirmation incorrecte.'; render(); return; }
      if (!window.confirm('Supprimer définitivement ce tournoi et ses médias ? Les codes et archives seront conservés.')) return;
      run(function () { return api('/api/admin/delete-unstarted', { confirm: df.get('confirm') }); }, 'Tournoi supprimé. Les codes et archives sont conservés.');
    }
    else if (f === 'resetForm') run(function () { return api('/api/admin/reset', { confirm: draft.confirm }).then(function () { draft.confirm = ''; }); }, 'Nouveau tournoi prêt.');
    else if (f === 'prizeConfigForm') { var pf = new FormData(e.target); run(function () { return api('/api/admin/prize-config', { enabled: pf.get('enabled') === 'on', first: Number(pf.get('first')), second: Number(pf.get('second')), third: Number(pf.get('third')) }); }, 'Récompenses enregistrées et annoncées.'); }
    else if (f === 'bonusForm') { var bf = new FormData(e.target); run(function () { return api('/api/admin/bonus', { playerId: bf.get('playerId'), points: Number(bf.get('points')), reason: bf.get('reason') }); }, 'Bonus enregistré et ajouté au journal.'); }
    else if (f === 'storageForm') { var sf = new FormData(e.target); run(function () { return api('/api/admin/storage/cleanup', { archiveId: Number(sf.get('archiveId')), confirm: sf.get('confirm') }); }, 'Nettoyage terminé. Les résultats historiques sont conservés.'); }
    else if (f === 'videoModerationForm') { var vf = new FormData(e.target); if (vf.get('confirm') !== 'SUPPRIMER VIDEO') { err = 'Confirmation incorrecte : tape SUPPRIMER VIDEO.'; render(); return; } if (!window.confirm('Cette vidéo sera supprimée définitivement, y compris de ses archives. Continuer ?')) return; run(function () { return api('/api/admin/video/delete', { file:vf.get('file'), reason:vf.get('reason'), confirm:vf.get('confirm') }); }, 'Vidéo supprimée. Les votes et résultats sont conservés.'); }
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
