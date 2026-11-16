'use strict';
/*
 * Arène des Openings : serveur sans dépendance (Node 18+).
 * Données : un fichier JSON dans DATA_DIR. Voir README.md.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TICK_MS = Number(process.env.TICK_MS) || 5000;
const PUBLIC_DIR = path.join(__dirname, 'public');

if (ADMIN_PASSWORD.length < 8) {
  console.error('ADMIN_PASSWORD est manquant ou trop court (8 caractères minimum).');
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');

let SECRET;
try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) { SECRET = ''; }
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
}

/* ---------- état ---------- */
const emptyState = () => ({ t: null, codes: [], entrants: {}, matches: {}, pairings: {}, votes: {}, log: [] });
let S;
try { S = Object.assign(emptyState(), JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))); } catch (e) { S = emptyState(); }

function save() {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(S));
  fs.renameSync(tmp, STATE_FILE);
}
function logIt(text) {
  S.log.push({ at: Date.now(), text: text });
  if (S.log.length > 500) S.log.shift();
}

/* ---------- sessions signées ---------- */
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const mk = (v) => v + '.' + sign(v);
function unmk(s) {
  if (typeof s !== 'string') return null;
  const i = s.lastIndexOf('.');
  if (i < 1) return null;
  const v = s.slice(0, i), sig = s.slice(i + 1), exp = sign(v);
  if (sig.length !== exp.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp)) ? v : null;
}
function parseCookies(req) {
  const o = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) { try { o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch (e) { /* ignore */ } }
  });
  return o;
}
function setCookie(req, res, name, value, maxAgeSec) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  const c = name + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSec + secure;
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
}
function voterId(req) {
  const v = unmk(parseCookies(req).v);
  return v && S.codes.some((c) => c.id === v) ? v : null;
}
function isAdmin(req) {
  const v = unmk(parseCookies(req).a);
  if (!v || !v.startsWith('adm:')) return false;
  return Number(v.slice(4)) > Date.now();
}

/* ---------- limitation des essais ---------- */
const attempts = new Map();
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
function tooMany(key) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  attempts.set(key, a);
  return a.length >= 15;
}
function hit(key) { const a = attempts.get(key) || []; a.push(Date.now()); attempts.set(key, a); }

