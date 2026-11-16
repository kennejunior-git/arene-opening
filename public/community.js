(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); };
  function points(n) { return '<strong>' + n + '</strong> pt' + (n > 1 ? 's' : ''); }
  function list(rows, key) {
    if (!rows.length) return '<div class="empty-state"><span class="empty-icon">✦</span><strong>Le classement se construit</strong><p>Les résultats apparaîtront ici après les premiers duels terminés.</p></div>';
    return '<ol class="rank-list">' + rows.map(function (p, i) {
      return '<li><span class="rank-no">' + String(i + 1).padStart(2, '0') + '</span><a class="rank-player" href="/community?player=' + encodeURIComponent(p.id) + '">' + esc(p.name) + '</a><span class="rank-score">' + points(p[key]) + '</span><span class="rank-meta">' + p.wins + ' duel' + (p.wins > 1 ? 's' : '') + ' gagné' + (p.wins > 1 ? 's' : '') + ' · ' + p.tournaments + ' tournoi' + (p.tournaments > 1 ? 's' : '') + '</span></li>';
    }).join('') + '</ol>';
  }
  function profile(p) {
    var history = p.history || [];
    var badges = p.badges || [];
    var h = '<div class="profile-hero"><div class="avatar">' + esc((p.name || '?').trim().charAt(0).toUpperCase()) + '</div><div><p class="eyebrow">Profil joueur</p><h2>' + esc(p.name) + '</h2><p class="profile-subtitle">Membre de la communauté Arène des Openings</p></div></div>';
    h += '<div class="profile-stats">' +
      '<div><strong>' + p.points + '</strong><span>Points cumulés</span></div>' +
      '<div><strong>' + p.wins + '</strong><span>Duels gagnés</span></div>' +
      '<div><strong>' + p.tournaments + '</strong><span>Tournois joués</span></div>' +
      '<div><strong>' + p.championships + '</strong><span>Titres de champion</span></div>' +
      '<div><strong>' + p.titleCount + '</strong><span>Openings présentés</span></div>' +
      '<div><strong>' + p.seasonWins + '</strong><span>Victoires cette saison</span></div></div>';
    h += '<section class="profile-section"><div class="section-heading"><div><p class="eyebrow">Palmarès</p><h3>Podiums</h3></div></div><div class="podium-grid">' +
      '<div><span>🥇</span><strong>' + p.podiums.first + '</strong><small>1re place</small></div>' +
      '<div><span>🥈</span><strong>' + p.podiums.second + '</strong><small>2e place</small></div>' +
      '<div><span>🥉</span><strong>' + p.podiums.third + '</strong><small>3e place</small></div></div></section>';
    h += '<section class="profile-section"><div class="section-heading"><div><p class="eyebrow">Récompenses</p><h3>Badges et distinctions</h3></div><span class="section-count">' + badges.length + '</span></div>' +
      (badges.length ? '<div class="badge-grid">' + badges.map(function (b) { return '<div class="player-badge"><span class="badge-icon">' + b.icon + '</span><strong>' + esc(b.name) + '</strong><small>' + esc(b.detail) + '</small></div>'; }).join('') + '</div>' : '<p class="note">Aucun badge pour le moment. Continue à participer et à gagner des duels !</p>') + '</section>';
    h += '<section class="profile-section"><div class="section-heading"><div><p class="eyebrow">Parcours</p><h3>Historique des tournois</h3></div><span class="section-count">' + history.length + '</span></div>';
    h += history.length ? '<ul class="history">' + history.map(function (e) {
      var videos = Array.isArray(e.videos) ? e.videos : [{ title: e.title, anime: e.anime, order: 1 }];
      var place = e.place === 1 ? '<span class="place first">🥇 Champion</span>' : e.place === 2 ? '<span class="place">🥈 Finaliste</span>' : e.place === 3 ? '<span class="place">🥉 3e place</span>' : '';
      return '<li><div class="history-head"><strong>' + esc(e.tournament) + '</strong>' + place + '</div><span>' + (e.createdAt ? new Date(e.createdAt).toLocaleDateString('fr-FR', { day:'numeric', month:'long', year:'numeric' }) : '') + '</span><div class="history-videos">' + videos.map(function (v) { return '<div><b>Affrontement ' + (v.order || 1) + '</b><span>' + esc(v.title) + (v.anime ? ' · ' + esc(v.anime) : '') + '</span></div>'; }).join('') + '</div></li>';
    }).join('') + '</ul>' : '<p class="note">Aucun tournoi terminé dans l’historique.</p>';
    h += '</section><a href="/community" class="btn profile-back">← Retour aux classements</a>';
    return h;
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
        $('profile').innerHTML = profile(p);
        document.title = p.name + ' · Profil joueur';
      }
      $('notice').textContent = '';
    } catch (e) { $('notice').textContent = e.message || 'Impossible de charger les classements.'; }
  }
  load();
})();