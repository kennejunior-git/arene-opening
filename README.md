# Arène des Openings

Site de tournoi d'openings : duels en binôme, vote anonyme avec un code d'invitation par personne, scores publiés automatiquement, journal public. Aucune dépendance à installer (Node 18 ou plus).

## Essayer chez toi

```
ADMIN_PASSWORD="un-mot-de-passe-long" node server.js
```

Ouvre http://localhost:3000 (site) et http://localhost:3000/admin (organisateur).
Test automatique : `npm test`.

## Mettre en ligne

Il faut un hébergeur qui fait tourner Node **et garde un disque persistant** (Render avec disque, Railway avec volume, Fly.io avec volume, ou un petit serveur VPS). Sur un hébergement gratuit sans disque, les données s'effacent à chaque redémarrage.

1. Mets ce dossier sur GitHub (ou envoie-le directement selon l'hébergeur).
2. Crée un « Web Service » Node. Commande de démarrage : `node server.js`. Pas de commande de build.
3. Variables d'environnement :
   - `ADMIN_PASSWORD` : ton mot de passe organisateur (8 caractères minimum).
   - `DATA_DIR` : le dossier du disque persistant, par exemple `/data`.
4. Attache le disque persistant à ce dossier.
5. Partage l'adresse du site dans ton groupe WhatsApp.

## Déroulé d'un tournoi

1. `/admin` : crée le tournoi, génère un code par membre du groupe, envoie chaque code en privé.
2. Chaque personne entre son code et choisit un pseudo (une seule fois). Les participants inscrivent ensuite leur opening (anime, titre, lien).
3. Tu fermes les inscriptions : le serveur tire les binômes au hasard.
4. Tu ouvres les votes, duel par duel ou tous d'un coup. Un vote dure **15 minutes**. Tu peux cocher « score en direct » ; sinon le score reste caché jusqu'à la clôture.
5. À l'heure, le serveur compte et publie tout seul. En cas d'égalité, **5 minutes** s'ajoutent automatiquement. Après 6 prolongations sans départage, le serveur tire le gagnant au sort et l'écrit dans le journal.
6. Quand tous les duels du tour sont terminés, tu lances le tour suivant, jusqu'à la finale.

La page `/stats` montre les votes en direct (nombre de votes, jamais les noms pendant le vote), les duels terminés avec la liste des pseudos des votants, et les chiffres du tournoi.

Les durées se changent avec les variables `VOTE_MINUTES`, `EXTEND_MINUTES` et `MAX_EXTENSIONS` (utile pour tester avec des durées courtes).

## Ce que le site garantit, et ses limites

- Un code = un vote par duel. Le serveur ne révèle ni les noms des auteurs, ni les noms des votants, ni les scores (sauf si tu actives le score en direct) avant la clôture.
- L'organisateur ne vote pas, ne voit pas qui est inscrit, ne peut pas modifier un vote ni choisir un gagnant, et ne peut pas clôturer à la main.
- Chaque action est écrite dans le journal public. Le nombre de codes émis est affiché sur le site.
- **Limites :** un membre peut prêter son code, ou en demander un second sous un autre nom. Génère exactement autant de codes que de membres, et compare avec le nombre affiché. Celui qui héberge le serveur peut techniquement modifier le fichier de données : choisis un hébergeur de confiance.
