'use strict';
/*
 * Arène des Openings : serveur sans dépendance (Node 18+).
 * Données persistées dans PostgreSQL et fichiers audio dans Neon Object Storage.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { Pool } = require('pg');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, HeadBucketCommand, DeleteObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand, CompleteMultipartUploadCommand } = require('@aws-sdk/client-s3');
const { pipeline, Transform } = require('node:stream');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TICK_MS = Number(process.env.TICK_MS) || 5000;
// Durée d'un vote et prolongation en cas d'égalité, en minutes (les variables ne servent qu'aux tests).
const VOTE_MINUTES = Number(process.env.VOTE_MINUTES) || 15;
const EXTEND_MINUTES = Number(process.env.EXTEND_MINUTES) || 5;
// Après ce nombre de prolongations sans départage, le serveur tire au sort pour ne pas bloquer le tournoi.
const MAX_EXTENSIONS = process.env.MAX_EXTENSIONS ? Number(process.env.MAX_EXTENSIONS) : 6;
const MAX_AUDIO = Math.round((Number(process.env.MAX_AUDIO_MB) || 15) * 1024 * 1024);
const MAX_VIDEO = Math.round((Number(process.env.MAX_VIDEO_MB) || 60) * 1024 * 1024);
const MAX_VIDEO_SECONDS = 120;
const PUBLIC_DIR = path.join(__dirname, 'public');

if (ADMIN_PASSWORD.length < 8) { console.error('ADMIN_PASSWORD est manquant ou trop court (8 caractères minimum).'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL est manquant.'); process.exit(1); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
const BUCKET = process.env.AUDIO_BUCKET || 'arene-audio';
const s3 = new S3Client({ endpoint: process.env.AWS_ENDPOINT_URL_S3, region: process.env.AWS_REGION || 'eu-central-1', forcePathStyle: true, credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY } });
if (!process.env.AWS_ENDPOINT_URL_S3 || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) { console.error('Configuration Neon Object Storage incomplète.'); process.exit(1); }
let SECRET = process.env.SESSION_SECRET || '';
const emptyState = () => ({ t: null, codes: [], entrants: {}, matches: {}, pairings: {}, votes: {}, reactions: {}, uploads: {}, videoUploads: {}, bonuses: [], notifications: {}, community: { comments: [], favorites: {} }, log: [] });
let S = emptyState(), saveQueue = Promise.resolve(), pendingArchive = null;
// Cache en mémoire des archives : évite de retransférer tous les JSONB à chaque visite communauté/admin.
let archiveRowsCache = null;
async function getArchiveRows() {
  if (!archiveRowsCache) {
    const q = await pool.query('SELECT id, archived_at, state FROM tournament_archives ORDER BY archived_at DESC');
    archiveRowsCache = q.rows;
  }
  return archiveRowsCache;
}
function save() {
 const snapshot=JSON.stringify(S), archive=pendingArchive; pendingArchive=null;
 saveQueue=saveQueue.catch(()=>{}).then(async()=>{ if(archive) { await pool.query('INSERT INTO tournament_archives(state) VALUES ($1::jsonb)',[archive]); archiveRowsCache=null; } await pool.query('INSERT INTO app_state(id,state,updated_at) VALUES (1,$1::jsonb,now()) ON CONFLICT (id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()',[snapshot]); });
 return saveQueue;
}
function logIt(text) {
  S.log.push({ at: Date.now(), text: text });
  if (S.log.length > 500) S.log.shift();
}
function notifyPlayer(id,title,message,type){if(!id)return;S.notifications=S.notifications||{};const list=S.notifications[id]||(S.notifications[id]=[]);list.push({id:crypto.randomBytes(8).toString('hex'),title:clean(title,80),message:clean(message,300),type:type||'info',at:Date.now(),read:false});if(list.length>50)list.splice(0,list.length-50);}
function notifyAllPlayers(title,message,type){S.codes.filter(c=>c.name).forEach(c=>notifyPlayer(c.id,title,message,type));}

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
const codeOf = (vid) => S.codes.find((c) => c.id === vid) || null;
const cleanName = (s) => clean(s, 30);
const nameTaken = (name) => S.codes.some((c) => c.name && c.name.toLowerCase() === name.toLowerCase());
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
    const side = (u, k) => { const e = S.entrants[u]; const videos = Array.isArray(e.videos) ? e.videos.slice().sort((x,y) => Number(x.order || 0) - Number(y.order || 0)) : null; return { slot:id+k, title:e.title, anime:e.anime, link:e.link||null, audio:e.audio?e.audio.file:null, videos }; };
    const m = { id, round:r, idx, status:bU?'attente':'clos', a:side(aU,'a'), b:bU?side(bU,'b'):null };
    if (bU && S.t && S.t.mediaMode === 'video3') { m.currentEncounter=1; m.encounters=[1,2,3].map(index=>({index,status:'attente',extensions:0})); }
    if (!bU) { m.bye=true; m.winnerSlot=id+'a'; m.reveal={a:S.entrants[aU].name}; }
    S.matches[id]=m; S.pairings[id]={aUid:aU,bUid:bU};
    S.entrants[aU].matchId=id; S.entrants[aU].slot=id+'a';
    if (bU) { S.entrants[bU].matchId=id; S.entrants[bU].slot=id+'b'; }
  }
}
const matchList = () => Object.values(S.matches).sort((x, y) => x.round - y.round || x.idx - y.idx);
const currentMatches = () => matchList().filter((m) => m.round === S.t.round);

function countBallots(m, encounterIndex) {
  const p=S.pairings[m.id], byId=new Map(S.codes.map(c=>[c.id,c]));
  const voteKey=m.encounters ? m.id+':e'+(encounterIndex||m.currentEncounter||1) : m.id;
  const r={a:0,b:0,ign:0,names:{a:[],b:[]}};
  for(const cid of Object.keys(S.votes)){
    const pick=S.votes[cid][voteKey];
    if(pick!==m.a.slot&&pick!==m.b.slot)continue;
    if(cid===p.aUid||cid===p.bUid){r.ign++;continue;}
    const c=byId.get(cid),nm=c&&c.name?c.name:'Anonyme';
    if(pick===m.a.slot){r.a++;r.names.a.push(nm);}else{r.b++;r.names.b.push(nm);}
  }
  const cmp=(x,y)=>x.localeCompare(y,'fr',{sensitivity:'base'});
  r.names.a.sort(cmp);r.names.b.sort(cmp);return r;
}
function closeExpired() {
  const now=Date.now();let changed=false;
  for(const m of matchList()){
    if(m.status==='egalite'){m.status='ouvert';m.closesAt=now+EXTEND_MINUTES*60000;changed=true;continue;}
    if(m.status!=='ouvert'||now<m.closesAt)continue;
    const p=S.pairings[m.id],idx=m.encounters?(m.currentEncounter||1):0;
    const r=countBallots(m,idx||undefined),label='Tour '+m.round+', duel '+m.idx+(m.encounters?', affrontement '+idx+'/3':'');
    if(r.a===r.b&&(m.extensions||0)<MAX_EXTENSIONS){
      m.extensions=(m.extensions||0)+1;if(m.encounters)m.encounters[idx-1].extensions=m.extensions;
      const late=now-m.closesAt>30000;m.closesAt=(late?now:m.closesAt)+EXTEND_MINUTES*60000;
      logIt(label+' : égalité '+r.a+' à '+r.b+'. Prolongation '+m.extensions+' : +'+durLabel(EXTEND_MINUTES)+', fin à '+frDate(m.closesAt)+'.');
    }else{
      const tied=r.a===r.b,byLot=tied&&!m.encounters,winner=tied?null:(r.a>r.b?m.a.slot:m.b.slot);
      if(m.encounters){
        const enc=m.encounters[idx-1];Object.assign(enc,{status:'clos',tally:{a:r.a,b:r.b,total:r.a+r.b,ignored:r.ign},winnerSlot:winner,byLot:false});
        m.status='attente';m.closesAt=null;m.live=false;m.extensions=0;
        if(idx<3){m.currentEncounter=idx+1;logIt(label+' terminé : '+r.a+' – '+r.b+(tied?' (égalité)':'')+'. Le prochain affrontement est prêt.');}
        else{
          const winsA=m.encounters.filter(x=>x.winnerSlot===m.a.slot).length,winsB=m.encounters.filter(x=>x.winnerSlot===m.b.slot).length;
          const totals=m.encounters.reduce((z,x)=>({a:z.a+Number(x.tally.a||0),b:z.b+Number(x.tally.b||0),ignored:z.ignored+Number(x.tally.ignored||0)}),{a:0,b:0,ignored:0});
          const decidedByVotes=winsA<2&&winsB<2,fa=decidedByVotes?totals.a:winsA,fb=decidedByVotes?totals.b:winsB,lot=fa===fb;
          m.winnerSlot=lot?(crypto.randomInt(2)===0?m.a.slot:m.b.slot):(fa>fb?m.a.slot:m.b.slot);
          m.byLot=lot;m.tally={a:totals.a,b:totals.b,total:totals.a+totals.b,ignored:totals.ignored,winsA,winsB,decidedByVotes};
          m.reveal={a:S.entrants[p.aUid].name,b:S.entrants[p.bUid].name};m.voters=null;m.status='clos';
          logIt(label+' clôturé : '+m.reveal.a+' '+winsA+' victoire(s), '+m.reveal.b+' '+winsB+' victoire(s). Total des votes '+totals.a+' – '+totals.b+(decidedByVotes?' (départage au total des votes)':'')+(lot?' (égalité parfaite, tirage au sort)':'')+'.');
        }
      }else{
        m.status='clos';m.winnerSlot=byLot?(crypto.randomInt(2)===0?m.a.slot:m.b.slot):winner;m.byLot=byLot;
        m.tally={a:r.a,b:r.b,total:r.a+r.b,ignored:r.ign};m.voters=r.names;
        m.reveal={a:S.entrants[p.aUid].name,b:S.entrants[p.bUid].name};
        logIt(label+' clôturé automatiquement : '+m.reveal.a+' '+r.a+' – '+r.b+' '+m.reveal.b+(byLot?' (égalité persistante, tirage au sort)':'')+'.');
      }
    }
    changed=true;
  }
  if(changed)save();
}
/* ---------- vues JSON ---------- */
function pubMatch(m, vid) {
  const o={id:m.id,round:m.round,idx:m.idx,status:m.status,bye:!!m.bye,a:m.a,b:m.b,closesAt:m.closesAt||null,extensions:m.extensions||0,live:!!m.live,eligible:Math.max(0,S.codes.length-(m.bye?0:2)),currentEncounter:m.currentEncounter||1,encounters:m.encounters||null};
  const reactionKey=m.id+':e'+(m.encounters?m.currentEncounter:1), stored=S.reactions&&S.reactions[reactionKey]||{};
  const reactionSummary=(slot)=>{const entries=Object.entries(stored).filter(x=>x[1]&&x[1].slot===slot);const counts={love:0,fire:0,laugh:0,wow:0,clap:0};entries.forEach(x=>{if(counts[x[1].type]!==undefined)counts[x[1].type]++;});const mine=vid&&(stored[vid+':'+slot]||((stored[vid]||{}).slot===slot?stored[vid]:null));return {counts,mine:mine?mine.type:null,total:entries.length};};
  o.reactions={a:reactionSummary(m.a.slot),b:m.b?reactionSummary(m.b.slot):null};
  if(m.status==='ouvert'){const r=countBallots(m,m.encounters?m.currentEncounter:undefined);o.votes=r.a+r.b;if(m.live)o.liveTally={a:r.a,b:r.b};}
  if(m.status==='clos'){o.tally=m.tally||null;o.winnerSlot=m.winnerSlot;o.reveal=m.reveal;o.voters=m.voters||null;o.byLot=!!m.byLot;}
  return o;
}
function publicState(vid) {
  const voted = Object.keys(S.votes).filter((c) => Object.keys(S.votes[c]).length > 0).length;
  const out = {
    now: Date.now(),
    cfg: { voteMinutes: VOTE_MINUTES, extendMinutes: EXTEND_MINUTES, maxExtensions: MAX_EXTENSIONS, maxAudioMb: MAX_AUDIO / 1048576, maxVideoMb: MAX_VIDEO / 1048576, maxVideoSeconds: MAX_VIDEO_SECONDS },
    t: S.t ? Object.assign({}, S.t, {
      prizePayouts: undefined, championId: undefined, runnerUpId: undefined, thirdPlaceId: undefined,
      hasThirdPlacePlayoff: !!(S.t.thirdPlacePlayers && S.t.thirdPlacePlayers.length === 2), thirdPlacePlayers: undefined,
      podium: S.t.status === 'termine' ? [
        S.t.championId && S.entrants[S.t.championId] ? { place: 1, name: S.entrants[S.t.championId].name, title: S.entrants[S.t.championId].title, anime: S.entrants[S.t.championId].anime, link: S.entrants[S.t.championId].link || null } : null,
        S.t.runnerUpId && S.entrants[S.t.runnerUpId] ? { place: 2, name: S.entrants[S.t.runnerUpId].name, title: S.entrants[S.t.runnerUpId].title, anime: S.entrants[S.t.runnerUpId].anime, link: S.entrants[S.t.runnerUpId].link || null } : null,
        S.t.thirdPlaceId && S.entrants[S.t.thirdPlaceId] ? { place: 3, name: S.entrants[S.t.thirdPlaceId].name, title: S.entrants[S.t.thirdPlaceId].title, anime: S.entrants[S.t.thirdPlaceId].anime, link: S.entrants[S.t.thirdPlaceId].link || null } : null
      ].filter(Boolean) : []
    }) : null,
    matches: matchList().map((m) => pubMatch(m, vid)),
    stats: { codes: S.codes.length, used: S.codes.filter((c) => c.usedAt).length, voted: voted, entrants: Object.keys(S.entrants).length },
    log: S.log.slice(-100).reverse(),
    me: null
  };
  if (vid) {
    const e = S.entrants[vid], c = codeOf(vid);
    out.me = {
      name: c && c.name || null,
      entry: e ? { name: e.name, anime: e.anime, title: e.title, link: e.link || null, audio: e.audio ? e.audio.file : null, videos: e.videos || null, matchId: e.matchId || null, slot: e.slot || null } : null,
      videoUploads: S.videoUploads && S.videoUploads[vid] ? S.videoUploads[vid] : {},
      votes: S.votes[vid] || {},
      mobileMoney: c && c.mobileMoney ? c.mobileMoney : null,
      prize: S.t && Array.isArray(S.t.prizePayouts) ? S.t.prizePayouts.find((p) => p.playerId === vid) || null : null,
      notifications: (S.notifications && S.notifications[vid] || []).slice().reverse()
    };
  }
  return out;
}

