# 📱 MKTV — Application web IPTV avec Proxy Xtream intégré
---

## 1. Présentation

Nom provisoire : **MKTV**

Objectif : application web IPTV permettant aux utilisateurs de regarder plus de **24 000 chaînes TV en streaming**, avec :

- un lecteur vidéo intégré
- un proxy interne compatible Xtream Codes
- un système de compte utilisateur (Supabase)
- un système d'abonnement avec période d'essai (24h)

L'application se comporte comme un lecteur IPTV moderne (style VLC / IPTV Smarters).

---

## 2. Fonctionnement global

L'application permet :

- créer un compte
- se connecter
- voir toutes les chaînes
- regarder les chaînes si abonnement actif
- bloquer la lecture si abonnement inactif

---

## 3. Source des streams

Format utilisé : playlist M3U contenant des liens HLS (.m3u8)

Exemple d'entrée dans `xtream_playlist.m3u` :

```
#EXTINF:-1 tvg-id="10719" tvg-logo="logo.png" group-title="MBC FHD",Channel Name
http://esmaxnews.com:2095/live/7122922479032073/11fa800f65003314/10719.m3u8
```

Le fichier `xtream_playlist.m3u` situé à la racine contiendra la playlist complète fournie.

---

## 4. Format HLS

Chaque chaîne expose un `.m3u8` et plusieurs segments `.ts` :

```
stream.m3u8

segment1.ts
segment2.ts
segment3.ts
```

L'application web doit charger le `.m3u8`, récupérer automatiquement les segments `.ts` et lire la vidéo en continu.

---

## 5. Proxy interne (obligatoire)

Le serveur Xtream exige des headers spécifiques :

```
User-Agent: Lavf/57.83.100
Accept: */*
Icy-MetaData: 1
```

Le proxy doit :

- intercepter toutes les requêtes (`.m3u8` et `.ts`)
- ajouter les headers requis
- transmettre la requête au serveur Xtream
- renvoyer la vidéo au lecteur sans exposer les identifiants

Le proxy doit gérer correctement le stream HLS (modification des URLs dans les .m3u8 si nécessaire pour forcer le passage par le proxy).

---

## 6. Système utilisateur (Supabase)

Table `users` :

```
id
email
password
is_subscribed (boolean)
trial_start_date
trial_end_date
subscription_expiry_date
```

Fonctions : inscription, connexion, déconnexion.

---

## 7. Période d'essai

Chaque nouvel utilisateur reçoit 24 heures d'essai complet (accès lecture autorisé). Après 24h, l'accès devient dépendant du champ `is_subscribed`.

---

## 8. Abonnement

Prix :

- 3000 FCFA / mois
- 45000 FCFA / an

Le paiement est géré manuellement (via Supabase/administration). Après paiement, l'admin met `is_subscribed = true` pour l'utilisateur.

---

## 9. Blocage si non abonné

Si `is_subscribed = false` et que la période d'essai est expirée :

- À la lecture d'une chaîne afficher écran plein avec le message :

```
Votre période d'essai est terminée
Veuillez payer un abonnement
3000 FCFA / mois
45000 FCFA / an
Contact :
WhatsApp : +221778628648
Appel : +221778628648
```

---

## 10. Lecteur vidéo

Le lecteur doit supporter :

- HLS (.m3u8, .ts)
- plein écran
- buffer et lecture stable

Technologie recommandée : `hls.js` côté client pour compatibilité navigateur.

---

## 11. Organisation des chaînes

Catégories (exemples) : Sports, Cinéma, France, USA, Sénégal

Chaque chaîne affiche : logo, nom, catégorie.

---

## 12. Recherche

Recherche par nom et par catégorie.

---

## 13. Favoris

