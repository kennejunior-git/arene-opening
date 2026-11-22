'use strict';

// Test de charge STRICTEMENT EN LECTURE SEULE.
// Aucun POST/PUT/PATCH/DELETE, aucune connexion joueur, aucun vote,
// aucune réaction, aucun téléversement et aucune suppression.
const BASE = (process.env.BASE_URL || 'https://arene-opening-orange-test.vercel.app').replace(/\/+$/, '');
const ROUNDS = Number(process.env.ROUNDS || 2);
const STAGES = [10, 20, 30, 50];
const TIMEOUT_MS = 15000;

const baseUrl = new URL(BASE);
if (baseUrl.protocol !== 'https:' || baseUrl.hostname !== 'arene-opening-orange-test.vercel.app') {
  console.error('ARRÊT : ce script est limité au site de test arene-opening-orange-test.vercel.app.');
  process.exit(2);
}
if (!Number.isInteger(ROUNDS) || ROUNDS < 1 || ROUNDS > 3) {
  console.error('ROUNDS doit être compris entre 1 et 3.');
  process.exit(2);
}

async function get(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const start = performance.now();
  try {
    const response = await fetch(BASE + path, {
      method: 'GET',
      headers: { accept: 'application/json,text/html' },
      cache: 'no-store',
      signal: controller.signal
    });
    await response.arrayBuffer();
    return { ok: response.ok, status: response.status, ms: performance.now() - start };
  } catch (error) {
    return { ok: false, status: 0, ms: performance.now() - start, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function virtualUser() {
  // Pages et API publiques uniquement. Requêtes GET sans cookie ni identité.
  const results = await Promise.all([
    get('/'),
    get('/api/state'),
    get('/api/community')
  ]);
  return results;
}

(async () => {
  console.log('TEST DE CHARGE EN LECTURE SEULE');
  console.log('Cible : ' + BASE);
  console.log('Aucune donnée du tournoi ne sera créée ou modifiée.');
  console.log('Requêtes utilisées : GET /, GET /api/state, GET /api/community');
  console.log('Chaque palier : ' + ROUNDS + ' passage(s) par utilisateur.');
  console.log('');

  for (const users of STAGES) {
    const all = [];
    const started = performance.now();
    for (let round = 0; round < ROUNDS; round++) {
      const batch = await Promise.all(Array.from({ length: users }, () => virtualUser()));
      all.push(...batch.flat());
    }
    const elapsed = performance.now() - started;
    const ok = all.filter(x => x.ok).length;
    const errors = all.length - ok;
    const sorted = all.map(x => x.ms).sort((a, b) => a - b);
    const avg = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
    const errorRate = errors / Math.max(1, all.length);

    console.log('--- ' + users + ' utilisateurs simulés ---');
    console.log('Requêtes : ' + all.length + ' | réussies : ' + ok + ' | erreurs : ' + errors);
    console.log('Temps moyen : ' + Math.round(avg) + ' ms | p95 : ' + Math.round(p95) + ' ms');
    console.log('Durée du palier : ' + (elapsed / 1000).toFixed(1) + ' s');

    if (errors > 0 || p95 > 5000) {
      console.log('ARRÊT AUTOMATIQUE : erreurs détectées ou réponses trop lentes. Ne pas augmenter la charge.');
      process.exitCode = 1;
      return;
    }
    console.log('Palier terminé sans erreur HTTP.');
    console.log('');
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  console.log('Test terminé. Ces résultats mesurent les pages/API publiques, pas 50 lectures vidéo réelles.');
})().catch(error => {
  console.error('Échec du test :', error);
  process.exitCode = 1;
});