/* ---------- actions ---------- */
function needTournament(status) {
  if (!S.t) fail(409, 'Aucun tournoi n\'a été créé.');
  if (status && S.t.status !== status) fail(409, 'Cette action n\'est pas possible à ce stade du tournoi.');
}
/* ---------- fichiers audio ---------- */
const AUDIO_TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm', flac: 'audio/flac', aac: 'audio/aac' };
function sniffAudio(b) {
  if (b.length < 12) return null;
  if (b.toString('latin1', 0, 3) === 'ID3') return 'mp3';
  if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return ((b[1] >> 1) & 3) === 0 ? 'aac' : 'mp3';
  if (b.toString('latin1', 0, 4) === 'OggS') return 'ogg';
  if (b.toString('latin1', 0, 4) === 'fLaC') return 'flac';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (b.toString('latin1', 4, 8) === 'ftyp') return 'm4a';
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return 'webm';
  return null;
}
function unlinkAudio(file) { if (/^[a-f0-9]{24}\.[a-z0-9]{3,4}$/.test(String(file))) s3.send(new DeleteObjectCommand({Bucket:BUCKET,Key:file})).catch(e=>console.error('Suppression audio:',e.message)); }

function videoBoxes(buf, start, end) {
  const out = []; let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p), header = 8;
    const type = buf.toString('latin1', p + 4, p + 8);
    if (size === 1) { if (p + 16 > end) break; const n = buf.readBigUInt64BE(p + 8); if (n > BigInt(Number.MAX_SAFE_INTEGER)) break; size = Number(n); header = 16; }
    else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    out.push({ type, start: p + header, end: p + size }); p += size;
  }
  return out;
}
function inspectMp4Video(buf) {
  const top = videoBoxes(buf, 0, buf.length);
  if (!top.some(x => x.type === 'ftyp')) return null;
  const moov = top.find(x => x.type === 'moov'); if (!moov) return null;
  const children = videoBoxes(buf, moov.start, moov.end);
  const mvhd = children.find(x => x.type === 'mvhd'); if (!mvhd) return null;
  const version = buf[mvhd.start]; let timescale, duration;
  if (version === 0 && mvhd.start + 20 <= mvhd.end) { timescale = buf.readUInt32BE(mvhd.start + 12); duration = buf.readUInt32BE(mvhd.start + 16); }
  else if (version === 1 && mvhd.start + 32 <= mvhd.end) { timescale = buf.readUInt32BE(mvhd.start + 20); const d = buf.readBigUInt64BE(mvhd.start + 24); if (d > BigInt(Number.MAX_SAFE_INTEGER)) return null; duration = Number(d); }
  else return null;
  if (!timescale || !duration) return null;
  const hasVideo = children.filter(x => x.type === 'trak').some(trak => {
    const mdia = videoBoxes(buf, trak.start, trak.end).find(x => x.type === 'mdia');
    return !!(mdia && videoBoxes(buf, mdia.start, mdia.end).some(x => x.type === 'hdlr' && x.end - x.start >= 12 && buf.toString('latin1', x.start + 8, x.start + 12) === 'vide'));
  });
  return hasVideo ? duration / timescale : null;
}
function unlinkVideo(file) { if (/^[a-f0-9]{24}\.mp4$/.test(String(file))) s3.send(new DeleteObjectCommand({Bucket:BUCKET,Key:file})).catch(e=>console.error('Suppression vidéo:',e.message)); }

