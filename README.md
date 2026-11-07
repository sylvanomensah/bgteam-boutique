# BGTeam Boutique

Application web de gestion de boutique (caisse, stock, entrées, ventes, facturation), issue du classeur Excel `BGTeam_FINAL_WORK_V10.xlsx`.

Aucune installation : c'est une page web (HTML/CSS/JavaScript) qui fonctionne dans n'importe quel navigateur, même hors ligne.

## Fonctionnalités

| Écran | Rôle (équivalent Excel) |
|---|---|
| **Accueil** | Tableau de bord filtrable par période (jour, semaine, mois, année, tout) et par code commercial (CC) : chiffre d'affaires, tickets, quantités, panier moyen, marge, ventes par CC, meilleures ventes, alertes stock |
| **Statistiques** | Ventes regroupées par jour / semaine / mois / année, en colonnes par CC ou par vendeur, export CSV |
| **Caisse** | Saisie rapide d'une vente : plusieurs produits par ticket, client, code commercial (CC), montant remis et reliquat (feuille `VENTES`) |
| **Ventes** | Historique, validation OUI/NON, rapport journalier (du… au…) et mensuel filtrables par CC, export CSV |
| **Stock** | Catalogue et stock actuel calculé automatiquement, ajout / modification de produits (feuille `STOCK`) |
| **Entrées stock** | Réapprovisionnements, statut Validée / Annulée (feuille `ENTREES_STOCK`) |
| **Facturation** | Ticket de caisse imprimable à partir d'un numéro de ticket (feuille `FACTURATION`) |
| **Paramètres** | Informations du commerce, gestion des CC et des vendeurs (affectation datée, départ, nouveau CC), sauvegarde / restauration |

## Codes commerciaux (CC) et vendeurs

- Chaque vente enregistre son CC **et le nom du vendeur** à la date de la vente.
- *Départ / désactiver* : le vendeur quitte l'entreprise, le CC disparaît de la caisse mais toutes ses ventes restent dans les statistiques.
- *Nouveau CC* : pour un nouveau vendeur (recommandé), ou *Changer de vendeur* pour réaffecter un CC existant à partir d'une date.

## Règles de calcul

- **Stock actuel** = Stock initial + Entrées *Validées* − Ventes *OUI*
- Statut : `RUPTURE` si stock ≤ 0, `STOCK FAIBLE` si stock ≤ stock minimum, sinon `OK`
- Une vente `NON` ou une entrée `Annulée` reste dans l'historique mais n'est pas comptée.

## Utilisation

- **En local** : ouvrir `index.html` dans le navigateur (double-clic).
- **En ligne** : via GitHub Pages (Settings → Pages → Branch `main` / root).

## Données

Les données sont enregistrées dans le navigateur (localStorage) de l'appareil utilisé.
Elles ne sont **pas** partagées automatiquement entre appareils : utilisez *Paramètres → Télécharger une sauvegarde* puis *Restaurer* sur l'autre appareil. Faites des sauvegardes régulières.

Au premier lancement, l'application contient le catalogue produits et les informations du commerce (`js/data.js`), sans historique de ventes.
Pour retrouver l'historique du fichier Excel, restaurez la sauvegarde `sauvegarde-BGTeam-donnees-excel.json` (fichier privé, non publié) via *Paramètres → Restaurer une sauvegarde*.

## Structure

```
index.html      Interface
css/style.css   Mise en forme (et mise en page d'impression du ticket)
js/data.js      Données initiales issues de l'Excel
js/app.js       Logique de l'application
```
