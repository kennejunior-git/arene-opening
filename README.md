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
2. Les participants entrent leur code puis inscrivent leur opening (anime, titre, lien).
3. Tu fermes les inscriptions : le serveur tire les binômes au hasard.
4. Tu ouvres les votes du tour (durée au choix). À l'heure, le serveur compte et publie tout seul.
5. En cas d'égalité, tu prolonges le vote. Sinon tu lances le tour suivant, jusqu'à la finale.

## Ce que le site garantit, et ses limites

- Un code = un vote par duel. Le serveur ne révèle ni les noms ni les scores avant la clôture.
- L'organisateur ne vote pas, ne voit pas qui est inscrit, ne peut pas modifier un vote ni choisir un gagnant, et ne peut pas clôturer à la main.
- Chaque action est écrite dans le journal public. Le nombre de codes émis est affiché sur le site.
- **Limites :** un membre peut prêter son code, ou en demander un second sous un autre nom. Génère exactement autant de codes que de membres, et compare avec le nombre affiché. Celui qui héberge le serveur peut techniquement modifier le fichier de données : choisis un hébergeur de confiance.