const VIDEO_PART_SIZE = 5 * 1024 * 1024;
function videoMultipartKey(vid, session) {
  return 'video-parts/' + crypto.createHash('sha256').update(String(vid)).digest('hex').slice(0,24) + '/' + session + '.mp4';
}
async function videoMultipartInit(req,res,slot,body) {
  const vid=voterId(req);
  if(!vid)return sendJson(res,401,{error:"Entre ton code d'invitation d'abord."});
  if(!S.t||S.t.status!=='inscription')return sendJson(res,409,{error:'Les inscriptions sont fermées.'});
  const size=Number(body.size),session=String(body.session||'');
  if(!Number.isSafeInteger(size)||size<2048||size>MAX_VIDEO)return sendJson(res,413,{error:'Vidéo invalide ou supérieure à 60 Mo.'});
  if(!/^[a-f0-9]{32}$/.test(session))return sendJson(res,400,{error:'Session vidéo invalide.'});
  const key=videoMultipartKey(vid,session);
  try {
    if(body.uploadId) {
      const old=await s3.send(new ListPartsCommand({Bucket:BUCKET,Key:key,UploadId:String(body.uploadId),MaxParts:1000}));
      return sendJson(res,200,{uploadId:String(body.uploadId),parts:(old.Parts||[]).map(p=>p.PartNumber)});
    }
  } catch(e) { console.warn('Reprise vidéo: ancienne session expirée.'); }
  try {
    const created=await s3.send(new CreateMultipartUploadCommand({Bucket:BUCKET,Key:key,ContentType:'video/mp4'}));
    return sendJson(res,200,{uploadId:created.UploadId,parts:[]});
  } catch(e) { console.error('Initialisation multipart:',e); return sendJson(res,502,{error:'Impossible de préparer l’envoi vidéo.'}); }
}
async function videoMultipartPart(req,res,slot,session,part) {
  const vid=voterId(req);
  if(!vid)return sendJson(res,401,{error:"Entre ton code d'invitation d'abord."});
  if(!S.t||S.t.status!=='inscription')return sendJson(res,409,{error:'Les inscriptions sont fermées.'});
  const uploadId=String(req.headers['x-upload-id']||'');
  if(!uploadId||part<1||part>20)return sendJson(res,400,{error:'Bloc vidéo invalide.'});
  const chunks=[];let size=0;
  try {
    for await(const c of req){size+=c.length;if(size>VIDEO_PART_SIZE){req.destroy();return;}chunks.push(c);}
    if(!size)return sendJson(res,400,{error:'Bloc vidéo vide.'});
    const r=await s3.send(new UploadPartCommand({Bucket:BUCKET,Key:videoMultipartKey(vid,session),UploadId:uploadId,PartNumber:part,Body:Buffer.concat(chunks),ContentLength:size}));
    return sendJson(res,200,{ok:true,part,etag:r.ETag});
  } catch(e){console.error('Bloc vidéo:',e.message);if(!res.headersSent)return sendJson(res,502,{error:'Bloc non reçu. Nouvelle tentative possible.'});}
}
async function videoMultipartComplete(req,res,slot,session,body) {
  const vid=voterId(req);
  if(!vid)return sendJson(res,401,{error:"Entre ton code d'invitation d'abord."});
  if(!S.t||S.t.status!=='inscription')return sendJson(res,409,{error:'Les inscriptions sont fermées.'});
  const size=Number(body.size),uploadId=String(body.uploadId||'');
  if(!Number.isSafeInteger(size)||size<2048||size>MAX_VIDEO||!uploadId)return sendJson(res,400,{error:'Informations de finalisation invalides.'});
  const key=videoMultipartKey(vid,session);
  try {
    const l=await s3.send(new ListPartsCommand({Bucket:BUCKET,Key:key,UploadId:uploadId,MaxParts:1000}));
    const parts=(l.Parts||[]).sort((a,b)=>a.PartNumber-b.PartNumber),expected=Math.ceil(size/VIDEO_PART_SIZE);
    if(parts.length!==expected||parts.some((p,i)=>p.PartNumber!==i+1))return sendJson(res,409,{error:'Des blocs manquent. Réessaie pour reprendre l’envoi.'});
    await s3.send(new CompleteMultipartUploadCommand({Bucket:BUCKET,Key:key,UploadId:uploadId,MultipartUpload:{Parts:parts.map(p=>({ETag:p.ETag,PartNumber:p.PartNumber}))}}));
    const obj=await s3.send(new GetObjectCommand({Bucket:BUCKET,Key:key}));
    const bytes=Buffer.from(await obj.Body.transformToByteArray()),duration=inspectMp4Video(bytes);
    if(bytes.length!==size||!duration||duration>MAX_VIDEO_SECONDS+0.05){
      await s3.send(new DeleteObjectCommand({Bucket:BUCKET,Key:key})).catch(()=>{});
      return sendJson(res,415,{error:!duration?'Fichier MP4/MOV invalide ou sans piste vidéo.':'La vidéo dépasse 2 minutes.'});
    }
    const file=crypto.randomBytes(12).toString('hex')+'.mp4';
    await s3.send(new PutObjectCommand({Bucket:BUCKET,Key:file,Body:bytes,ContentType:'video/mp4'}));
    await s3.send(new DeleteObjectCommand({Bucket:BUCKET,Key:key})).catch(()=>{});
    S.videoUploads=S.videoUploads||{};S.videoUploads[vid]=S.videoUploads[vid]||{};
    if(S.videoUploads[vid][slot])unlinkVideo(S.videoUploads[vid][slot].file);
    const old=S.entrants[vid]&&S.entrants[vid].videos&&S.entrants[vid].videos[slot-1];
    if(old&&old.file&&(!S.videoUploads[vid][slot]||old.file!==S.videoUploads[vid][slot].file))unlinkVideo(old.file);
    S.videoUploads[vid][slot]={file,size,duration};await save();
    return sendJson(res,200,{ok:true,file,duration});
  } catch(e){console.error('Finalisation vidéo:',e);if(!res.headersSent)return sendJson(res,502,{error:'Finalisation impossible. Réessaie sans renvoyer les blocs déjà reçus.'});}
}

function handleVideoUpload(req, res, slot) {
  const vid = voterId(req);
  if (!vid) return sendJson(res, 401, { error: "Entre ton code d'invitation d'abord." });
  if (!S.t || S.t.status !== 'inscription') return sendJson(res, 409, { error: 'Les inscriptions sont fermées.' });
  const key = 'video:' + vid;
  if (tooMany(key)) return sendJson(res, 429, { error: 'Trop d’envois. Réessaie dans quelques minutes.' });
  hit(key);
  const len = Number(req.headers['content-length']);
  if (!len) return sendJson(res, 411, { error: 'Taille du fichier inconnue.' });
  if (len > MAX_VIDEO) { req.on('end', () => sendJson(res, 413, { error: 'Vidéo trop volumineuse : ' + Math.round(MAX_VIDEO / 1048576) + ' Mo maximum.' })); return req.resume(); }
  const tmp = path.join(os.tmpdir(), 'arene-video-' + crypto.randomBytes(8).toString('hex'));
  let size = 0;
  const meter = new Transform({ transform(chunk, enc, cb) { size += chunk.length; if (size > MAX_VIDEO) return cb(new HttpError(413, 'Vidéo trop volumineuse.')); cb(null, chunk); } });
  pipeline(req, meter, fs.createWriteStream(tmp), async err => {
    if (err) { fs.unlink(tmp, () => {}); if (res.headersSent) return; return err instanceof HttpError ? sendJson(res, err.status, { error: err.message }) : sendJson(res, 400, { error: 'Envoi interrompu.' }); }
    try {
      const bytes = await fs.promises.readFile(tmp), duration = inspectMp4Video(bytes);
      if (!duration || size < 2048) return sendJson(res, 415, { error: 'Fichier MP4/MOV invalide ou sans piste vidéo.' });
      if (duration > MAX_VIDEO_SECONDS + 0.05) return sendJson(res, 400, { error: 'La vidéo dépasse 2 minutes (' + Math.ceil(duration) + ' secondes).' });
      const file = crypto.randomBytes(12).toString('hex') + '.mp4';
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: file, Body: bytes, ContentType: 'video/mp4' }));
      S.videoUploads = S.videoUploads || {}; S.videoUploads[vid] = S.videoUploads[vid] || {};
      if (S.videoUploads[vid][slot]) unlinkVideo(S.videoUploads[vid][slot].file);
      const oldEntryVideo = S.entrants[vid] && S.entrants[vid].videos && S.entrants[vid].videos[slot - 1];
      if (oldEntryVideo && oldEntryVideo.file && (!S.videoUploads[vid][slot] || oldEntryVideo.file !== S.videoUploads[vid][slot].file)) unlinkVideo(oldEntryVideo.file);
      S.videoUploads[vid][slot] = { file, size, duration }; await save();
      sendJson(res, 200, { ok: true, file, duration });
    } catch (e) { console.error('Enregistrement vidéo:', e); if (!res.headersSent) sendJson(res, 500, { error: 'Impossible d’enregistrer la vidéo.' }); }
    finally { fs.unlink(tmp, () => {}); }
  });
}
// Le fichier arrive tel quel dans le corps de la requête (pas de formulaire multipart).
function handleUpload(req, res) {
  const vid = voterId(req);
  if (!vid) return sendJson(res, 401, { error: 'Entre ton code d\'invitation d\'abord.' });
  if (!S.t || S.t.status !== 'inscription') return sendJson(res, 409, { error: 'Les inscriptions sont fermées.' });
  const key = 'up:' + vid;
  if (tooMany(key)) return sendJson(res, 429, { error: 'Trop d\'envois. Réessaie dans quelques minutes.' });
  hit(key);
  const len = Number(req.headers['content-length']);
  if (!len) return sendJson(res, 411, { error: 'Taille du fichier inconnue.' });
  if (len > MAX_AUDIO) {
    if (len > MAX_AUDIO * 4) { res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' }); res.end(JSON.stringify({ error: 'Fichier trop gros.' })); return req.destroy(); }
    req.on('end', () => sendJson(res, 413, { error: 'Fichier trop gros : ' + Math.round(MAX_AUDIO / 1048576) + ' Mo maximum.' }));
    return req.resume();
  }
  const tmp = path.join(os.tmpdir(), 'arene-' + crypto.randomBytes(8).toString('hex'));
  let size = 0, head = Buffer.alloc(0);
  const meter = new Transform({
    transform(chunk, enc, cb) {
      size += chunk.length;
      if (size > MAX_AUDIO) return cb(new HttpError(413, 'Fichier trop gros : ' + Math.round(MAX_AUDIO / 1048576) + ' Mo maximum.'));
      if (head.length < 16) head = Buffer.concat([head, chunk]).subarray(0, 16);
      cb(null, chunk);
    }
  });
  pipeline(req, meter, fs.createWriteStream(tmp), async (err) => {
    if (err) {
      fs.unlink(tmp, () => {});
      if (res.headersSent) return;
      return err instanceof HttpError ? sendJson(res, err.status, { error: err.message }) : sendJson(res, 400, { error: 'Envoi interrompu.' });
    }
    const ext = sniffAudio(head);
    if (!ext || size < 1024) {
      fs.unlink(tmp, () => {});
      return sendJson(res, 415, { error: 'Ce fichier n\'est pas un audio reconnu. Formats acceptés : mp3, m4a, ogg/opus, wav, aac, flac.' });
    }
    const file = crypto.randomBytes(12).toString('hex') + '.' + ext;
    try {
      const bytes = await fs.promises.readFile(tmp);
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: file, Body: bytes, ContentType: AUDIO_TYPES[ext] }));
      if (S.uploads[vid]) unlinkAudio(S.uploads[vid].file);
      S.uploads[vid] = { file: file, size: size }; await save();
    } catch (e) { console.error(e); return sendJson(res, 500, { error: 'Impossible d\'enregistrer le fichier.' }); }
    finally { fs.unlink(tmp, () => {}); }
    sendJson(res, 200, { ok: true, file: file });
  });
}
async function serveVideo(req,res,file,adminStream=false){
 try {
  const range=String(req.headers.range||'');
  const obj=await s3.send(new GetObjectCommand({Bucket:BUCKET,Key:file,...(range?{Range:range}:{})}));
  const h=Object.assign({'Content-Type':'video/mp4','Accept-Ranges':'bytes','Cache-Control':'public, max-age=86400, immutable'},SEC);
  if(obj.ContentLength!=null)h['Content-Length']=obj.ContentLength;
  if(obj.ContentRange)h['Content-Range']=obj.ContentRange;
  res.writeHead(obj.ContentRange?206:200,h);
  if(req.method==='HEAD'){if(obj.Body&&obj.Body.destroy)obj.Body.destroy();return res.end();}
  if(obj.Body&&obj.Body.pipe){
   if(adminStream){
    pipeline(obj.Body,res,(err)=>{if(err)console.error('Flux vidéo administration interrompu:',err.message);});
   } else obj.Body.pipe(res);
  } else res.end(Buffer.from(await obj.Body.transformToByteArray()));
 } catch(e){
  if(e.name==='NoSuchKey'||(e.$metadata&&e.$metadata.httpStatusCode===404)){res.writeHead(404,SEC);return res.end('Introuvable');}
  console.error(adminStream?'Lecture vidéo administration:':'Lecture vidéo:',e);
  if(!res.headersSent){res.writeHead(502,SEC);res.end('Vidéo indisponible');}
  else if(adminStream&&!res.destroyed)res.destroy(e);
 }
}
async function serveAudio(req,res,file){
 try{const range=String(req.headers.range||'');const obj=await s3.send(new GetObjectCommand({Bucket:BUCKET,Key:file,...(range?{Range:range}:{})}));
 const h=Object.assign({'Content-Type':obj.ContentType||AUDIO_TYPES[path.extname(file).slice(1)]||'application/octet-stream','Accept-Ranges':'bytes','Cache-Control':'public, max-age=86400, immutable'},SEC);
 if(obj.ContentLength!=null)h['Content-Length']=obj.ContentLength;if(obj.ContentRange)h['Content-Range']=obj.ContentRange;res.writeHead(obj.ContentRange?206:200,h);
 if(req.method==='HEAD'){if(obj.Body&&obj.Body.destroy)obj.Body.destroy();return res.end();}
 if(obj.Body&&obj.Body.pipe)obj.Body.pipe(res);else res.end(Buffer.from(await obj.Body.transformToByteArray()));
 }catch(e){if(e.name==='NoSuchKey'||(e.$metadata&&e.$metadata.httpStatusCode===404)){res.writeHead(404,SEC);return res.end('Introuvable');}console.error('Lecture audio:',e);if(!res.headersSent){res.writeHead(502,SEC);res.end('Audio indisponible');}}
}

