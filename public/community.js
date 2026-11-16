(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); };
  function points(n) { return '<strong>' + n + '</strong> pt' + (n > 1 ? 's' : ''); }
  function list(rows, key) {
    if (!rows.length) return '<p class="lead">Aucun point pour le moment. Les résultats apparaîtront ici après les premiers duels terminés.</p>';
    return '<ol class="rank-list">' + rows.map(function (p, i) {
      return '<li><span class="rank-no">' + (i + 1) + '</span><a class="rank-player" href="/community?player=' + encodeURIComponent(p.id) + '">' + esc(p.name) + '</a><span class="rank-score">' + points(p[key]) + '</span><span class="rank-meta">' + p.wins + ' victoire' + (p.wins > 1 ? 's' : '') + '</span></li>';
    }).join('') + '</ol>';
  }
  async function load() {
    try {
      var id = new URLSearchParams(location.search).get('player') || '';
      var r = await fetch('/api/community' + (id ? '?player=' + encodeURIComponent(id) : ''));
      var data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Chargement impossible.');
      $('seasonTitle').textContent = 'Classement de la saison · ' + data.seasonName;
      $('season').innerHTML = list(data.season, 'seasonPoints');
      $('alltime').innerHTML = list(data.allTime, 'points');
      if (id) {
        var p = data.profile;
        if (!p) throw new Error('Ce profil est introuvable.');
        $('profile').hidden = false;
        $('profile').innerHTML = '<p class="eyebrow">Profil joueur</p><h2>' + esc(p.name) + '</h2><div class="profile-stats"><div><strong>' + p.points + '</strong><span>points au total</span></div><div><strong>' + p.wins + '</strong><span>duels gagnés</span></div><div><strong>' + p.tournaments + '</strong><span>tournois joués</span></div></div>' +
          '<h3>Badges et distinctions</h3>' + (p.badges.length ? '<div class="badge-grid">' + p.badges.map(function (b) { return '<div class="player-badge"><span class="badge-icon">' + b.icon + '</span><strong>' + esc(b.name) + '</strong><small>' + esc(b.detail) + '</small></div>'; }).join('') + '</div>' : '<p class="note">Pas encore de badge. Continue à participer et à gagner des duels !</p>') + '<h3>Historique des openings</h3>' + (p.history.length ? '<ul class="history">' + p.history.map(function (e) { return '<li><strong>' + esc(e.title) + '</strong><span>' + esc(e.anime) + ' · ' + esc(e.tournament) + '</span></li>'; }).join('') + '</ul>' : '<p class="note">Aucun tournoi terminé dans l’historique.</p>') +
          '<a href="/community" class="chip">Voir tous les classements</a>';
      }
      $('notice').textContent = '';
    } catch (e) { $('notice').textContent = e.message || 'Impossible de charger les classements.'; }
  }
  load();
})();