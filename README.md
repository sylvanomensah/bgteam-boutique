# BGTeam Boutique

Application web de gestion de boutique (caisse, stock, entrées, ventes, statistiques, facturation), issue du classeur Excel `BGTeam_FINAL_WORK_V10.xlsx`.

- **Front-end** : HTML/CSS/JavaScript sans compilation, hébergé sur **Cloudflare Pages**.
- **Back-end** : **Supabase** (PostgreSQL, authentification, sécurité Row Level Security).

Les données sont partagées en temps réel entre tous les appareils connectés.

## Fonctionnalités

| Écran | Rôle | Accès |
|---|---|---|
| **Accueil** | Tableau de bord filtrable par période (jour, semaine, mois, année, tout) et par code commercial (CC) | Admin |
| **Caisse** | Saisie d'un ticket multi-produits, client, CC, montant remis / reliquat | Tous |
| **Ventes** | Historique, rapports journalier / mensuel par CC, export CSV, validation OUI/NON | Tous (OUI/NON et suppression : admin) |
| **Statistiques** | Ventes par jour / semaine / mois / année, colonnes par CC ou par vendeur, export CSV | Admin |
| **Stock** | Catalogue et stock actuel calculé | Tous (modification : admin) |
| **Entrées stock** | Réapprovisionnements | Tous (annulation / suppression : admin) |
| **Facturation** | Ticket de caisse imprimable | Tous |
| **Paramètres** | Commerce, utilisateurs, CC & vendeurs, sauvegarde / import | Admin |

## Comptes et rôles

- Chacun crée son compte depuis l'écran de connexion (« Créer un compte »).
- **Le tout premier compte devient administrateur.** Les suivants sont des *vendeurs en attente* que l'admin valide dans *Paramètres → Utilisateurs*.
- Un vendeur lié à un CC encaisse toujours sous ce CC, au prix catalogue et à la date du jour (contrôlé par la base, pas seulement par l'interface). Il ne voit pas les prix d'achat.
- Mot de passe oublié : l'admin le réinitialise dans Supabase (*Authentication → Users*).

## Règles de calcul

- **Stock actuel** = Stock initial + Entrées *Validées* − Ventes *OUI*
- Statut : `RUPTURE` si stock ≤ 0, `STOCK FAIBLE` si stock ≤ stock minimum, sinon `OK`
- Une vente `NON` ou une entrée `Annulée` reste dans l'historique mais n'est pas comptée.
- Les numéros de ticket sont attribués par la base (pas de doublon entre plusieurs caisses).

## Codes commerciaux (CC) et vendeurs

- Chaque vente enregistre son CC **et le nom du vendeur** à la date de la vente.
- *Départ / désactiver* : le CC disparaît de la caisse, ses ventes restent dans les statistiques.
- *Nouveau CC* pour un nouveau vendeur, ou *Changer de vendeur* pour réaffecter un CC à partir d'une date.

## Installation

1. **Supabase** : exécuter `supabase/schema.sql` dans le SQL Editor, puis insérer le catalogue de départ.
2. Renseigner l'URL du projet et la clé publique *anon* dans `js/config.js` (valeurs publiques : la sécurité repose sur la connexion et les règles RLS).
3. **Cloudflare Pages** : *Workers & Pages → Create → Pages → Connect to Git*, choisir ce dépôt, *Framework preset* : None, *Build command* : vide, *Build output directory* : `/`. Chaque `git push` sur `main` redéploie le site.

## Structure

```
index.html            Interface
css/style.css         Mise en forme (et impression du ticket)
js/config.js          URL et clé publique Supabase
js/app.js             Logique de l'application
supabase/schema.sql   Tables, fonctions et règles de sécurité
```