async function adminVideoList() {
  const items = new Map();
  const add = (vid, v, source) => {
    if (!v || !/^[a-f0-9]{24}\.mp4$/.test(String(v.file || ''))) return;
    const code = codeOf(vid), entrant = S.entrants[vid] || {};
    const old = items.get(v.file) || { file:v.file, playerName:code && code.name || entrant.name || 'Participant', title:v.title || '', anime:v.anime || '', order:v.order || null, size:Number(v.size || 0), duration:Number(v.duration || 0), sources:[] };
    if (v.title) old.title=v.title; if (v.anime) old.anime=v.anime; if (v.order) old.order=v.order;
    if (v.size) old.size=Number(v.size); if (v.duration) old.duration=Number(v.duration);
    if (!old.sources.includes(source)) old.sources.push(source);
    items.set(v.file,old);
  };
  for (const [vid,group] of Object.entries(S.videoUploads || {})) for (const [slot,v] of Object.entries(group || {})) add(vid,v,'Dépôt '+slot);
  for (const [vid,e] of Object.entries(S.entrants || {})) (e.videos || []).forEach((v,i)=>add(vid,v,'Vidéo de tournoi '+(i+1)));
  for (const m of Object.values(S.matches || {})) [m.a,m.b].forEach(side=>{
    if (!side) return;
    const pair=S.pairings[m.id], vid=pair && (side.slot===m.a.slot?pair.aUid:pair.bUid);
    (side.videos || []).forEach((v,i)=>add(vid,v,'Affrontement '+m.id+' · vidéo '+(i+1)));
  });
  const list = Array.from(items.values());
  await Promise.all(list.map(async (item) => {
    if (item.size > 0) return;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: item.file }));
      item.size = Number(head.ContentLength || 0);
    } catch (e) { /* fichier éventuellement absent : garder une taille inconnue */ }
  }));
  return list.sort((x,y)=>x.playerName.localeCompare(y.playerName,'fr'));
}
const routes = {
  'POST /api/redeem': (req, res, body) => {
    const ip = 'code:' + clientIp(req);
    if (tooMany(ip)) fail(429, 'Trop d\'essais. Réessaie dans quelques minutes.');
    const code = normCode(body.code);
    const c = S.codes.find((x) => x.code === code);
    if (!c) { hit(ip); fail(401, 'Code inconnu. Vérifie-le ou demande-en un à l\'organisateur.'); }
    if (!c.name) {
      const name = cleanName(body.name);
      if (name.length < 2) fail(400, 'Choisis un pseudo de 2 caractères au minimum.');
      if (nameTaken(name)) fail(409, 'Ce pseudo est déjà pris, choisis-en un autre.');
      c.name = name;
    }
    if (!c.usedAt) c.usedAt = Date.now();
    save();
    setCookie(req, res, 'v', mk(c.id), 90 * 24 * 3600);
    return { ok: true };
  },
  'POST /api/mobile-money': (req, res, body) => {
    const vid = voterId(req);
    if (!vid) fail(401, 'Connecte-toi avec ton code d\'invitation.');
    const provider = String(body.provider || '');
    if (!['MTN', 'ORANGE'].includes(provider)) fail(400, 'Choisis MTN Mobile Money ou Orange Money.');
    const number = String(body.number || '').replace(/[ .()-]/g, '');
    if (!/^\+?[0-9]{8,15}$/.test(number)) fail(400, 'Entre un numéro valide (8 à 15 chiffres, indicatif accepté).');
    const c = codeOf(vid);
    c.mobileMoney = { provider, number, updatedAt: Date.now() };
    save();
    return { ok: true };
  },
  'POST /api/prize/confirm': (req, res, body) => {
    const vid = voterId(req);
    if (!vid) fail(401, 'Connecte-toi avec ton code d\'invitation.');
    const payout = S.t && Array.isArray(S.t.prizePayouts) ? S.t.prizePayouts.find((p) => p.playerId === vid) : null;
    if (!payout || payout.status !== 'envoye') fail(409, 'Aucun paiement à confirmer.');
    if (body.received !== true && body.received !== false) fail(400, 'Réponse invalide.');
    payout.status = body.received ? 'recu' : 'non_recu';
    payout.playerConfirmedAt = Date.now();
    payout.playerNote = clean(body.note, 200);
    logIt((body.received ? 'Réception confirmée' : 'Paiement signalé non reçu') + ' par ' + payout.playerName + ' pour la récompense de ' + payout.amount + ' FCFA.');
    save();
    return { ok: true };
  },
  'POST /api/name': (req, res, body) => {
    const vid = voterId(req);
    if (!vid) fail(401, 'Entre ton code d\'invitation d\'abord.');
    const c = codeOf(vid);
    if (c.name) fail(409, 'Ton pseudo est déjà choisi.');
    const name = cleanName(body.name);
    if (name.length < 2) fail(400, 'Choisis un pseudo de 2 caractères au minimum.');
    if (nameTaken(name)) fail(409, 'Ce pseudo est déjà pris, choisis-en un autre.');
    c.name = name;
    save();
    return { ok: true };
  },
  'POST /api/logout': (req, res) => { setCookie(req, res, 'v', '', 0); return { ok: true }; },
  'GET /api/state': (req) => publicState(voterId(req)),
  'POST /api/notifications/read': (req) => {const vid=voterId(req);if(!vid)fail(401,'Connecte-toi avec ton code joueur.');(S.notifications&&S.notifications[vid]||[]).forEach(n=>n.read=true);save();return {ok:true};},
  'GET /api/community': async (req) => { const u = new URL(req.url, 'http://x'); const id = String(u.searchParams.get('player') || ''); if (id && !/^[a-f0-9]{16}$/.test(id)) fail(400, 'Profil invalide.'); return communityData(id || null, voterId(req)); },
  'POST /api/community/favorite': (req, res, body) => {
    const vid = voterId(req);
    if (!vid || !codeOf(vid).name) fail(401, 'Connecte-toi avec ton code joueur pour suivre un profil.');
    const target = String(body.playerId || '');
    if (!/^[a-f0-9]{16}$/.test(target) || !S.codes.some((c) => c.id === target && c.name)) fail(404, 'Joueur introuvable.');
    if (!S.community) S.community = { comments: [], favorites: {} };
    if (!S.community.favorites) S.community.favorites = {};
    const list = Array.isArray(S.community.favorites[target]) ? S.community.favorites[target] : [];
    const index = list.indexOf(vid);
    if (index >= 0) list.splice(index, 1); else if (target !== vid) list.push(vid);
    S.community.favorites[target] = list;
    save();
    return { ok: true, favorited: list.includes(vid), count: list.length };
  },
  'POST /api/community/comment/like': (req, res, body) => {
    const vid = voterId(req);
    if (!vid || !codeOf(vid).name) fail(401, 'Connecte-toi avec ton code joueur pour aimer un commentaire.');
    if (!S.community || !Array.isArray(S.community.comments)) fail(404, 'Commentaire introuvable.');
    const id = String(body.commentId || '');
    const comment = S.community.comments.find((c) => c.id === id);
    if (!comment) fail(404, 'Commentaire introuvable.');
    if (!Array.isArray(comment.likes)) comment.likes = [];
    const index = comment.likes.indexOf(vid);
    if (index >= 0) comment.likes.splice(index, 1);
    else comment.likes.push(vid);
    save();
    return { ok: true, liked: comment.likes.includes(vid), count: comment.likes.length };
  },
  'POST /api/community/comment': (req, res, body) => {
    const vid = voterId(req);
    if (!vid || !codeOf(vid).name) fail(401, 'Connecte-toi avec ton code joueur pour commenter.');
    const target = String(body.playerId || '');
    if (!/^[a-f0-9]{16}$/.test(target) || !S.codes.some((c) => c.id === target && c.name)) fail(404, 'Joueur introuvable.');
    const message = clean(body.message, 500);
    if (message.length < 2) fail(400, 'Ton commentaire doit contenir au moins 2 caractères.');
    if (!S.community) S.community = { comments: [], favorites: {} };
    if (!Array.isArray(S.community.comments)) S.community.comments = [];
    const recent = S.community.comments.filter((c) => c.authorId === vid && Date.now() - Number(c.createdAt || 0) < 10 * 60 * 1000).length;
    if (recent >= 5) fail(429, 'Tu as déjà publié 5 commentaires. Réessaie dans quelques minutes.');
    S.community.comments.push({ id: crypto.randomBytes(8).toString('hex'), playerId: target, authorId: vid, authorName: codeOf(vid).name, message, createdAt: Date.now() });
    if (S.community.comments.length > 2000) S.community.comments.splice(0, S.community.comments.length - 2000);
    save();
    return { ok: true };
  },
  'POST /api/community/comment/delete': (req, res, body) => {
    const vid = voterId(req), id = String(body.commentId || '');
    if (!vid && !isAdmin(req)) fail(401, 'Connecte-toi pour effectuer cette action.');
    if (!S.community || !Array.isArray(S.community.comments)) fail(404, 'Commentaire introuvable.');
    const index = S.community.comments.findIndex((c) => c.id === id);
    if (index < 0) fail(404, 'Commentaire introuvable.');
    if (!isAdmin(req) && S.community.comments[index].authorId !== vid) fail(403, 'Tu peux uniquement supprimer tes propres commentaires.');
    S.community.comments.splice(index, 1);
    save();
    return { ok: true };
  },

  'POST /api/entry': (req, res, body) => {
    const vid = voterId(req);
    if (!vid) fail(401, 'Entre ton code d\'invitation d\'abord.');
    needTournament('inscription');
    const name = clean(body.name, 40);
    if (!name) fail(400, 'Indique ton pseudo.');
    if (S.t.mediaMode === 'video3') {
      const submitted = Array.isArray(body.videos) ? body.videos : [];
      if (submitted.length !== 3) fail(400, 'Renseigne les informations des 3 vidéos.');
      const old = S.entrants[vid] && Array.isArray(S.entrants[vid].videos) ? S.entrants[vid].videos : [];
      const uploaded = (S.videoUploads && S.videoUploads[vid]) || {};
      const videos = submitted.map((v, i) => {
        const title = clean(v && v.title, 80), anime = clean(v && v.anime, 60), order = Number(v && v.order);
        const up = uploaded[i + 1] || old[i];
        if (!title || !anime) fail(400, 'Complète le titre et l’anime des 3 vidéos.');
        if (!up || !up.file) fail(400, 'Envoie les 3 vidéos avant de valider.');
        if (![1,2,3].includes(order)) fail(400, 'Choisis l’ordre de passage des 3 vidéos (1, 2 et 3).');
        return { title, anime, file: up.file, size: Number(up.size || 0), duration: Number(up.duration || 0), order };
      });
      if (new Set(videos.map(v => v.order)).size !== 3) fail(400, 'Chaque vidéo doit avoir un ordre de passage différent (1, 2 et 3).');
      const firstVideo = videos.find(v => v.order === 1) || videos[0];
      S.entrants[vid] = { name, title: firstVideo.title, anime: firstVideo.anime, videos };
      delete S.videoUploads[vid];
      save();
      return { ok: true };
    }
    const anime = clean(body.anime, 60), title = clean(body.title, 80);
    const rawLink = clean(body.link, 300), link = rawLink ? safeUrl(rawLink) : null;
    if (!anime || !title) fail(400, 'Remplis le pseudo, l\'anime et le titre.');
    if (rawLink && !link) fail(400, 'Le lien doit commencer par https://');
    let audio = (S.entrants[vid] && S.entrants[vid].audio) || null;
    const up = S.uploads[vid];
    if (up) { if (audio && audio.file !== up.file) unlinkAudio(audio.file); audio = up; delete S.uploads[vid]; }
    if (!audio && !link) fail(400, 'Envoie un fichier audio ou colle un lien.');
    S.entrants[vid] = { name, anime, title, link, audio };
    save();
    return { ok: true };
  },
  'POST /api/reaction': (req, res, body) => {
    const vid=voterId(req);
    if(!vid||!codeOf(vid).name) fail(401,'Connecte-toi avec ton code joueur pour réagir.');
    const m=S.matches[String(body.matchId)];
    if(!m||m.bye||!m.b) fail(404,'Duel introuvable.');
    const slot=String(body.slot||'');
    if(slot!==m.a.slot&&slot!==m.b.slot) fail(400,'Opening invalide.');
    const encounter=m.encounters?Number(body.encounter):1;
    if(!Number.isInteger(encounter)||encounter<1||encounter>(m.encounters?3:1)) fail(400,'Affrontement invalide.');
    const type=String(body.type||''),allowed=['love','fire','laugh','wow','clap'];
    if(!allowed.includes(type)) fail(400,'Réaction invalide.');
    if(!S.reactions) S.reactions={};
    const key=m.id+':e'+encounter;
    if(!S.reactions[key]) S.reactions[key]={};
    const reactionId=vid+':'+slot;
    const current=S.reactions[key][reactionId]||((S.reactions[key][vid]||{}).slot===slot?S.reactions[key][vid]:null);
    if(current&&current.type===type){delete S.reactions[key][reactionId];if(S.reactions[key][vid]&&S.reactions[key][vid].slot===slot)delete S.reactions[key][vid];}
    else {S.reactions[key][reactionId]={slot,type};if(S.reactions[key][vid]&&S.reactions[key][vid].slot===slot)delete S.reactions[key][vid];}
    save();
    const entries=Object.values(S.reactions[key]).filter(x=>x&&x.slot===slot);
    const mine=S.reactions[key][reactionId]||null;
    return {ok:true,mine:mine?mine.type:null,total:entries.length};
  },
  'POST /api/vote': (req, res, body) => {
    const vid = voterId(req);
    if (!vid) fail(401, 'Entre ton code d\'invitation pour voter.');
    if (!codeOf(vid).name) fail(403, 'Choisis d\'abord ton pseudo.');
    const m = S.matches[String(body.matchId)];
    if (!m || m.bye) fail(404, 'Duel introuvable.');
    if (m.status !== 'ouvert' || Date.now() >= m.closesAt) fail(409, 'Le vote de ce duel est fermé.');
    if (body.slot !== m.a.slot && body.slot !== m.b.slot) fail(400, 'Choix invalide.');
    const p = S.pairings[m.id];
    if (vid === p.aUid || vid === p.bUid) fail(403, 'Tu ne votes pas dans ton propre duel.');
    const voteKey = m.encounters ? m.id + ':e' + m.currentEncounter : m.id;
    S.votes[vid] = S.votes[vid] || {};
    S.votes[vid][voteKey] = body.slot;
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
  'GET /api/admin/storage': async () => ({ archives: await archivedStorage() }),
  'GET /api/admin/health': async () => {
    const checkedAt = Date.now();
    const result = {
      checkedAt,
      server: { status: 'ok', uptimeSeconds: Math.floor(process.uptime()), node: process.version, memoryRssBytes: process.memoryUsage().rss, memoryHeapUsedBytes: process.memoryUsage().heapUsed },
      database: { status: 'error', latencyMs: null },
      objectStorage: { status: 'error', latencyMs: null, bucket: BUCKET },
      media: { activeVideoBytes: 0, archivedMediaBytes: 0 }
    };
    const dbStart = Date.now();
    try {
      await pool.query('SELECT 1');
      result.database = { status: 'ok', latencyMs: Date.now() - dbStart };
    } catch (e) {
      result.database.error = 'Connexion à la base de données indisponible.';
      console.error('Diagnostic base de données:', e.message);
    }
    const storageStart = Date.now();
    try {
      await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
      result.objectStorage = { status: 'ok', latencyMs: Date.now() - storageStart };
    } catch (e) {
      result.objectStorage = { status: 'error', latencyMs: Date.now() - storageStart, error: 'Accès au bucket de stockage indisponible.' };
      console.error('Diagnostic stockage objet:', e.message);
    }
    try {
      const videos = await adminVideoList();
      result.media.activeVideoBytes = videos.reduce((n, v) => n + Number(v.size || 0), 0);
      const archives = await archivedStorage();
      result.media.archivedMediaBytes = archives.reduce((n, a) => n + Number(a.bytes || 0), 0);
    } catch (e) {
      result.media.status = 'partial';
      console.error('Diagnostic volume médias:', e.message);
    }
    return result;
  },
  'POST /api/admin/storage/cleanup': async (req, res, body) => {
    const id = Number(body.archiveId);
    if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Archive invalide.');
    if (body.confirm !== 'SUPPRIMER MÉDIAS' && body.confirm !== 'SUPPRIMER AUDIO') fail(400, 'Confirmation incorrecte.');
    const q = await pool.query('SELECT id, state FROM tournament_archives WHERE id=$1', [id]);
    if (!q.rows.length) fail(404, 'Archive introuvable.');
    const state = q.rows[0].state;
    const all = await pool.query('SELECT id, state FROM tournament_archives');
    const candidates = new Set(audioKeys(state));
    const shared = new Set(audioKeys(S));
    all.rows.forEach((r) => { if (r.id !== id) audioKeys(r.state).forEach((k) => shared.add(k)); });
    const deletable = new Set(Array.from(candidates).filter((k) => !shared.has(k)));
    const pending = Array.isArray(state.audioCleanupPending) ? state.audioCleanupPending : [];
    pending.forEach((k) => { if (/^[a-f0-9]{24}\.(?:mp3|m4a|ogg|wav|webm|flac|aac|mp4)$/.test(k)) deletable.add(k); });
    clearAudioRefs(state, deletable);
    state.audioCleanupPending = Array.from(deletable);
    await pool.query('UPDATE tournament_archives SET state=$1::jsonb WHERE id=$2', [JSON.stringify(state), id]);
    archiveRowsCache=null;
    let deleted = 0, failed = [];
    for (const k of deletable) {
      try { await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: k })); deleted++; }
      catch (e) { failed.push(k); console.error('Suppression audio archive:', e.message); }
    }
    state.audioCleanupPending = failed;
    await pool.query('UPDATE tournament_archives SET state=$1::jsonb WHERE id=$2', [JSON.stringify(state), id]);
    archiveRowsCache=null;
    logIt('Nettoyage des médias de l’archive #' + id + ' : ' + deleted + ' fichier(s) supprimé(s)' + (failed.length ? ', ' + failed.length + ' à réessayer' : '') + '.');
    save();
    return { ok: true, deleted, pending: failed.length };
  },
  'GET /api/admin/state': async () => {
    const st = publicState(null);
    st.admin = true;
    st.codes = S.codes.map((c) => ({ code: fmtCode(c.code), used: !!c.usedAt, name: c.name || null }));
    st.entrantCount = Object.keys(S.entrants).length;
    st.moderationVideos = await adminVideoList();
    st.stats.videoCount = st.moderationVideos.length;
    st.stats.videoBytes = st.moderationVideos.reduce((total, video) => total + Number(video.size || 0), 0);
    st.players = S.codes.filter((c) => c.name).map((c) => ({ id: c.id, name: c.name, mobileMoney: c.mobileMoney || null }));
    st.prizeConfig = S.t && S.t.prizeConfig || { enabled: false, amounts: { first: 0, second: 0, third: 0 } };
    st.prizePayouts = S.t && Array.isArray(S.t.prizePayouts) ? S.t.prizePayouts : [];
    st.bonuses = Array.isArray(S.bonuses) ? S.bonuses : [];
    return st;
  },
  'POST /api/admin/video/delete': async (req, res, body) => {
    const file=String(body.file || ''), reason=clean(body.reason,200);
    if (!/^[a-f0-9]{24}\.mp4$/.test(file)) fail(400,'Vidéo invalide.');
    if (body.confirm !== 'SUPPRIMER VIDEO') fail(400,'Confirmation incorrecte.');
    if (reason.length<3) fail(400,'Indique le motif de suppression.');
    if (!(await adminVideoList()).some(v=>v.file===file)) fail(404,'Cette vidéo n’est plus disponible.');
    await s3.send(new DeleteObjectCommand({Bucket:BUCKET,Key:file}));
    const keys=new Set([file]);
    clearAudioRefs(S,keys);
    const archives=await getArchiveRows();
    for (const row of archives) {
      const state=row.state; clearAudioRefs(state,keys);
      await pool.query('UPDATE tournament_archives SET state=$1::jsonb WHERE id=$2',[JSON.stringify(state),row.id]);
    }
    archiveRowsCache=null;
    logIt('Vidéo supprimée par modération : '+reason+'. Fichier '+file+'.');
    await save();
    return {ok:true};
  },
  'POST /api/admin/create': (req, res, body) => {
    if (S.t) fail(409, 'Un tournoi existe déjà. Utilise « Nouveau tournoi ».');
    const name = clean(body.name, 60);
    if (!name) fail(400, 'Donne un nom au tournoi.');
    S.t = { name: name, mediaMode: 'video3', status: 'inscription', round: 0, createdAt: Date.now(), prizeConfig: { enabled: false, amounts: { first: 0, second: 0, third: 0 } } };
    logIt('Tournoi créé : ' + name + '. Inscriptions ouvertes.');
    save();
    return { ok: true };
  },
  'POST /api/admin/countdown': (req, res, body) => {
    needTournament('inscription');
    if (body.startAt === null || body.startAt === '') {
      S.t.startAt = null;
      logIt('Compte à rebours désactivé par l’organisateur.');
      save();
      return { ok: true, startAt: null };
    }
    const raw = String(body.startAt || '');
    const timestamp = Date.parse(raw);
    if (!Number.isFinite(timestamp)) fail(400, 'Date et heure invalides.');
    if (timestamp <= Date.now()) fail(400, 'Choisis une date et une heure dans le futur.');
    if (timestamp > Date.now() + 366 * 24 * 60 * 60 * 1000) fail(400, 'La date ne peut pas dépasser un an.');
    S.t.startAt = timestamp;
    logIt('Compte à rebours programmé pour le ' + frDate(timestamp) + '.');
    save();
    return { ok: true, startAt: timestamp };
  },
  'POST /api/admin/prize-config': (req, res, body) => {
    needTournament('inscription');
    const enabled = body.enabled === true;
    const amounts = { first: Number(body.first), second: Number(body.second), third: Number(body.third) };
    for (const [place, amount] of Object.entries(amounts)) {
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > 100000000) fail(400, 'Chaque récompense doit être un montant entier positif en FCFA.');
    }
    if (enabled && amounts.first <= 0) fail(400, 'Indique une récompense pour la 1re place.');
    if (enabled && amounts.second > 0 && amounts.first <= amounts.second) fail(400, 'La récompense de la 1re place doit être supérieure à celle de la 2e.');
    if (!enabled) amounts.first = amounts.second = amounts.third = 0;
    S.t.prizeConfig = { enabled, amounts };
    logIt(enabled ? 'Récompenses annoncées : 1re place ' + amounts.first + ', 2e place ' + amounts.second + ', 3e place ' + amounts.third + ' FCFA.' : 'Aucune récompense financière pour ce tournoi.');
    save();
    return { ok: true };
  },
  'POST /api/admin/prize-payment': (req, res, body) => {
    const playerId = String(body.playerId || '');
    const payout = S.t && Array.isArray(S.t.prizePayouts) ? S.t.prizePayouts.find((p) => p.playerId === playerId) : null;
    if (!payout) fail(404, 'Récompense introuvable.');
    const method = String(body.method || '');
    if (!['MTN', 'ORANGE'].includes(method)) fail(400, 'Choisis le moyen de paiement.');
    if (!['a_payer', 'non_recu'].includes(payout.status)) fail(409, 'Ce paiement ne peut pas être marqué comme envoyé.');
    payout.method = method;
    payout.status = 'envoye';
    payout.sentAt = Date.now();
    payout.reference = clean(body.reference, 80);
    notifyPlayer(playerId,'Récompense envoyée','Ton paiement de '+payout.amount+' FCFA a été envoyé via '+(method==='MTN'?'MTN Mobile Money':'Orange Money')+'. Confirme sa réception dans ton espace.','prize');
    logIt('Récompense envoyée à ' + payout.playerName + ' (' + payout.amount + ' FCFA) via ' + (method === 'MTN' ? 'MTN Mobile Money' : 'Orange Money') + '. En attente de confirmation.');
    save();
    return { ok: true };
  },
  'POST /api/admin/notification': (req,res,body) => {const title=clean(body.title,80),message=clean(body.message,300),target=String(body.playerId||'all');if(title.length<3||message.length<3)fail(400,'Indique un titre et un message de 3 caractères minimum.');if(target==='all')notifyAllPlayers(title,message,'announcement');else{const p=S.codes.find(c=>c.id===target&&c.name);if(!p)fail(404,'Participant introuvable.');notifyPlayer(p.id,title,message,'announcement');}logIt('Notification envoyée : '+title+'.');save();return {ok:true};},
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
    let pend = currentMatches().filter((m) => m.status === 'attente');
    if (body.matchId) pend = pend.filter((m) => m.id === String(body.matchId));
    if (!pend.length) fail(409, 'Aucun duel à ouvrir.');
    const live = body.live === true;
    const now = Date.now(), end = now + VOTE_MINUTES * 60000;
    pend.forEach((m) => { m.status = 'ouvert'; m.opensAt = now; m.closesAt = end; m.live = live; m.extensions = 0; if (m.encounters) m.encounters[m.currentEncounter - 1].status = 'ouvert'; });
    const what = pend.length === 1 ? 'le duel ' + pend[0].idx + (pend[0].encounters ? ', affrontement ' + pend[0].currentEncounter + '/3' : '') : pend.length + ' duels';
    logIt('Tour ' + S.t.round + ' : vote ouvert pour ' + what + ', ' + durLabel(VOTE_MINUTES) + ', fin à ' + frDate(end) +
      '. Score en direct : ' + (live ? 'affiché' : 'caché jusqu\'à la clôture') + '. Égalité : +' + durLabel(EXTEND_MINUTES) + ' automatiques.');
    save();
    return { ok: true };
  },
  'POST /api/admin/bonus': (req, res, body) => {
    const playerId = String(body.playerId || '');
    const player = S.codes.find((c) => c.id === playerId && c.name);
    if (!player) fail(400, 'Choisis un participant valide.');
    const points = Number(body.points);
    if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 1000) fail(400, 'Le bonus doit être un nombre entier entre -1000 et 1000, différent de zéro.');
    const reason = clean(body.reason, 200);
    if (reason.length < 3) fail(400, 'Indique une raison de 3 caractères minimum.');
    S.bonuses = Array.isArray(S.bonuses) ? S.bonuses : [];
    const record = { id: crypto.randomBytes(8).toString('hex'), playerId, playerName: player.name, points, reason, tournamentKey: tournamentKey(S), tournamentName: S.t ? S.t.name : 'Hors saison', at: Date.now() };
    S.bonuses.push(record);
    logIt('Bonus administrateur : ' + (points > 0 ? '+' : '') + points + ' point' + (Math.abs(points) > 1 ? 's' : '') + ' pour ' + player.name + ' — ' + reason + '.');
    save();
    return { ok: true };
  },
  'POST /api/admin/next': () => {
    needTournament('en_cours');
    const cur = currentMatches();
    if (!cur.length || !cur.every((m) => m.status === 'clos')) fail(409, 'Tous les duels du tour doivent être terminés.');
    const winners = cur.map((m) => (m.winnerSlot === m.a.slot ? S.pairings[m.id].aUid : S.pairings[m.id].bUid));
    const next = S.t.round + 1;
    const finalize = (championId, runnerId, thirdId) => {
      const c = S.entrants[championId];
      S.t.status = 'termine';
      S.t.championId = championId;
      S.t.runnerUpId = runnerId || null;
      S.t.thirdPlaceId = thirdId || null;
      S.t.champion = { name: c.name, title: c.title, anime: c.anime, link: c.link };
      notifyPlayer(championId,'Félicitations !','Tu remportes le tournoi « '+S.t.name+' ».','success');
      if(runnerId)notifyPlayer(runnerId,'Résultat du tournoi','Tu termines à la 2e place du tournoi « '+S.t.name+' ».','result');
      if(thirdId)notifyPlayer(thirdId,'Résultat du tournoi','Tu termines à la 3e place du tournoi « '+S.t.name+' ».','result');
      notifyAllPlayers('Tournoi terminé','Le tournoi « '+S.t.name+' » est terminé. Consulte les résultats sur la plateforme.','result');
      createPrizePayouts();
      logIt('Tournoi terminé. Vainqueur : ' + c.name + '.');
    };
    if (S.t.thirdPlaceRound && S.t.round === S.t.thirdPlaceRound) {
      const finalMatch = matchList().find((m) => m.round === S.t.roundsTotal && m.status === 'clos' && !m.bye && m.winnerSlot);
      const finalPair = finalMatch && S.pairings[finalMatch.id];
      if (!finalMatch || !finalPair) fail(409, 'La finale doit être terminée avant de clôturer le tournoi.');
      const championId = finalMatch.winnerSlot === finalMatch.a.slot ? finalPair.aUid : finalPair.bUid;
      const runnerId = finalMatch.winnerSlot === finalMatch.a.slot ? finalPair.bUid : finalPair.aUid;
      const thirdMatch = cur.find((m) => m.status === 'clos' && !m.bye && m.winnerSlot);
      const tp = thirdMatch && S.pairings[thirdMatch.id];
      const thirdId = tp ? (thirdMatch.winnerSlot === thirdMatch.a.slot ? tp.aUid : tp.bUid) : null;
      finalize(championId, runnerId, thirdId);
    } else if (winners.length === 1 && S.t.thirdPlacePlayers && S.t.thirdPlacePlayers.length === 2) {
      createRound(next, S.t.thirdPlacePlayers);
      S.t.thirdPlaceRound = next;
      S.t.round = next;
      logIt('Finale terminée. Duel spécial lancé entre les deux perdants des demi-finales pour déterminer la 3e place.');
    } else if (winners.length === 1) {
      const finalMatch = cur[0], pair = S.pairings[finalMatch.id];
      const championId = finalMatch.winnerSlot === finalMatch.a.slot ? pair.aUid : pair.bUid;
      const runnerId = finalMatch.winnerSlot === finalMatch.a.slot ? pair.bUid : pair.aUid;
      finalize(championId, runnerId, null);
    } else {
      if (S.t.round === S.t.roundsTotal - 1 && cur.length === 2 && !S.t.thirdPlacePlayers) {
        const loserIds = cur.map((m) => m.winnerSlot === m.a.slot ? S.pairings[m.id].bUid : S.pairings[m.id].aUid).filter(Boolean);
        if (loserIds.length === 2) S.t.thirdPlacePlayers = loserIds;
      }
      createRound(next, winners);
      S.t.round = next;
      logIt('Tour ' + next + ' lancé : ' + winners.length + ' qualifiés, duels tirés au sort par le serveur.');
    }
    save();
    return { ok: true };
  },
  'POST /api/admin/delete-unstarted': async (req, res, body) => {
    if (body.confirm !== 'SUPPRIMER TOURNOI') fail(400, 'Tape SUPPRIMER TOURNOI pour confirmer.');
    if (!S.t || S.t.status !== 'inscription' || Object.keys(S.matches || {}).length > 0) fail(409, 'Seul un tournoi dont les inscriptions sont ouvertes et dont aucun affrontement n’a commencé peut être supprimé.');
    const files = new Set();
    for (const entry of Object.values(S.entrants || {})) {
      for (const v of (entry && Array.isArray(entry.videos) ? entry.videos : [])) if (v && v.file) files.add(v.file);
      if (entry && entry.file) files.add(entry.file);
    }
    for (const uploads of Object.values(S.videoUploads || {})) for (const up of Object.values(uploads || {})) if (up && up.file) files.add(up.file);
    for (const up of Object.values(S.uploads || {})) if (up && up.file) files.add(up.file);
    for (const file of files) {
      try { await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: file })); }
      catch (e) { console.error('Suppression média du tournoi impossible:', file, e.message); }
    }
    const name = S.t.name;
    S.t = null; S.entrants = {}; S.matches = {}; S.pairings = {}; S.votes = {}; S.reactions = {};
    S.uploads = {}; S.videoUploads = {};
    logIt('Tournoi supprimé avant son lancement : ' + name + '. Les archives et codes des membres sont conservés.');
    await save();
    return { ok: true, deletedFiles: files.size };
  },
  'POST /api/admin/reset': (req, res, body) => {
    if (body.confirm !== 'NOUVEAU') fail(400, 'Tape NOUVEAU pour confirmer.');
    pendingArchive = JSON.stringify(S);
    const codes = S.codes.map((c) => Object.assign({}, c));
    const bonuses = Array.isArray(S.bonuses) ? S.bonuses.slice() : [];
    S = emptyState();
    S.codes = codes;
    S.bonuses = bonuses;
    logIt('Nouveau tournoi : les inscriptions, duels et votes précédents ont été archivés. Les codes d\'invitation sont conservés.');
    save();
    return { ok: true };
  }
};