/* ---------- utilitaires ---------- */
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 8; i++) c += ALPHA[crypto.randomInt(ALPHA.length)];
    if (!S.codes.some((x) => x.code === c)) return c;
  }
}
const fmtCode = (c) => c.slice(0, 4) + '-' + c.slice(4);
const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function shuffle(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    const t = r[i]; r[i] = r[j]; r[j] = t;
  }
  return r;
}
function safeUrl(u) {
  try {
    const x = new URL(String(u));
    return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : null;
  } catch (e) { return null; }
}
const clean = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const frDate = (ms) => new Date(ms).toLocaleString('fr-FR', { timeZone: 'Africa/Douala', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const durLabel = (min) => (min >= 60 && min % 60 === 0) ? (min / 60) + ' h' : min + ' min';

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };

/* ---------- logique du tournoi ---------- */
function createRound(r, ids) {
  const order = shuffle(ids);
  for (let i = 0; i < order.length; i += 2) {
    const idx = i / 2 + 1, id = 'r' + r + 'm' + idx;
    let aU = order[i], bU = order[i + 1] || null;
    if (bU && crypto.randomInt(2) === 1) { const x = aU; aU = bU; bU = x; }
    const side = (u, k) => { const e = S.entrants[u]; return { slot: id + k, title: e.title, anime: e.anime, link: e.link }; };
    const m = { id: id, round: r, idx: idx, status: bU ? 'attente' : 'clos', a: side(aU, 'a'), b: bU ? side(bU, 'b') : null };
    if (!bU) { m.bye = true; m.winnerSlot = id + 'a'; m.reveal = { a: S.entrants[aU].name }; }
    S.matches[id] = m;
    S.pairings[id] = { aUid: aU, bUid: bU };
    S.entrants[aU].matchId = id; S.entrants[aU].slot = id + 'a';
    if (bU) { S.entrants[bU].matchId = id; S.entrants[bU].slot = id + 'b'; }
  }
}
const matchList = () => Object.values(S.matches).sort((x, y) => x.round - y.round || x.idx - y.idx);
const currentMatches = () => matchList().filter((m) => m.round === S.t.round);

function closeExpired() {
  const now = Date.now();
  let changed = false;
  for (const m of matchList()) {
    if (m.status !== 'ouvert' || now < m.closesAt) continue;
    const p = S.pairings[m.id];
    let a = 0, b = 0, ign = 0;
    for (const cid of Object.keys(S.votes)) {
      const pick = S.votes[cid][m.id];
      if (pick !== m.a.slot && pick !== m.b.slot) continue;
      if (cid === p.aUid || cid === p.bUid) { ign++; continue; }
      if (pick === m.a.slot) a++; else b++;
    }
    m.tally = { a: a, b: b, total: a + b, ignored: ign };
    const label = 'Tour ' + m.round + ', duel ' + m.idx;
    if (a === b) {
      m.status = 'egalite';
      logIt(label + ' : égalité ' + a + ' à ' + b + '. Le vote doit être prolongé.');
    } else {
      m.status = 'clos';
      m.winnerSlot = a > b ? m.a.slot : m.b.slot;
      const an = S.entrants[p.aUid].name, bn = S.entrants[p.bUid].name;
      m.reveal = { a: an, b: bn };
      logIt(label + ' clôturé automatiquement : ' + an + ' ' + a + ' – ' + b + ' ' + bn +
        (ign ? ' (' + ign + ' vote' + (ign > 1 ? 's' : '') + ' écarté' + (ign > 1 ? 's' : '') + ')' : '') +
        '. Qualifié : ' + (a > b ? an : bn) + '.');
    }
    changed = true;
  }
  if (changed) save();
}

/* ---------- vues JSON ---------- */
function pubMatch(m) {
  const o = { id: m.id, round: m.round, idx: m.idx, status: m.status, bye: !!m.bye, a: m.a, b: m.b, closesAt: m.closesAt || null };
  if (m.status === 'clos' || m.status === 'egalite') o.tally = m.tally || null;
  if (m.status === 'clos') { o.winnerSlot = m.winnerSlot; o.reveal = m.reveal; }
  return o;
}
function publicState(vid) {
  const voted = Object.keys(S.votes).filter((c) => Object.keys(S.votes[c]).length > 0).length;
  const out = {
    now: Date.now(),
    t: S.t,
    matches: matchList().map(pubMatch),
    stats: { codes: S.codes.length, used: S.codes.filter((c) => c.usedAt).length, voted: voted },
    log: S.log.slice(-100).reverse(),
    me: null
  };
  if (vid) {
    const e = S.entrants[vid];
    out.me = {
      entry: e ? { name: e.name, anime: e.anime, title: e.title, link: e.link, matchId: e.matchId || null, slot: e.slot || null } : null,
      votes: S.votes[vid] || {}
    };
  }
  return out;
}

/* ---------- actions ---------- */
function needTournament(status) {
  if (!S.t) fail(409, 'Aucun tournoi n\'a été créé.');
  if (status && S.t.status !== status) fail(409, 'Cette action n\'est pas possible à ce stade du tournoi.');
}
function minutesOf(body) {
  const m = Number(body && body.minutes);
  if (!(m >= 0.05 && m <= 10080)) fail(400, 'Durée invalide.');
  return m;
}

const routes = {
  'POST /api/redeem': (req, res, body) => {
    const ip = 'code:' + clientIp(req);
    if (tooMany(ip)) fail(429, 'Trop d\'essais. Réessaie dans quelques minutes.');
    const code = normCode(body.code);
    const c = S.codes.find((x) => x.code === code);
    if (!c) { hit(ip); fail(401, 'Code inconnu. Vérifie-le ou demande-en un à l\'organisateur.'); }
    if (!c.usedAt) { c.usedAt = Date.now(); save(); }
    setCookie(req, res, 'v', mk(c.id), 90 * 24 * 3600);
    return { ok: true };
  },
  'POST /api/logout': (req, res) => { setCookie(req, res, 'v', '', 0); return { ok: true }; },
  'GET /api/state': (req) => publicState(voterId(req)),

  'POST /api/entry': (req, res, body) => {
    const vid = voterId(req);
    if (!vid) fail(401, 'Entre ton code d\'invitation d\'abord.');
    needTournament('inscription');
    const name = clean(body.name, 40), anime = clean(body.anime, 60), title = clean(body.title, 80), link = safeUrl(clean(body.link, 300));
    if (!name || !anime || !title) fail(400, 'Remplis le pseudo, l\'anime et le titre.');
    if (!link) fail(400, 'Le lien doit commencer par https://');
    S.entrants[vid] = { name: name, anime: anime, title: title, link: link };
    save();
    return { ok: true };
  },
  'POST /api/vote': (req, res, body) => {
    const vid = voterId(req);
    if (!vid) fail(401, 'Entre ton code d\'invitation pour voter.');
    const m = S.matches[String(body.matchId)];
    if (!m || m.bye) fail(404, 'Duel introuvable.');
    if (m.status !== 'ouvert' || Date.now() >= m.closesAt) fail(409, 'Le vote de ce duel est fermé.');
    if (body.slot !== m.a.slot && body.slot !== m.b.slot) fail(400, 'Choix invalide.');
    const p = S.pairings[m.id];
    if (vid === p.aUid || vid === p.bUid) fail(403, 'Tu ne votes pas dans ton propre duel.');
    S.votes[vid] = S.votes[vid] || {};
    S.votes[vid][m.id] = body.slot;
    save();
    return { ok: true };
  },

  'POST /api/admin/login': (req, res, body) => {
    const ip = 'adm:' + clientIp(req);
    if (tooMany(ip)) fail(429, 'Trop d\'essais. Réessaie dans quelques minutes.');
    const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
    if (!crypto.timingSafeEqual(h(body.password), h(ADMIN_PASSWORD))) { hit(ip); fail(401, 'Mot de passe incorrect.'); }
    setCookie(req, res, 'a', mk('adm:' + (Date.now() + 12 * 3600 * 1000)), 12 * 3600);
    return { ok: true };
  },
  'POST /api/admin/logout': (req, res) => { setCookie(req, res, 'a', '', 0); return { ok: true }; },
  'GET /api/admin/state': () => {
    const st = publicState(null);
    st.admin = true;
    st.codes = S.codes.map((c) => ({ code: fmtCode(c.code), used: !!c.usedAt }));
    st.entrantCount = Object.keys(S.entrants).length;
    return st;
  },
  'POST /api/admin/create': (req, res, body) => {
    if (S.t) fail(409, 'Un tournoi existe déjà. Utilise « Nouveau tournoi ».');
    const name = clean(body.name, 60);
    if (!name) fail(400, 'Donne un nom au tournoi.');
    S.t = { name: name, status: 'inscription', round: 0, createdAt: Date.now() };
    logIt('Tournoi créé : ' + name + '. Inscriptions ouvertes.');
    save();
    return { ok: true };
  },
  'POST /api/admin/codes': (req, res, body) => {
    const n = Math.floor(Number(body.count));
    if (!(n >= 1 && n <= 300)) fail(400, 'Choisis un nombre entre 1 et 300.');
    for (let i = 0; i < n; i++) S.codes.push({ id: crypto.randomBytes(8).toString('hex'), code: newCode(), createdAt: Date.now(), usedAt: null });
    logIt(n + ' code' + (n > 1 ? 's' : '') + ' d\'invitation généré' + (n > 1 ? 's' : '') + '. Total émis : ' + S.codes.length + '.');
    save();
    return { ok: true };
  },
  'POST /api/admin/draw': () => {
    needTournament('inscription');
    const ids = Object.keys(S.entrants);
    if (ids.length < 2) fail(409, 'Il faut au moins 2 inscrits pour tirer au sort.');
    const n = ids.length;
    createRound(1, ids);
    S.t.status = 'en_cours'; S.t.round = 1; S.t.roundsTotal = Math.ceil(Math.log2(n)); S.t.entrantCount = n;
    logIt('Inscriptions fermées. Tirage au sort fait par le serveur : ' + n + ' participants, ' + Math.ceil(n / 2) + ' duels au tour 1' + (n % 2 ? ', dont 1 qualifié d\'office' : '') + '.');
    save();
    return { ok: true };
  },
  'POST /api/admin/open': (req, res, body) => {
    needTournament('en_cours');
    const min = minutesOf(body);
    const pend = currentMatches().filter((m) => m.status === 'attente');
    if (!pend.length) fail(409, 'Aucun duel à ouvrir.');
    const now = Date.now(), end = now + min * 60000;
    pend.forEach((m) => { m.status = 'ouvert'; m.opensAt = now; m.closesAt = end; });
    logIt('Tour ' + S.t.round + ' : votes ouverts pour ' + pend.length + ' duel' + (pend.length > 1 ? 's' : '') + ', durée ' + durLabel(min) + ', fin le ' + frDate(end) + '. Clôture automatique.');
    save();
    return { ok: true };
  },
  'POST /api/admin/extend': (req, res, body) => {
    needTournament('en_cours');
    const min = minutesOf(body);
    const tie = currentMatches().filter((m) => m.status === 'egalite');
    if (!tie.length) fail(409, 'Aucun duel à égalité.');
    const end = Date.now() + min * 60000;
    tie.forEach((m) => { m.status = 'ouvert'; m.closesAt = end; m.tally = null; m.extensions = (m.extensions || 0) + 1; });
    logIt('Tour ' + S.t.round + ' : vote prolongé pour ' + tie.length + ' duel' + (tie.length > 1 ? 's' : '') + ' à égalité, ' + durLabel(min) + ', fin le ' + frDate(end) + '.');
    save();
    return { ok: true };
  },
  'POST /api/admin/next': () => {
    needTournament('en_cours');
    const cur = currentMatches();
    if (!cur.length || !cur.every((m) => m.status === 'clos')) fail(409, 'Tous les duels du tour doivent être terminés.');
    const winners = cur.map((m) => (m.winnerSlot === m.a.slot ? S.pairings[m.id].aUid : S.pairings[m.id].bUid));
    if (winners.length === 1) {
      const c = S.entrants[winners[0]];
      S.t.status = 'termine';
      S.t.champion = { name: c.name, title: c.title, anime: c.anime, link: c.link };
      logIt('Tournoi terminé. Vainqueur : ' + c.name + ' avec « ' + c.title + ' ».');
    } else {
      const next = S.t.round + 1;
      createRound(next, winners);
      S.t.round = next;
      logIt('Tour ' + next + ' lancé : ' + winners.length + ' qualifiés, duels tirés au sort par le serveur.');
    }
    save();
    return { ok: true };
  },
  'POST /api/admin/reset': (req, res, body) => {
    if (body.confirm !== 'NOUVEAU') fail(400, 'Tape NOUVEAU pour confirmer.');
    fs.writeFileSync(path.join(DATA_DIR, 'archive-' + Date.now() + '.json'), JSON.stringify(S));
    const codes = S.codes.map((c) => ({ id: c.id, code: c.code, createdAt: c.createdAt, usedAt: c.usedAt }));
    S = emptyState();
    S.codes = codes;
    logIt('Nouveau tournoi : les inscriptions, duels et votes précédents ont été archivés. Les codes d\'invitation sont conservés.');
    save();
    return { ok: true };
  }
};

/* ---------- HTTP ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SEC = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 20000) { reject(new HttpError(413, 'Requête trop grande.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(j && typeof j === 'object' ? j : {}); }
      catch (e) { reject(new HttpError(400, 'JSON invalide.')); }
    });
    req.on('error', reject);
  });
}
function sendJson(res, status, obj) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC));
  res.end(JSON.stringify(obj));
}
function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname === '/admin' ? '/admin.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(404, SEC); return res.end('Introuvable'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, SEC); return res.end('Introuvable'); }
    res.writeHead(200, Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, SEC));
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const key = req.method + ' ' + url.pathname;
    if (url.pathname.startsWith('/api/')) {
      const fn = routes[key];
      if (!fn) return sendJson(res, 404, { error: 'Introuvable.' });
      if (url.pathname.startsWith('/api/admin/') && url.pathname !== '/api/admin/login' && !isAdmin(req)) return sendJson(res, 401, { error: 'Connexion organisateur requise.' });
      let body = {};
      if (req.method === 'POST') {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res, 415, { error: 'Format non accepté.' });
        body = await readBody(req);
      }
      closeExpired();
      return sendJson(res, 200, fn(req, res, body));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SEC); return res.end(); }
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    return sendJson(res, 500, { error: 'Erreur du serveur.' });
  }
});

setInterval(closeExpired, TICK_MS).unref();
server.listen(PORT, () => console.log('Arène des Openings sur http://localhost:' + PORT));
