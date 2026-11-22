(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var S = null, offset = 0, loadErr = '', voting = false, voteMsg = '';
  var regMsg = '', regErr = '', loginErr = '', lastRegKey = '', lastLoginKey = '', lastExp = -1, registrationBusy = false, registrationHold = false;
  var STATUS = { attente: 'Pas encore ouvert', ouvert: 'Vote ouvert', clos: 'Terminé' };

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
    if (S && S.t && S.t.thirdPlaceRound === r) return 'Duel pour la 3e place';
    var n = S.matches.filter(function (m) { return m.round === r; }).length;
    if (n === 1) return 'Finale';
    if (n === 2) return 'Demi-finales';
    if (n === 4) return 'Quarts de finale';
    return 'Tour ' + r;
  }

  async function uploadVideo(file, slot, onProgress) {
    var chunkSize=5*1024*1024, fingerprint=[slot,file.name,file.size,file.lastModified].join(':');
    var storageKey='arene-video-upload:'+fingerprint, saved=null;
    try{saved=JSON.parse(localStorage.getItem(storageKey)||'null');}catch(e){}
    var session=saved&&/^[a-f0-9]{32}$/.test(saved.session||'')?saved.session:'';
    if(!session){var bytes=new Uint8Array(16);if(crypto&&crypto.getRandomValues)crypto.getRandomValues(bytes);else for(var z=0;z<16;z++)bytes[z]=Math.floor(Math.random()*256);session=Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join('');saved={session:session,uploadId:''};}
    async function jsonPost(url,body){var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});var j={};try{j=await r.json();}catch(e){}if(!r.ok)throw new Error(j.error||'Erreur réseau.');return j;}
    var init=await jsonPost('/api/video/chunk/init/'+slot,{size:file.size,session:session,uploadId:saved.uploadId||''});
    saved.uploadId=init.uploadId;try{localStorage.setItem(storageKey,JSON.stringify(saved));}catch(e){}
    var done={};(init.parts||[]).forEach(p=>done[Number(p)]=true);
    var total=Math.ceil(file.size/chunkSize);
    for(var part=1;part<=total;part++){
      var start=(part-1)*chunkSize,end=Math.min(file.size,start+chunkSize);
      if(done[part]){onProgress(Math.min(99,Math.round(100*end/file.size)));continue;}
      var attempt=0,ok=false;
      while(!ok&&attempt<5){attempt++;try{await new Promise(function(resolve,reject){var x=new XMLHttpRequest();x.open('POST','/api/video/chunk/part/'+slot+'/'+session+'/'+part);x.setRequestHeader('Content-Type','application/octet-stream');x.setRequestHeader('X-Upload-Id',saved.uploadId);x.timeout=120000;x.onload=function(){var j={};try{j=JSON.parse(x.responseText);}catch(e){}if(x.status>=200&&x.status<300)resolve(j);else reject(new Error(j.error||'Bloc refusé.'));};x.onerror=function(){reject(new Error('Connexion interrompue.'));};x.ontimeout=function(){reject(new Error('Délai dépassé.'));};x.send(file.slice(start,end));});ok=true;}catch(e){if(attempt===5)throw new Error('Connexion instable sur le bloc '+part+'. Tu peux réessayer : les blocs reçus seront conservés.');await new Promise(r=>setTimeout(r,Math.min(8000,attempt*1500)));}}
      onProgress(Math.min(99,Math.round(100*end/file.size)));
    }
    var result=await jsonPost('/api/video/chunk/complete/'+slot+'/'+session,{size:file.size,uploadId:saved.uploadId});
    try{localStorage.removeItem(storageKey);}catch(e){}onProgress(100);return result;
  }

  function uploadAudio(file, onProgress) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('POST', '/api/audio');
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(Math.round(100 * e.loaded / e.total)); };
      x.onload = function () {
        var j = {}; try { j = JSON.parse(x.responseText); } catch (e) { /* vide */ }
        if (x.status >= 200 && x.status < 300) resolve(j); else reject(new Error(j.error || 'Envoi impossible.'));
      };
      x.onerror = function () { reject(new Error('Envoi interrompu. Vérifie ta connexion et réessaie.')); };
      x.send(file);
    });
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
      if (t.status === 'en_cours') h += '<span class="chip">' + (t.thirdPlaceRound === t.round ? 'Duel pour la 3e place' : 'Tour ' + t.round + ' sur ' + t.roundsTotal) + '</span>';
      var ne = t.entrantCount || (S.stats && S.stats.entrants) || 0;
      h += '<span class="chip">' + ne + ' opening' + (ne > 1 ? 's' : '') + ' inscrit' + (ne > 1 ? 's' : '') + '</span>';
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
    var key = JSON.stringify([!!S.me, S.me && S.me.name, S.me && S.me.mobileMoney, S.me && S.me.prize, loginErr]);
    if (key === lastLoginKey) return;
    lastLoginKey = key;
    el.hidden = false;
    var pseudoHint = 'Ton pseudo sera affiché avec ton choix quand le duel est terminé. Il est choisi une seule fois, à ta première connexion avec ce code.';
    if (S.me && S.me.name) {
      el.innerHTML = '<div class="row"><p class="note">Connecté : <strong>' + esc(S.me.name) + '</strong></p><button class="btn small" id="logoutBtn" type="button">Changer de code</button></div>' +
        '<details class="stack"><summary>Mes coordonnées Mobile Money (privées)</summary><p class="hint">Ces informations sont visibles uniquement par l’organisateur pour te verser une récompense.</p>' +
        '<form id="mobileMoneyForm" class="stack"><label for="mmProvider">Opérateur</label><select id="mmProvider" name="provider"><option value="MTN"' + (S.me.mobileMoney && S.me.mobileMoney.provider === 'MTN' ? ' selected' : '') + '>MTN Mobile Money</option><option value="ORANGE"' + (S.me.mobileMoney && S.me.mobileMoney.provider === 'ORANGE' ? ' selected' : '') + '>Orange Money</option></select>' +
        '<label for="mmNumber">Numéro Mobile Money</label><input id="mmNumber" name="number" inputmode="tel" maxlength="18" required value="' + esc(S.me.mobileMoney && S.me.mobileMoney.number || '') + '" placeholder="Ex. 6XXXXXXXX">' +
        '<button class="btn small" type="submit">Enregistrer mes coordonnées</button></form></details>' +
        (S.me.prize ? '<div class="panel"><h3>Ma récompense · ' + S.me.prize.amount + ' FCFA</h3><p>' + (S.me.prize.status === 'a_payer' ? 'En attente du paiement par l’organisateur.' : S.me.prize.status === 'envoye' ? 'Paiement envoyé via ' + (S.me.prize.method === 'MTN' ? 'MTN Mobile Money' : 'Orange Money') + '. As-tu reçu l’argent ?' : S.me.prize.status === 'recu' ? 'Réception confirmée. Merci !' : 'Tu as signalé que le paiement n’est pas reçu. L’organisateur va vérifier.') + '</p>' +
        (S.me.prize.status === 'envoye' ? '<div class="row"><button class="btn small" type="button" data-prize-confirm="yes">Oui, j’ai reçu</button><button class="btn small" type="button" data-prize-confirm="no">Non, pas encore</button></div>' : '') + '</div>' : '');
    } else if (S.me) {
      el.innerHTML = '<h2>Choisis ton pseudo</h2><p class="lead">' + esc(pseudoHint) + '</p>' +
        '<form id="nameForm" class="stack"><label for="vname">Ton pseudo</label>' +
        '<input id="vname" name="name" maxlength="30" minlength="2" autocomplete="off" required>' +
        '<button class="btn primary" type="submit">Valider mon pseudo</button>' + (loginErr ? '<p class="err">' + esc(loginErr) + '</p>' : '') + '</form>';
    } else {
      el.innerHTML = '<h2>Entre ton code</h2><p class="lead">Pour voter ou t\'inscrire, utilise ton code d\'invitation personnel. Tu peux suivre les duels sans code. Pas de code ? Demande-le à l\'organisateur.</p>' +
        '<form id="loginForm" class="stack"><label for="code">Code d\'invitation</label>' +
        '<input id="code" class="codefield" name="code" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required>' +
        '<label for="pseudo">Ton pseudo (première connexion seulement)</label>' +
        '<input id="pseudo" name="pseudo" maxlength="30" autocomplete="off">' +
        '<p class="hint">' + esc(pseudoHint) + '</p>' +
        '<button class="btn primary" type="submit">Entrer</button>' + (loginErr ? '<p class="err">' + esc(loginErr) + '</p>' : '') + '</form>';
    }
  }

  
  function renderReg() {
    if (registrationBusy || registrationHold) return;
    var el = $('reg');
    if (!S || !S.t || !S.me) { el.hidden = true; lastRegKey = ''; return; }
    var key = JSON.stringify([S.t.status, S.t.mediaMode, S.me.entry, S.me.videoUploads, regMsg, regErr, S.matches.length]);
    if (key === lastRegKey) return;
    lastRegKey = key;
    var h = '', e = S.me.entry;
    if (S.t.status === 'inscription' && S.t.mediaMode === 'video3') {
      var existing = e && e.videos || [];
      var pending = S.me.videoUploads || {};
      h = '<h2>' + (e ? 'Tes 3 vidéos' : 'Inscris tes 3 openings') + '</h2>' +
        '<p class="lead">Envoie trois vidéos distinctes et choisis pour chacune son affrontement. Chaque ordre (1, 2 et 3) doit être utilisé une seule fois. Chaque vidéo dure 2 minutes maximum.</p>' +
        '<form id="regForm" class="stack"><label for="f-name">Ton pseudo</label><input id="f-name" name="name" maxlength="40" required value="' + esc(e && e.name || S.me.name || '') + '">';
      for (var i = 1; i <= 3; i++) {
        var v = existing[i - 1] || {}, up = pending[i] || v;
        h += '<div class="panel"><h3>Vidéo ' + i + '</h3>' +
          '<label for="f-anime-' + i + '">Anime</label><input id="f-anime-' + i + '" name="anime' + i + '" maxlength="60" required value="' + esc(v.anime || '') + '">' +
          '<label for="f-title-' + i + '">Titre de l’opening</label><input id="f-title-' + i + '" name="title' + i + '" maxlength="80" required value="' + esc(v.title || '') + '">' +
          '<label for="f-order-' + i + '">Ordre de passage</label><select id="f-order-' + i + '" name="order' + i + '"><option value="1"' + (Number(v.order || i) === 1 ? ' selected' : '') + '>1er affrontement</option><option value="2"' + (Number(v.order || i) === 2 ? ' selected' : '') + '>2e affrontement</option><option value="3"' + (Number(v.order || i) === 3 ? ' selected' : '') + '>3e affrontement</option></select>' +
          (up && up.file ? '<p class="okmsg">Vidéo ' + i + ' envoyée · ' + Math.round(Number(up.duration || 0)) + ' s</p><video controls preload="metadata" playsinline style="width:100%;max-height:260px" src="/video/' + esc(up.file) + '"></video>' : '') +
          '<label for="f-video-' + i + '">Fichier vidéo MP4 ou MOV</label><input id="f-video-' + i + '" name="video' + i + '" type="file" accept="video/mp4,video/quicktime,.mp4,.mov" ' + (up && up.file ? '' : 'required') + '>' +
          '<p class="hint">2 minutes maximum · 60 Mo maximum.</p></div>';
      }
      h += '<button class="btn primary" type="submit">' + (e ? 'Mettre à jour mes vidéos' : 'Enregistrer mes 3 vidéos') + '</button><p class="note" id="upmsg" role="status"></p>' +
        (regMsg ? '<p class="okmsg">' + esc(regMsg) + '</p>' : '') + (regErr ? '<p class="err">' + esc(regErr) + '</p>' : '') + '</form>';
    } else if (S.t.status === 'inscription') {
      var v = e || {};
      h = '<h2>' + (e ? 'Ton inscription' : 'Inscris ton opening') + '</h2>' +
        '<p class="lead">Ton opening reste anonyme jusqu’à la fin de son duel. Tu peux modifier ton inscription jusqu’au tirage au sort.</p>' +
        '<form id="regForm" class="stack"><label for="f-name">Ton pseudo (affiché après le duel)</label><input id="f-name" name="name" maxlength="40" required value="' + esc(v.name) + '">' +
        '<label for="f-anime">Anime</label><input id="f-anime" name="anime" maxlength="60" required value="' + esc(v.anime) + '">' +
        '<label for="f-title">Titre de l’opening</label><input id="f-title" name="title" maxlength="80" required value="' + esc(v.title) + '">' +
        '<label for="f-audio">Fichier audio de ton opening</label>' +
        (v.audio ? '<p class="okmsg">Fichier déjà envoyé.</p><audio controls preload="none" src="/audio/' + esc(v.audio) + '"></audio>' : '') +
        '<input id="f-audio" name="audio" type="file" accept="audio/*,.mp3,.m4a,.aac,.ogg,.opus,.wav,.flac">' +
        '<p class="hint">Formats audio · ' + (S.cfg ? S.cfg.maxAudioMb : 15) + ' Mo maximum.</p>' +
        '<label for="f-link">Ou un lien facultatif</label><input id="f-link" name="link" type="url" maxlength="300" placeholder="https://" value="' + esc(v.link) + '">' +
        '<button class="btn primary" type="submit">' + (e ? 'Mettre à jour' : 'Enregistrer mon inscription') + '</button><p class="note" id="upmsg" role="status"></p>' +
        (regMsg ? '<p class="okmsg">' + esc(regMsg) + '</p>' : '') + (regErr ? '<p class="err">' + esc(regErr) + '</p>' : '') + '</form>';
    } else if (e && e.matchId) {
      h = '<h2>Tu participes</h2><p>Ton inscription est enregistrée.</p>';
    } else { el.hidden = true; return; }
    el.hidden = false; el.innerHTML = h;
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
    return !!(S.me && S.me.name && m.status === 'ouvert' && now() < m.closesAt && !(S.me.entry && S.me.entry.matchId === m.id));
  }

  var REACTIONS=[{id:'love',emoji:'❤️',label:'J’adore'},{id:'fire',emoji:'🔥',label:'Impressionnant'},{id:'laugh',emoji:'😂',label:'Drôle'},{id:'wow',emoji:'😮',label:'Incroyable'},{id:'clap',emoji:'👏',label:'Bravo'}];
  var reacting=false;
  function reactionHTML(m,side) {
    var sideKey=side.slot===m.a.slot?'a':'b',data=m.reactions&&m.reactions[sideKey]||{counts:{},mine:null},encounter=m.encounters?m.currentEncounter:1;
    var h='<div class="opening-reactions"><span class="reaction-title">Réactions</span><div class="reaction-list">';
    REACTIONS.forEach(function(r){var count=Number(data.counts&&data.counts[r.id]||0),active=data.mine===r.id;h+='<button type="button" class="reaction-btn'+(active?' active':'')+'" data-reaction="'+r.id+'" data-m="'+esc(m.id)+'" data-s="'+esc(side.slot)+'" data-e="'+encounter+'" title="'+esc(r.label)+'" aria-pressed="'+(active?'true':'false')+'"'+((!S.me||!S.me.name||reacting)?' disabled':'')+'><span>'+r.emoji+'</span><b>'+count+'</b></button>';});
    h+='</div>'+(!S.me||!S.me.name?'<small>Connecte-toi pour réagir</small>':'')+'</div>';return h;
  }


  function mediaSpeed() {
    try {
      var v = Number(localStorage.getItem('arene-media-speed'));
      return [0.75, 1, 1.25, 1.5, 2].indexOf(v) !== -1 ? v : 1;
    } catch (e) { return 1; }
  }
  function mediaSpeedHTML() {
    var current = mediaSpeed();
    return '<label class="media-speed">Vitesse <select data-media-speed aria-label="Vitesse de lecture">' +
      [0.75, 1, 1.25, 1.5, 2].map(function (v) {
        return '<option value="' + v + '"' + (v === current ? ' selected' : '') + '>' + String(v).replace('.', ',') + '×</option>';
      }).join('') + '</select></label>';
  }

  function optHTML(side, pos, m, mode) {
    var u = safeUrl(side.link), voteKey = m.encounters ? m.id + ':e' + m.currentEncounter : m.id;
    var picked = S.me && S.me.votes[voteKey] === side.slot;
    var mine = !!(S.me && S.me.entry && S.me.entry.matchId === m.id);
    var isA = side.slot === m.a.slot;
    var video = side.videos && side.videos[m.currentEncounter - 1];
    var title = video ? video.title : side.title, anime = video ? video.anime : side.anime;
    var h = '<div class="opt s' + pos + (picked && mode === 'vote' ? ' picked' : '') + '">' +
      '<span class="badge" aria-hidden="true">' + pos + '</span><div class="obody">' +
      '<p class="otitle">' + esc(title) + '</p><p class="oanime">' + esc(anime) + '</p>' +
      (video && video.file ? '<video class="media-video" controls preload="metadata" playsinline aria-label="Vidéo de l’affrontement" src="/video/' + esc(video.file) + '"></video>' + mediaSpeedHTML() : '') +
      (side.audio ? '<audio class="media-audio" controls preload="metadata" aria-label="Écouter l’opening" src="/audio/' + esc(side.audio) + '"></audio>' + mediaSpeedHTML() : '') +
      '<p class="olink">' + (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + (side.audio ? 'Ou écouter sur ' : 'Écouter sur ') + esc(hostOf(u)) + ' ↗</a>' : '') +
      (mine ? '<span class="tag">Ton opening</span>' : '') + '</p>' + reactionHTML(m, side) + '</div>';
    if (mode === 'vote') {
      if (m.liveTally) {
        var lt = m.liveTally, lt_total = lt.a + lt.b, ln = isA ? lt.a : lt.b, lp = lt_total ? Math.round(100 * ln / lt_total) : 0;
        h += '<div class="res"><div class="track"><div class="fill" style="width:' + lp + '%"></div></div>' +
          '<p class="nums"><span>' + ln + ' voix en direct</span><span>' + lp + ' %</span></p></div>';
      }
      var can = eligible(m);
      h += '<button class="vote" data-m="' + esc(m.id) + '" data-s="' + esc(side.slot) + '" aria-pressed="' + (picked ? 'true' : 'false') + '"' +
        (can && !voting ? '' : ' disabled') + ' aria-label="Voter pour l\'opening ' + pos + '">' + (picked ? 'Ton vote ✓' : 'Voter pour celui-ci') + '</button>';
    } else if (mode === 'result') {
      var encounterRecord = m.encounters && m.encounters[m.currentEncounter - 1];
      var tl = encounterRecord && encounterRecord.tally || m.tally || { a: 0, b: 0, total: 0 };
      var n = isA ? tl.a : tl.b, pct = tl.total ? Math.round(100 * n / tl.total) : 0;
      var won = encounterRecord ? encounterRecord.winnerSlot === side.slot : m.winnerSlot === side.slot;
      var winnerLabel = encounterRecord ? (won ? 'Affrontement gagné' : '') : (won ? 'Qualifié' : '');
      var nm = m.reveal ? (isA ? m.reveal.a : m.reveal.b) : null;
      var vn = m.voters ? (isA ? m.voters.a : m.voters.b) : null;
      h += '<div class="res">' + (nm ? '<p class="oanime">Présenté par <strong>' + esc(nm) + '</strong>' + (winnerLabel ? ' <span class="chip ok">' + winnerLabel + '</span>' : '') + '</p>' : '') +
        '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div>' +
        '<p class="nums"><span>' + n + ' voix</span><span>' + pct + ' %</span></p>' +
        (vn && vn.length ? '<details class="voters"><summary>Voir les ' + vn.length + ' votant' + (vn.length > 1 ? 's' : '') + '</summary><p>' + vn.map(esc).join(', ') + '</p></details>' : '') + '</div>';
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
    var chipCls = live ? 'ok' : '';
    var chipTxt = m.status === 'ouvert' && !live ? 'Calcul en cours' : STATUS[m.status];
    var h = '<article class="duel"><div class="dhead"><h3>Duel ' + m.idx + (m.encounters ? ' · Affrontement ' + m.currentEncounter + '/3' : '') + '</h3><span class="chip ' + chipCls + '">' + chipTxt + '</span></div>';
    if (m.encounters && m.encounters.some(function (x) { return x.status === 'clos'; })) {
      h += '<p class="note">Résultats précédents : ' + m.encounters.filter(function (x) { return x.status === 'clos'; }).map(function (x) {
        var score = x.tally ? x.tally.a + '–' + x.tally.b : '—';
        var win = x.winnerSlot === m.a.slot ? ' · opening A gagne' : x.winnerSlot === m.b.slot ? ' · opening B gagne' : ' · égalité';
        return 'Affrontement ' + x.index + ' : ' + score + win;
      }).join(' · ') + '</p>';
    }
    if (m.status === 'ouvert') {
      h += '<p class="timer">' + (live ? 'Se termine dans <span data-closes="' + m.closesAt + '">' + fmtLeft(m.closesAt - t) + '</span> · ' + esc(fmtDate(m.closesAt))
        : 'Le vote est terminé, le résultat arrive.') + '</p>';
      var pctT = m.eligible ? Math.min(100, Math.round(100 * m.votes / m.eligible)) : 0;
      h += '<div class="turnout"><div class="track"><div class="fill" style="width:' + pctT + '%"></div></div>' +
        '<p class="nums"><span>' + m.votes + ' vote' + (m.votes > 1 ? 's' : '') + ' enregistré' + (m.votes > 1 ? 's' : '') + '</span><span>sur ' + m.eligible + ' codes émis</span></p></div>';
      if (m.extensions) h += '<p class="note"><span class="chip warn">Prolongation ' + m.extensions + '</span> Égalité : ' + (S.cfg ? S.cfg.extendMinutes : 5) + ' minutes ajoutées. Ton vote peut départager les deux openings.</p>';
      if (!m.liveTally) h += '<p class="note">Le score est caché jusqu\'à la fin du duel.</p>';
    }
    var mode = m.status === 'clos' ? 'result' : (m.status === 'ouvert' ? 'vote' : 'plain');
    var order = [m.a, m.b];
    if (mode !== 'result' && flip(m.id)) order = [m.b, m.a];
    h += optHTML(order[0], 1, m, mode) + '<div class="vs" aria-hidden="true">VS</div>' + optHTML(order[1], 2, m, mode);
    if (m.status === 'clos' && m.tally) {
      h += '<p class="note">' + m.tally.total + ' vote' + (m.tally.total > 1 ? 's' : '') + ' compté' + (m.tally.total > 1 ? 's' : '') +
        (m.tally.ignored ? ', ' + m.tally.ignored + ' écarté' + (m.tally.ignored > 1 ? 's' : '') + ' (participants du duel)' : '') +
        (m.extensions ? ' · ' + m.extensions + ' prolongation' + (m.extensions > 1 ? 's' : '') : '') + '.</p>';
      if (m.encounters && m.tally) h += '<p class="note">Résultat des 3 affrontements : ' + m.tally.winsA + ' victoire(s) contre ' + m.tally.winsB + ' · total des votes ' + m.tally.a + ' – ' + m.tally.b + (m.tally.decidedByVotes ? ' (départage au total des votes)' : '') + ' · qualifié : <strong>' + esc(m.winnerSlot === m.a.slot ? m.reveal.a : m.reveal.b) + '</strong>.</p>';
      if (m.byLot) h += '<p class="note"><span class="chip warn">Tirage au sort</span> Égalité persistante : le serveur a tiré le gagnant au hasard.</p>';
    }
    var activeVoteKey = m.encounters ? m.id + ':e' + m.currentEncounter : m.id;
    if (live && S.me && S.me.votes[activeVoteKey]) h += '<p class="okmsg">Ton vote est enregistré. Tu peux le changer jusqu\'à la fin de cet affrontement.</p>';
    if (live && S.me && S.me.entry && S.me.entry.matchId === m.id) h += '<p class="note">C\'est ton duel : tu ne votes pas ici.</p>';
    if (live && !S.me) h += '<p class="note">Entre ton code d\'invitation en haut de la page pour voter.</p>';
    if (live && S.me && !S.me.name) h += '<p class="note">Choisis ton pseudo en haut de la page pour voter.</p>';
    return h + '</article>';
  }

  function renderDuels() {
    var el = $('duels');
    // Keep the real audio elements alive during refreshes. Recreating them
    // interrupts playback on mobile browsers even if currentTime is restored.
    var existingAudio = Array.prototype.slice.call(el.querySelectorAll('audio'));
    var existingVideo = Array.prototype.slice.call(el.querySelectorAll('video'));
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

    // Move matching existing audio nodes into the new layout instead of
    // replacing them. Their playback position and active stream stay intact.
    Array.prototype.forEach.call(el.querySelectorAll('audio'), function (fresh) {
      var src = fresh.getAttribute('src');
      var index = existingAudio.findIndex(function (a) { return a.getAttribute('src') === src; });
      if (index !== -1) fresh.parentNode.replaceChild(existingAudio.splice(index, 1)[0], fresh);
    });
    Array.prototype.forEach.call(el.querySelectorAll('video'), function (fresh) {
      var src = fresh.getAttribute('src');
      var index = existingVideo.findIndex(function (v) { return v.getAttribute('src') === src; });
      if (index !== -1) fresh.parentNode.replaceChild(existingVideo.splice(index, 1)[0], fresh);
    });
    el.querySelectorAll('audio, video').forEach(function (media) { media.playbackRate = mediaSpeed(); });
  }

  function renderLog() {
    var logs = S ? S.log : [];
    $('log').innerHTML = logs.length ? logs.map(function (l) {
      return '<li><time>' + esc(new Date(l.at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })) + '</time><span>' + esc(l.text) + '</span></li>';
    }).join('') : '<li><span class="note">Aucune action pour l\'instant. Elles apparaîtront ici dès que l\'organisateur agira.</span></li>';
  }

  function renderRules() {
    if (!S || !S.cfg) return;
    document.querySelectorAll('[data-cfg]').forEach(function (e) {
      var v = S.cfg[e.getAttribute('data-cfg')];
      e.textContent = v >= 60 && v % 60 === 0 ? (v / 60) + ' h' : v + ' minutes';
    });
  }
  function renderPrizeAnnouncement() {
    var el = $('prizeAnnouncement');
    if (!el) return;
    var cfg = S && S.t && S.t.prizeConfig;
    if (!cfg) { el.hidden = true; return; }
    el.hidden = false;
    var a = cfg.amounts || {};
    if (!cfg.enabled) { el.innerHTML = '<h2>Récompenses du tournoi</h2><p class="lead">L’organisateur a confirmé qu’aucune récompense financière n’est prévue pour ce tournoi.</p>'; return; }
    el.innerHTML = '<h2>Récompenses du tournoi</h2><p class="lead">L’organisateur a annoncé des récompenses financières :</p><ul><li>1re place : <strong>' + Number(a.first || 0).toLocaleString('fr-FR') + ' FCFA</strong></li>' +
      (Number(a.second || 0) > 0 ? '<li>2e place : <strong>' + Number(a.second).toLocaleString('fr-FR') + ' FCFA</strong></li>' : '') +
      (Number(a.third || 0) > 0 ? '<li>3e place : <strong>' + Number(a.third).toLocaleString('fr-FR') + ' FCFA</strong> (déterminée par un duel spécial)</li>' : '') + '</ul>';
  }
  function renderNotifications(){var el=$('notifications');if(!el)return;var list=S&&S.me&&S.me.notifications||[];el.hidden=!S||!S.me||!S.me.name;if(el.hidden)return;var unread=list.filter(n=>!n.read).length;el.innerHTML='<div class="row"><h2>Mes notifications'+(unread?' · '+unread+' nouvelle(s)':'')+'</h2>'+(unread?'<button class="btn small" id="readNotifications">Tout marquer comme lu</button>':'')+'</div>'+(list.length?'<ul class="log">'+list.slice(0,20).map(n=>'<li><strong>'+esc(n.title)+'</strong><span>'+esc(n.message)+'</span><small>'+fmtDate(n.at)+(n.read?' · Lu':' · Nouveau')+'</small></li>').join('')+'</ul>':'<p class="note">Tu n’as pas encore de notification.</p>');}
  function renderAll() { renderRules(); renderHead(); renderNotice(); renderPrizeAnnouncement(); renderLogin(); renderNotifications(); renderReg(); renderChamp(); renderDuels(); renderLog(); }

  /* ---------- actions ---------- */
  async function castVote(mid, slot) {
    if (voting) return;
    voting = true; voteMsg = ''; renderDuels();
    try {
      await api('/api/vote', { matchId: mid, slot: slot });
      var match = S.matches.find(function (m) { return m.id === mid; });
      var voteKey = match && match.encounters ? mid + ':e' + match.currentEncounter : mid;
      S.me.votes[voteKey] = slot;
    } catch (e) { voteMsg = e.message || 'Ton vote n\'a pas pu être enregistré.'; }
    voting = false; renderDuels(); load();
  }

  async function sendReaction(button) {
    if(reacting)return;reacting=true;renderDuels();
    try{await api('/api/reaction',{matchId:button.getAttribute('data-m'),slot:button.getAttribute('data-s'),encounter:Number(button.getAttribute('data-e')),type:button.getAttribute('data-reaction')});await load();}
    catch(e){voteMsg=e.message||'Réaction impossible.';}
    finally{reacting=false;renderDuels();}
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.classList.contains('reaction-btn')) sendReaction(b);
    else if (b.hasAttribute('data-prize-confirm')) {
      api('/api/prize/confirm', { received: b.getAttribute('data-prize-confirm') === 'yes' }).then(load).catch(function (er) { loginErr = er.message; lastLoginKey = ''; load(); });
    } else if (b.id === 'readNotifications') api('/api/notifications/read', {}).then(load).catch(function(){});
    else if (b.classList.contains('vote')) castVote(b.getAttribute('data-m'), b.getAttribute('data-s'));
    else if (b.id === 'logoutBtn') api('/api/logout', {}).then(function () { lastLoginKey = ''; lastRegKey = ''; return load(); });
  });


  document.addEventListener('change', function (e) {
    var select = e.target;
    if (!select.matches('[data-media-speed]')) return;
    var speed = Number(select.value);
    if ([0.75, 1, 1.25, 1.5, 2].indexOf(speed) === -1) return;
    try { localStorage.setItem('arene-media-speed', String(speed)); } catch (err) { /* stockage facultatif */ }
    document.querySelectorAll('audio, video').forEach(function (media) { media.playbackRate = speed; });
  });

  document.addEventListener('submit', async function (e) {
    e.preventDefault();
    var f = e.target;
    if (f.id === 'loginForm') {
      loginErr = '';
      try { await api('/api/redeem', { code: f.elements.code.value, name: f.elements.pseudo.value }); lastLoginKey = ''; }
      catch (er) { loginErr = er.message; lastLoginKey = ''; }
      await load();
    } else if (f.id === 'nameForm') {
      loginErr = '';
      try { await api('/api/name', { name: f.elements.name.value }); }
      catch (er) { loginErr = er.message; }
      lastLoginKey = '';
      await load();
    } else if (f.id === 'mobileMoneyForm') {
      try { await api('/api/mobile-money', { provider: f.elements.provider.value, number: f.elements.number.value }); loginErr = ''; }
      catch (er) { loginErr = er.message; }
      lastLoginKey = ''; await load();
    } else if (f.id === 'regForm') {
      regMsg = ''; regErr = '';
      var btn = f.querySelector('button[type=submit]'), upmsg = $('upmsg'), regSuccess = false;
      try {
        registrationHold = false;
        registrationBusy = true;
        btn.disabled = true;
        if (S.t && S.t.mediaMode === 'video3') {
          var videos = [];
          for (var i = 1; i <= 3; i++) {
            var file = f.elements['video' + i].files[0];
            if (file) {
              try {
                if (file.size > 60 * 1048576) throw new Error('le fichier dépasse 60 Mo.');
                if (!/^video\/(mp4|quicktime)$/.test(file.type) && !/\.(mp4|mov)$/i.test(file.name)) throw new Error('format non accepté (MP4 ou MOV requis).');
                var slot = i;
                var uploaded = await uploadVideo(file, slot, function (p) { upmsg.textContent = 'Envoi de la vidéo ' + slot + '… ' + p + ' %'; });
                if (!uploaded || !uploaded.file) throw new Error('le serveur n’a pas confirmé son enregistrement.');
                upmsg.textContent = 'Vidéo ' + slot + ' enregistrée. Préparation de la suite…';
              } catch (videoError) {
                throw new Error('Vidéo n°' + i + ' refusée : ' + (videoError.message || 'envoi impossible.') + ' Vérifie cette vidéo puis réessaie.');
              }
            }
            videos.push({ anime: f.elements['anime' + i].value, title: f.elements['title' + i].value, order: Number(f.elements['order' + i].value) });
          }
          await api('/api/entry', { name: f.elements.name.value, videos: videos });
        } else {
          var d = {};
          ['name', 'anime', 'title', 'link'].forEach(function (k) { d[k] = f.elements[k].value; });
          var audioFile = f.elements.audio.files[0];
          if (audioFile) {
            var max = (S && S.cfg ? S.cfg.maxAudioMb : 15) * 1048576;
            if (audioFile.size > max) throw new Error('Fichier trop volumineux.');
            await uploadAudio(audioFile, function (p) { upmsg.textContent = 'Envoi du fichier… ' + p + ' %'; });
          }
          await api('/api/entry', d);
        }
        regMsg = 'Inscription enregistrée.';
        regSuccess = true;
      } catch (er) {
        regErr = er.message || 'Envoi impossible. Vérifie ta connexion et réessaie.';
        if (upmsg) { upmsg.textContent = regErr + ' Tes champs et fichiers restent en place : tu peux réessayer sans tout recommencer.'; upmsg.className = 'err'; }
      }
      btn.disabled = false; registrationBusy = false;
      if (regSuccess) { registrationHold = false; lastRegKey = ''; await load(); }
      else { registrationHold = true; }
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

  document.addEventListener('play', function (e) {
    document.querySelectorAll('audio, video').forEach(function (media) { if (media !== e.target) media.pause(); });
  }, true);

  document.querySelectorAll('audio, video').forEach(function (media) { media.playbackRate = mediaSpeed(); });
  renderAll();
  load();
})();