/* ---------- communauté et classements ---------- */
function tournamentKey(state) {
  return state && state.t ? String(state.t.createdAt || '') + '|' + String(state.t.name || '') : '';
}
function scoreTournament(state, totals, entries, archived) {
  if (!state || !state.t) return;
  const key = tournamentKey(state);
  for (const [uid, entry] of Object.entries(state.entrants || {})) {
    if (!entries[uid]) entries[uid] = [];
    if (entry && (entry.title || Array.isArray(entry.videos))) {
      const videos = Array.isArray(entry.videos) ? entry.videos.slice().sort((a, b) => Number(a.order || 0) - Number(b.order || 0)).map((v) => ({ title: v.title || '', anime: v.anime || '', order: Number(v.order || 0) })) : [{ title: entry.title || '', anime: entry.anime || '', order: 1 }];
      const place = state.t.championId === uid ? 1 : state.t.runnerUpId === uid ? 2 : state.t.thirdPlaceId === uid ? 3 : null;
      entries[uid].push({ title: entry.title || videos[0] && videos[0].title || '', anime: entry.anime || videos[0] && videos[0].anime || '', videos, tournament: state.t.name || 'Tournoi', createdAt: state.t.createdAt || 0, status: archived && state.t.status === 'termine' ? 'archive' : (state.t.status || ''), place });
    }
    if (!totals[uid]) totals[uid] = { wins: 0, tournaments: new Set(), seasonWins: 0, championships: 0 };
    totals[uid].tournaments.add(key);
  }
  for (const m of Object.values(state.matches || {})) {
    if (!m || m.status !== 'clos' || m.bye || !m.winnerSlot) continue;
    const pair = (state.pairings || {})[m.id];
    if (!pair) continue;
    const uid = m.winnerSlot === m.a.slot ? pair.aUid : pair.bUid;
    if (!uid) continue;
    if (!totals[uid]) totals[uid] = { wins: 0, tournaments: new Set(), seasonWins: 0, championships: 0 };
    totals[uid].wins++;
    if (state === S) totals[uid].seasonWins++;
  }
  // Le vainqueur officiel est conservé séparément du duel de 3e place.
  if (state.t.status === 'termine' && state.t.championId) {
    const championId = state.t.championId;
    if (!totals[championId]) totals[championId] = { wins: 0, tournaments: new Set(), seasonWins: 0, championships: 0 };
    totals[championId].championships = (totals[championId].championships || 0) + 1;
  } else if (state.t.status === 'termine') {
    const matches = Object.values(state.matches || {});
    const finalRound = matches.reduce((n, m) => Math.max(n, Number(m && m.round) || 0), 0);
    const finalMatch = matches.find((m) => m && Number(m.round) === finalRound && m.status === 'clos' && !m.bye && m.winnerSlot);
    const pair = finalMatch && (state.pairings || {})[finalMatch.id];
    if (finalMatch && pair) {
      const championId = finalMatch.winnerSlot === finalMatch.a.slot ? pair.aUid : pair.bUid;
      if (championId) {
        if (!totals[championId]) totals[championId] = { wins: 0, tournaments: new Set(), seasonWins: 0, championships: 0 };
        totals[championId].championships = (totals[championId].championships || 0) + 1;
      }
    }
  }
}
function playerBadges(p) {
  const badges = [];
  if (p.championships >= 1) badges.push({ id: 'champion', icon: '🏆', name: 'Champion', detail: 'A remporté un tournoi' });
  if (p.championships >= 3) badges.push({ id: 'legend', icon: '👑', name: 'Légende', detail: '3 tournois remportés' });
  if (p.wins >= 5) badges.push({ id: 'fighter', icon: '⚔️', name: 'Combattant', detail: '5 duels remportés' });
  if (p.wins >= 10) badges.push({ id: 'master', icon: '🔥', name: 'Maître des duels', detail: '10 duels remportés' });
  if (p.tournaments >= 3) badges.push({ id: 'veteran', icon: '🎖️', name: 'Vétéran', detail: '3 tournois disputés' });
  return badges;
}
function createPrizePayouts() {
  const cfg = S.t && S.t.prizeConfig;
  S.t.prizePayouts = [];
  if (!cfg || !cfg.enabled) return;
  const recipients = [
    { place: 1, playerId: S.t.championId, amount: Number(cfg.amounts && cfg.amounts.first || 0) },
    { place: 2, playerId: S.t.runnerUpId, amount: Number(cfg.amounts && cfg.amounts.second || 0) },
    { place: 3, playerId: S.t.thirdPlaceId, amount: Number(cfg.amounts && cfg.amounts.third || 0) }
  ];
  recipients.forEach((r) => {
    const c = S.codes.find((x) => x.id === r.playerId);
    if (c && r.amount > 0) S.t.prizePayouts.push({ playerId: c.id, playerName: c.name, place: r.place, amount: r.amount, status: 'a_payer' });
  });
}
function audioKeys(state) {
  const keys = new Set();
  const add = (v) => { if (typeof v === 'string' && (/^[a-f0-9]{24}\.(?:mp3|m4a|ogg|wav|webm|flac|aac)$/.test(v) || /^[a-f0-9]{24}\.mp4$/.test(v))) keys.add(v); };
  for (const u of Object.values((state && state.uploads) || {})) if (u) add(u.file);
  for (const group of Object.values((state && state.videoUploads) || {})) if (group) Object.values(group).forEach(v => add(v && v.file));
  for (const e of Object.values((state && state.entrants) || {})) if (e) { if (e.audio) add(e.audio.file); (e.videos || []).forEach(v => add(v && v.file)); }
  for (const m of Object.values((state && state.matches) || {})) if (m) [m.a,m.b].forEach(side => { if (side) { add(side.audio); (side.videos || []).forEach(v => add(v && v.file)); } });
  return keys;
}
function clearAudioRefs(state, keys) {
  const remove = (v) => keys.has(v);
  for (const u of Object.values(state.uploads || {})) if (u && remove(u.file)) delete u.file;
  for (const group of Object.values(state.videoUploads || {})) if (group) Object.keys(group).forEach(k => { if (group[k] && remove(group[k].file)) delete group[k]; });
  for (const e of Object.values(state.entrants || {})) if (e) { if (e.audio && remove(e.audio.file)) e.audio = null; (e.videos || []).forEach(v => { if (v && remove(v.file)) v.file = null; }); }
  for (const m of Object.values(state.matches || {})) if (m) [m.a,m.b].forEach(side => { if (side) { if (remove(side.audio)) side.audio = null; (side.videos || []).forEach(v => { if (v && remove(v.file)) v.file = null; }); } });
}
async function archivedStorage() {
  const rows = await getArchiveRows();
  const allRefs = audioKeys(S);
  rows.forEach((r) => audioKeys(r.state).forEach((k) => allRefs.add(k)));
  const currentRefs = audioKeys(S);
  const refsByArchive = rows.map((r) => audioKeys(r.state));
  const archives = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const keys = Array.from(refsByArchive[i]);
    const shared = keys.filter((k) => {
      if (currentRefs.has(k)) return true;
      return refsByArchive.some((otherRefs, j) => j !== i && otherRefs.has(k));
    });
    const deletable = keys.filter((k) => !shared.includes(k));
    let bytes = 0;
    for (const k of deletable) {
      try { const h = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: k })); bytes += Number(h.ContentLength || 0); }
      catch (e) { if (!(e.name === 'NotFound' || (e.$metadata && e.$metadata.httpStatusCode === 404))) throw e; }
    }
    archives.push({ id: r.id, archivedAt: r.archived_at, name: r.state && r.state.t && r.state.t.name || 'Tournoi sans nom', status: r.state && r.state.t && r.state.t.status || 'inconnu', audioCount: keys.length, deletableCount: deletable.length, sharedCount: shared.length, bytes, pendingCount: Array.isArray(r.state.audioCleanupPending) ? r.state.audioCleanupPending.length : 0 });
  }
  return archives;
}

