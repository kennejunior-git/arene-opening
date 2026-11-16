(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var S = null, offset = 0, loadErr = '', lastExp = -1;
  function now() { return Date.now() + offset; }
  function fmtLeft(ms) {
    var m = Math.max(1, Math.ceil(ms / 60000)), h = Math.floor(m / 60), mm = m % 60;
    return h ? h + ' h ' + String(mm).padStart(2, '0') + ' min' : mm + ' min';
  }
  function plural(n, a, b) { return n + ' ' + (n > 1 ? b : a); }
  function roundName(r) {
    var n = S.matches.filter(function (m) { return m.round === r; }).length;
    return n === 1 ? 'Finale' : n === 2 ? 'Demi-finales' : n === 4 ? 'Quarts de finale' : 'Tour ' + r;
  }
  function duelName(m) { return roundName(m.round) + ' · duel ' + m.idx; }

  async function load() {
    try {
      var r = await fetch('/api/state');
      if (!r.ok) throw new Error('http');
      S = await r.json(); offset = S.now - Date.now(); loadErr = '';
    } catch (e) { loadErr = 'Impossible de joindre le serveur. Nouvel essai en cours…'; }
    render();
  }

  function sideRow(side, pos, n, total, won, reveal, voters) {
    var pct = total ? Math.round(100 * n / total) : 0;
    return '<div class="side s' + pos + (won ? ' win' : '') + '"><h4>' + esc(side.title) + '</h4><p class="oanime">' + esc(side.anime) +
      (reveal ? ' · <strong>' + esc(reveal) + '</strong>' : '') + (won ? ' <span class="chip ok">Qualifié</span>' : '') + '</p>' +
      (side.audio ? '<audio controls preload="none" src="/audio/' + esc(side.audio) + '"></audio>' : '') +
      '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div>' +
      '<p class="nums"><span>' + plural(n, 'voix', 'voix') + '</span><span>' + pct + ' %</span></p>' +
      (voters && voters.length ? '<details class="voters"><summary>Voir les ' + plural(voters.length, 'votant', 'votants') + '</summary><p>' + voters.map(esc).join(', ') + '</p></details>' : '') + '</div>';
  }

  function renderLive() {
    var open = S.matches.filter(function (m) { return m.status === 'ouvert'; });
    var h = '<h2>Votes en direct</h2>';
    if (!open.length) {
      var waiting = S.matches.filter(function (m) { return m.status === 'attente'; }).length;
      h += '<p class="lead">' + (S.t && S.t.status === 'en_cours'
        ? (waiting ? 'Aucun vote en cours. ' + plural(waiting, 'duel attend', 'duels attendent') + ' l\'ouverture par l\'organisateur.' : 'Aucun vote en cours.')
        : S.t && S.t.status === 'termine' ? 'Le tournoi est terminé.' : 'Les votes commenceront après le tirage au sort.') + '</p>';
    }
    open.forEach(function (m) {
      var live = now() < m.closesAt, pctT = m.eligible ? Math.min(100, Math.round(100 * m.votes / m.eligible)) : 0;
      h += '<article class="duel"><div class="dhead"><h3>' + esc(duelName(m)) + '</h3><span class="chip ok">' + (live ? 'Vote ouvert' : 'Calcul en cours') + '</span></div>' +
        '<p class="timer">' + (live ? 'Se termine dans <span data-closes="' + m.closesAt + '">' + fmtLeft(m.closesAt - now()) + '</span>' : 'Le vote est terminé, le résultat arrive.') + '</p>' +
        '<div class="turnout"><div class="track"><div class="fill" style="width:' + pctT + '%"></div></div>' +
        '<p class="nums"><span>' + plural(m.votes, 'vote enregistré', 'votes enregistrés') + '</span><span>sur ' + m.eligible + ' codes émis · ' + pctT + ' %</span></p></div>';
      if (m.extensions) h += '<p class="note"><span class="chip warn">Prolongation ' + m.extensions + '</span> Égalité : ' + S.cfg.extendMinutes + ' minutes ajoutées.</p>';
      if (m.liveTally) {
        var t = m.liveTally, tot = t.a + t.b;
        h += sideRow(m.a, 1, t.a, tot, false, null, null) + sideRow(m.b, 2, t.b, tot, false, null, null) +
          '<p class="note">Score en direct activé par l\'organisateur pour ce duel. Les pseudos des votants apparaissent à la fin.</p>';
      } else {
        h += '<p class="note">Le score est caché jusqu\'à la fin du duel. Les pseudos des votants apparaissent à la fin, jamais pendant le vote.</p>';
      }
      h += '</article>';
    });
    $('livesec').innerHTML = h;
  }

  function renderDone() {
    var done = S.matches.filter(function (m) { return m.status === 'clos' && !m.bye; }).reverse();
    if (!done.length) { $('donesec').innerHTML = ''; return; }
    var h = '<h2>Duels terminés</h2>';
    done.forEach(function (m) {
      var tl = m.tally || { a: 0, b: 0, total: 0 };
      h += '<article class="duel"><div class="dhead"><h3>' + esc(duelName(m)) + '</h3><span class="chip">' + plural(tl.total, 'vote', 'votes') + '</span></div>' +
        sideRow(m.a, 1, tl.a, tl.total, m.winnerSlot === m.a.slot, m.reveal && m.reveal.a, m.voters && m.voters.a) +
        sideRow(m.b, 2, tl.b, tl.total, m.winnerSlot === m.b.slot, m.reveal && m.reveal.b, m.voters && m.voters.b) +
        '<p class="note">' + (m.extensions ? plural(m.extensions, 'prolongation', 'prolongations') + ' pour départager. ' : '') +
        (m.eligible ? 'Participation : ' + Math.round(100 * tl.total / m.eligible) + ' % des codes émis.' : '') + '</p>' +
        (m.byLot ? '<p class="note"><span class="chip warn">Tirage au sort</span> Égalité persistante : le serveur a tiré le gagnant au hasard.</p>' : '') + '</article>';
    });
    $('donesec').innerHTML = h;
  }

  function renderNums() {
    var duels = S.matches.filter(function (m) { return !m.bye; });
    var done = duels.filter(function (m) { return m.status === 'clos'; });
    var votes = done.reduce(function (a, m) { return a + (m.tally ? m.tally.total : 0); }, 0);
    var exts = duels.reduce(function (a, m) { return a + (m.extensions || 0); }, 0);
    var part = done.filter(function (m) { return m.eligible; }).map(function (m) { return (m.tally ? m.tally.total : 0) / m.eligible; });
    var avg = part.length ? Math.round(100 * part.reduce(function (a, b) { return a + b; }, 0) / part.length) + ' %' : '—';
    var close = null, wide = null;
    done.forEach(function (m) {
      if (!m.tally || !m.tally.total) return;
      var d = Math.abs(m.tally.a - m.tally.b);
      if (!close || d < close.d) close = { d: d, m: m };
      if (!wide || d > wide.d) wide = { d: d, m: m };
    });
    var cell = function (k, v, sub) { return '<div><dt>' + k + '</dt><dd>' + v + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</dd></div>'; };
    var st = S.stats;
    var h = '<h2>Chiffres du tournoi</h2><dl class="dl">' +
      cell('Openings inscrits', st.entrants) +
      cell('Codes émis', st.codes, st.used + ' déjà utilisés') +
      cell('Personnes ayant voté', st.voted) +
      cell('Duels terminés', done.length + ' sur ' + duels.length) +
      cell('Votes comptés', votes) +
      cell('Participation moyenne', avg, 'des codes émis, par duel') +
      cell('Prolongations', exts) +
      cell('Duel le plus serré', close ? plural(close.d, 'voix', 'voix') + ' d\'écart' : '—', close ? duelName(close.m) : '') +
      cell('Plus grand écart', wide ? plural(wide.d, 'voix', 'voix') : '—', wide ? duelName(wide.m) : '') + '</dl>';
    if (done.length > 1) {
      var max = Math.max.apply(null, done.map(function (m) { return m.tally ? m.tally.total : 0; })) || 1;
      h += '<h3>Votes par duel</h3><ul class="bars">' + done.slice().reverse().map(function (m) {
        var n = m.tally ? m.tally.total : 0;
        return '<li><span>' + esc(roundName(m.round).replace('Tour ', 'T') + ' · ' + m.idx) + '</span><div class="track"><div class="fill" style="width:' + Math.round(100 * n / max) + '%"></div></div><b>' + n + '</b></li>';
      }).join('') + '</ul>';
    }
    $('numsec').innerHTML = h;
  }

  function render() {
    $('notice').innerHTML = loadErr ? '<p>' + esc(loadErr) + '</p>' : (!S ? '<p>Chargement…</p>' : (!S.t ? '<p>Le tournoi n\'a pas encore été créé.</p>' : ''));
    if (!S || !S.t) { $('livesec').innerHTML = $('donesec').innerHTML = $('numsec').innerHTML = ''; return; }
    $('ttl').textContent = S.t.name || 'Statistiques';
    $('stats').innerHTML = '<span class="chip ' + (S.t.status === 'en_cours' ? 'ok' : '') + '">' +
      ({ inscription: 'Inscriptions ouvertes', en_cours: 'Tournoi en cours', termine: 'Terminé' }[S.t.status] || '') + '</span>' +
      (S.t.status === 'en_cours' ? '<span class="chip">Tour ' + S.t.round + ' sur ' + S.t.roundsTotal + '</span>' : '');
    renderLive(); renderDone(); renderNums();
  }

  setInterval(function () {
    document.querySelectorAll('[data-closes]').forEach(function (s) {
      var left = Number(s.getAttribute('data-closes')) - now();
      if (left > 0) s.textContent = fmtLeft(left);
    });
    if (!S) return;
    var c = S.matches.filter(function (m) { return m.status === 'ouvert' && now() >= m.closesAt; }).length;
    if (c !== lastExp) { lastExp = c; if (c) load(); }
  }, 1000);
  setInterval(load, 5000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
  document.addEventListener('play', function (e) {
    document.querySelectorAll('audio').forEach(function (a) { if (a !== e.target) a.pause(); });
  }, true);
  render(); load();
})();