Ajouter / supprimer des favoris (stockage dans Supabase lié à l'utilisateur).

---

## 14. Historique

Sauvegarder les chaînes regardées par l'utilisateur (timestamp + chaîne).

---

## 15. UI

Style moderne, fond sombre (dark). Pages principales :

- Splash Screen
- Login
- Register
- Home (catégories, chaînes, recherche)
- Player (lecteur vidéo, fullscreen)
- Subscription required (message de blocage)
- Profile (email, statut abonnement, logout)

---

## 16. Architecture technique

```
web App
│
├── Video Player (hls.js)
├── Internal Proxy (node/express ou middleware cloud)
├── Supabase Auth + DB
├── Playlist Parser
└── UI (React / Vue / Svelte)
```

---

## 17. Plateformes

Fonctionne sur web ; possibilité d'installation via PWA (icône de téléchargement dans le navigateur).

---

## 18. Objectif final

Créer une application IPTV complète avec :

- lecture de ~24000 chaînes
- proxy Xtream intégré
- système d'abonnement (manuel)
- période d'essai 24h
- interface moderne

---

## 19. Playlist

La playlist sera fournie sous le nom `xtream_playlist.m3u` à la racine du projet.

---

## Prochaines étapes proposées

1. Implémenter le proxy interne (Node/Express) pour `.m3u8` et `.ts`.
2. Scaffolder l'application web (ex : React + hls.js) et l'auth Supabase.
3. Intégrer lecture/contrôle d'accès selon `is_subscribed` et période d'essai.

---

Contact rapide : utilisez les issues du dépôt pour demandes ou priorités.

---

## Production (Render)

1. Push le projet sur GitHub.
2. Sur Render, cree un `Web Service` Node.
3. Build command: `npm install`
4. Start command: `npm start`
5. Variables d'environnement Render:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (obligatoire pour le workflow d'approbation admin)
   - `ADMIN_PANEL_PATH` (ex: `/mktv-admin-ops-7f9a`, URL secrete de la page admin)
6. Deploy.

Le fichier `render.yaml` est fourni et peut etre utilise directement.

### Proxy en production

- Tous les utilisateurs passent par le meme backend proxy (`/api/proxy`) de ton service Render.
- Le proxy ne lance pas un nouveau serveur par utilisateur; c'est un service central commun.
- Le verrou "1 seul flux par compte" est active cote serveur.

### Installation de l'app (icone telechargement)

- L'app est maintenant PWA:
  - `public/manifest.webmanifest`
  - `public/service-worker.js`
- Quand le navigateur autorise l'installation, un bouton "Telecharger l'app" s'affiche dans la topbar.

### Variables d'environnement locales (.env)

Pour tester en local, cree un fichier `.env` a la racine en copiant `.env.example` puis remplis:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

Sur Render, configure ces variables dans l'interface (pas besoin de fichier `.env`).

### Approbation admin (production)

- La validation des comptes est persistante dans Supabase (table `public.user_access`).
- Execute le SQL de creation dans l'editor SQL Supabase:
  - `supabase/schema.sql`
- Les admins sont hardcodes cote serveur:
  - `mouhasogue@gmail.com`
  - `methndiaye43@gmail.com`
- La page admin est separee de l'app utilisateur, accessible via `ADMIN_PANEL_PATH` uniquement.
- Exemple: `https://ton-app.onrender.com/mktv-admin-ops-7f9a`

### APK Android (telephone + box IPTV Android)

1. Verifier que ton service Render est en ligne (exemple: `https://mktv-web.onrender.com`).
2. La config mobile est dans `capacitor.config.ts` et utilise cette URL.
3. Generer/synchroniser Android:
   - `npm run cap:sync`
4. Ouvrir le projet natif:
   - `npm run cap:open`
5. Dans Android Studio:
   - `Build` > `Generate Signed Bundle / APK` > `APK` > `release`
6. Recuperer l'APK dans:
   - `android/app/release/` (ou le chemin indique par Android Studio)

Note:
- Si l'URL Render change, mets a jour `server.url` dans `capacitor.config.ts`, puis relance `npm run cap:sync`.
- Pour box IPTV Android TV, prevoir une navigation telecommande (D-pad) dans l'interface.
