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
    h += (p.canFavorite ? '<div class="community-actions"><button class="btn primary" id="favoriteProfile" type="button">' + (p.favorited ? '★ Retirer des favoris' : '☆ Ajouter aux favoris') + '</button><span>' + p.favoriteCount + ' joueur(s) suivent ce profil</span></div>' : '') + '<section class="profile-section"><div class="section-heading"><div><p class="eyebrow">Palmarès</p><h3>Podiums</h3></div></div><div class="podium-grid">' +
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
    var comments = p.comments || [];
    h += '</section><section class="profile-section community-comments"><div class="section-heading"><div><p class="eyebrow">Communauté</p><h3>Messages sur ce joueur</h3></div><span class="section-count">' + comments.length + '</span></div>' +
      '<form id="commentForm" class="comment-form"><label for="commentMessage">Laisser un commentaire (500 caractères maximum)</label><textarea id="commentMessage" maxlength="500" rows="3" placeholder="Encourage ce joueur ou réagis à ses performances…" required></textarea><div class="comment-form-foot"><small id="commentStatus">Respecte les autres joueurs.</small><button class="btn primary" type="submit">Publier</button></div></form>' +
      (comments.length ? '<ul class="comment-list">' + comments.map(function (c) { return '<li><div class="comment-head"><strong>' + esc(c.authorName) + '</strong><time>' + new Date(c.createdAt).toLocaleString('fr-FR', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) + '</time></div><p>' + esc(c.message) + '</p>' + (c.canDelete ? '<button class="comment-delete" data-comment="' + esc(c.id) + '" type="button">Supprimer</button>' : '') + '</li>'; }).join('') + '</ul>' : '<p class="note">Pas encore de commentaire. Sois le premier à encourager ce joueur !</p>') + '</section><a href="/community" class="btn profile-back">← Retour aux classements</a>';
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
        var favorite = $('favoriteProfile');
        if (favorite) favorite.addEventListener('click', async function () {
          favorite.disabled = true;
          try {
            var fr = await fetch('/api/community/favorite', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ playerId:p.id }) });
            var fd = await fr.json(); if (!fr.ok) throw new Error(fd.error || 'Action impossible.');
            load();
          } catch (e) { alert(e.message); favorite.disabled = false; }
        });
        var form = $('commentForm');
        if (form) form.addEventListener('submit', async function (ev) {
          ev.preventDefault();
          var message = $('commentMessage').value.trim(), status = $('commentStatus');
          if (!message) return;
          var submit = form.querySelector('button[type="submit"]'); submit.disabled = true; status.textContent = 'Publication…';
          try {
            var cr = await fetch('/api/community/comment', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ playerId:p.id, message:message }) });
            var cd = await cr.json(); if (!cr.ok) throw new Error(cd.error || 'Publication impossible.');
            load();
          } catch (e) { status.textContent = e.message; submit.disabled = false; }
        });
        Array.prototype.forEach.call(document.querySelectorAll('[data-comment]'), function (btn) {
          btn.addEventListener('click', async function () {
            if (!confirm('Supprimer ce commentaire ?')) return;
            btn.disabled = true;
            try {
              var dr = await fetch('/api/community/comment/delete', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ commentId:btn.getAttribute('data-comment') }) });
              var dd = await dr.json(); if (!dr.ok) throw new Error(dd.error || 'Suppression impossible.');
              load();
            } catch (e) { alert(e.message); btn.disabled = false; }
          });
        });
      }
      $('notice').textContent = '';
    } catch (e) { $('notice').textContent = e.message || 'Impossible de charger les classements.'; }
  }
  load();
})();