async function communityData(playerId, viewerId) {
  const archived = await getArchiveRows();
  const states = archived.map((r) => r.state).concat([S]);
  const totals = {}, entries = {};
  states.forEach((state) => scoreTournament(state, totals, entries, state !== S));
  const key = tournamentKey(S), players = [];
  if (!S.community) S.community = { comments: [], favorites: {} };
  if (!Array.isArray(S.community.comments)) S.community.comments = [];
  if (!S.community.favorites) S.community.favorites = {};
  const bonusRows = Array.isArray(S.bonuses) ? S.bonuses : [];
  for (const code of S.codes) {
    if (!code.name) continue;
    const t = totals[code.id] || { wins: 0, tournaments: new Set(), seasonWins: 0, championships: 0 };
    const allBonus = bonusRows.filter((b) => b.playerId === code.id).reduce((n, b) => n + Number(b.points || 0), 0);
    const seasonBonus = bonusRows.filter((b) => b.playerId === code.id && b.tournamentKey === key).reduce((n, b) => n + Number(b.points || 0), 0);
    players.push({
      id: code.id, name: code.name, wins: t.wins, seasonWins: t.seasonWins,
      bonus: allBonus, seasonBonus: seasonBonus, points: t.wins * 3 + allBonus,
      seasonPoints: t.seasonWins * 3 + seasonBonus, tournaments: t.tournaments.size,
      championships: t.championships || 0, favoriteCount: (S.community.favorites[code.id] || []).length
    });
  }
  const sort = (a, b) => b.points - a.points || b.wins - a.wins || a.name.localeCompare(b.name, 'fr');
  const season = players.filter((p) => (S.entrants || {})[p.id] || p.seasonBonus !== 0).sort((a, b) => b.seasonPoints - a.seasonPoints || b.seasonWins - a.seasonWins || a.name.localeCompare(b.name, 'fr'));
  const allTime = players.filter((p) => p.tournaments > 0 || p.bonus !== 0).sort(sort);
  const out = { seasonName: S.t ? S.t.name : 'Saison actuelle', season, allTime };
  if (playerId) {
    const p = players.find((x) => x.id === playerId);
    if (!p) return Object.assign(out, { profile: null });
    const history = (entries[playerId] || []).filter((e) => e.status === 'termine' || e.status === 'archive');
    const comments = S.community.comments.filter((c) => c.playerId === playerId).slice(-100).reverse().map((c) => Object.assign({}, c, { likes: Array.isArray(c.likes) ? c.likes.length : 0, likedByMe: !!viewerId && Array.isArray(c.likes) && c.likes.includes(viewerId), canLike: !!viewerId, canDelete: !!viewerId && c.authorId === viewerId }));
    out.profile = Object.assign({}, p, { favorited: !!viewerId && (S.community.favorites[playerId] || []).includes(viewerId), canFavorite: !!viewerId && viewerId !== playerId, comments, titleCount: history.reduce((n, e) => n + (Array.isArray(e.videos) ? e.videos.length : 1), 0), podiums: { first: history.filter((e) => e.place === 1).length, second: history.filter((e) => e.place === 2).length, third: history.filter((e) => e.place === 3).length }, badges: playerBadges(p), history: history.sort((a, b) => Number(b.createdAt) - Number(a.createdAt)) });
  }
  return out;
}

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
  let p = pathname === '/' ? '/index.html' : pathname === '/admin' ? '/admin.html' : pathname === '/stats' ? '/stats.html' : pathname === '/community' ? '/community.html' : pathname;
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
    if (key === 'POST /api/audio') return handleUpload(req, res);
    let vr=/^\/api\/video\/chunk\/init\/([123])$/.exec(url.pathname);
    if(req.method==='POST'&&vr)return videoMultipartInit(req,res,Number(vr[1]),await readBody(req));
    vr=/^\/api\/video\/chunk\/part\/([123])\/([a-f0-9]{32})\/([0-9]{1,2})$/.exec(url.pathname);
    if(req.method==='POST'&&vr)return videoMultipartPart(req,res,Number(vr[1]),vr[2],Number(vr[3]));
    vr=/^\/api\/video\/chunk\/complete\/([123])\/([a-f0-9]{32})$/.exec(url.pathname);
    if(req.method==='POST'&&vr)return videoMultipartComplete(req,res,Number(vr[1]),vr[2],await readBody(req));
    const videoUpload = /^\/api\/video\/([123])$/.exec(url.pathname);
    if (req.method === 'POST' && videoUpload) return handleVideoUpload(req, res, Number(videoUpload[1]));
    const am = /^\/audio\/([a-f0-9]{24}\.(?:mp3|m4a|ogg|wav|webm|flac|aac))$/.exec(url.pathname);
    if (am && (req.method === 'GET' || req.method === 'HEAD')) return serveAudio(req, res, am[1]);
    const adminVm = /^\/api\/admin\/video\/stream\/([a-f0-9]{24}\.mp4)$/.exec(url.pathname);
    if (adminVm && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!isAdmin(req)) return sendJson(res, 401, { error: 'Connexion organisateur requise.' });
      return serveVideo(req, res, adminVm[1], true);
    }
    const vm = /^\/video\/([a-f0-9]{24}\.mp4)$/.exec(url.pathname);
    if (vm && (req.method === 'GET' || req.method === 'HEAD')) return serveVideo(req, res, vm[1]);
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
      const result = await fn(req, res, body); await saveQueue; return sendJson(res, 200, result);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SEC); return res.end(); }
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    console.error(e);
    return sendJson(res, 500, { error: 'Erreur du serveur.' });
  }
});

setInterval(closeExpired,TICK_MS).unref();
async function start(){
 const cfg=await pool.query('SELECT value FROM app_config WHERE key=$1',['session_secret']);
 if(!SECRET){SECRET=cfg.rows[0]&&cfg.rows[0].value;if(!SECRET){SECRET=crypto.randomBytes(48).toString('hex');await pool.query('INSERT INTO app_config(key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING',['session_secret',SECRET]);}}
 const r=await pool.query('SELECT state FROM app_state WHERE id=1');
 if(r.rows.length)S=Object.assign(emptyState(),r.rows[0].state);else await pool.query('INSERT INTO app_state(id,state) VALUES (1,$1::jsonb)',[JSON.stringify(S)]);
 server.listen(PORT,()=>console.log('Arène des Openings sur le port '+PORT));
}
start().catch(e=>{console.error('Initialisation impossible:',e);process.exit(1);});
