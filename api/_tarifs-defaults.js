// Barème par défaut des postes tarifaires — SOURCE UNIQUE, partagée entre
// l'application (src/App.jsx) et les fonctions serveur (api/rapport, api/devis).
// ⚠ Tant qu'aucun admin n'a enregistré de modification dans Admin → Postes
// tarifaires, le document Firestore config/tarifs n'existe pas : tous les
// consommateurs doivent retomber sur cette liste.
// (Fichier préfixé « _ » : non exposé comme endpoint par Vercel.)

export const DEFAULT_TARIFS = [
  // CARROSSERIE
  // Postes "sur devis" avec BARÈME PAR TAILLE : l'expert choisit la tranche
  // mesurée, le montant tombe automatiquement (barème aligné sur les pratiques
  // de restitution du marché — modifiable dans Admin → Postes tarifaires).
  { id: "deformation", zone: "carrosserie", label: "Déformations > 100 cm²", prix: null, surDevis: true, bareme: [
    { label: "100 à 300 cm² — débosselage + peinture", montant: 280 },
    { label: "> 300 cm² — élément complet", montant: 450 },
  ] },
  { id: "dechirure", zone: "carrosserie", label: "Déchirures, cassures et fissures > 5 cm", prix: null, surDevis: true, bareme: [
    { label: "5 à 20 cm — réparation", montant: 300 },
    { label: "> 20 cm — remplacement élément", montant: 600 },
  ] },
  { id: "depot", zone: "carrosserie", label: "Dépôts industriels, chimiques ou non nettoyable > 200 cm²", prix: null, surDevis: true, bareme: [
    { label: "> 200 cm² — nettoyage spécialisé", montant: 150 },
    { label: "Avec reprise peinture", montant: 350 },
  ] },
  { id: "rayure_oxydation", zone: "carrosserie", label: "Rayures avec oxydation", prix: null, surDevis: true, bareme: [
    { label: "5 à 30 cm — raccord peinture", montant: 180 },
    { label: "> 30 cm ou multi-éléments — peinture élément", montant: 350 },
  ] },
  { id: "sinistre", zone: "carrosserie", label: "Dommages non réparés suite à sinistre", prix: null, surDevis: true },
  // MOULURES
  { id: "pare_choc_avant", zone: "moulures", label: "Pare-choc avant — cassé ou rayure profonde", prix: 470 },
  { id: "plaque_immat", zone: "moulures", label: "Plaque immatriculation — cassé ou tordu", prix: 18 },
  { id: "lisse_protection", zone: "moulures", label: "Lisses de protection / obturateur — cassé ou rayure profonde absence", prix: 110 },
  { id: "pare_choc_arriere", zone: "moulures", label: "Pare-choc arrière — cassé ou rayure profonde", prix: 590 },
  { id: "passage_roue", zone: "moulures", label: "Passage de roue — cassé ou absent", prix: 216 },
  { id: "protection_carter", zone: "moulures", label: "Protection de carter moteur — cassé ou absent", prix: 390 },
  // RETROVISEURS
  { id: "retroviseur", zone: "retroviseurs", label: "Miroir / coque / clignotant — cassé", prix: 350 },
  // PARE-BRISE
  { id: "fissure_vitre", zone: "pare_brise", label: "Fissure — remplacement", prix: 650 },
  { id: "eclat_vitre", zone: "pare_brise", label: "Éclat + impact (si réparable)", prix: 90 },
  // OPTIQUES
  { id: "phare_avant", zone: "optiques", label: "Phare avant — cassé ou rayure profonde", prix: 450 },
  { id: "feu_position", zone: "optiques", label: "Feux de position latéral", prix: 36 },
  { id: "feu_stop_panier", zone: "optiques", label: "3e feux stop sur panier 12V — cassé", prix: 70 },
  { id: "feu_av_gauche", zone: "optiques", label: "Feu avant gauche — cassé ou rayure profonde", prix: 180 },
  { id: "feu_av_droit", zone: "optiques", label: "Feu avant droit — cassé ou rayure profonde", prix: 180 },
  { id: "feu_ar_gauche", zone: "optiques", label: "Feu arrière gauche — cassé ou rayure profonde", prix: 180 },
  { id: "feu_ar_droit", zone: "optiques", label: "Feu arrière droit — cassé ou rayure profonde", prix: 180 },
  // ROUES
  { id: "jante", zone: "roues", label: "Jantes — déformations, enlèvement de matière", prix: 150 },
  { id: "pneumatiques", zone: "roues", label: "Pneumatiques par paire — usure > 50%", prix: 300 },
  { id: "roue_secours", zone: "roues", label: "Roue de secours — absente ou inutilisable", prix: 250 },
  { id: "cric", zone: "roues", label: "Cric — absent ou non complet", prix: 150 },
  // INTÉRIEUR
  { id: "tapis_sol", zone: "interieur", label: "Tapis de sol — déchiré sur plus de 10 cm", prix: 630 },
  { id: "sieges", zone: "interieur", label: "Sièges — brûlure, déchiré, trou", prix: 175 },
  { id: "etagere_int", zone: "interieur", label: "Étagère — cassée", prix: 170 },
  { id: "autoradio", zone: "interieur", label: "Autoradio — cassé ou manquant", prix: 450 },
  { id: "poignees", zone: "interieur", label: "Poignées — cassées", prix: 140 },
  { id: "barlillet", zone: "interieur", label: "Barillet / Neiman / bouchon de réservoir — forcé", prix: 270 },
  { id: "plancher_fourgon", zone: "interieur", label: "Plancher fourgon arrière — si défaut nuisant à l'utilisation", prix: 270 },
  { id: "parois_cloisons", zone: "interieur", label: "Parois et cloisons — si défaut nuisant à l'utilisation", prix: 485 },
  { id: "meuble_etabli", zone: "interieur", label: "Meuble établi ou étagère — cassé ou tordu", prix: 600 },
  { id: "bac", zone: "interieur", label: "1 bac — cassé ou manquant", prix: 8 },
  // NACELLE
  { id: "feu_antibrou", zone: "nacelle", label: "Feu antibrouillard / recul / stop / clignotant / éclaireur plaque / de gabarit — cassé", prix: 197 },
  { id: "feu_gabarit_coude", zone: "nacelle", label: "Feux de gabarit coudé droit — cassé", prix: 127 },
  { id: "crochet_attelage", zone: "nacelle", label: "Crochet d'attelage", prix: 261 },
  { id: "prise_attelage", zone: "nacelle", label: "Prise d'attelage — cassé", prix: 200 },
  { id: "tige_gabarit", zone: "nacelle", label: "Tige gabarit — cassé", prix: 109 },
  { id: "gyrophare", zone: "nacelle", label: "Gyrophare — cassé", prix: 205 },
  { id: "bras_portillon", zone: "nacelle", label: "Bras de portillon — cassé", prix: 229 },
  { id: "manipulateur_haut", zone: "nacelle", label: "Manipulateur poste haut — cassé", prix: 189 },
  { id: "variateur_haut", zone: "nacelle", label: "Variateur poste haut — cassé", prix: 450 },
  { id: "gyrophare_bras_portillon", zone: "nacelle", label: "Gyrophare / bras de portillon / manipulateur poste de commande", prix: 140 },
  { id: "triflash", zone: "nacelle", label: "Triflash — cassé", prix: 390 },
  { id: "panier", zone: "nacelle", label: "Panier — cassé / tordu", prix: null, surDevis: true },
  { id: "protection_poste_haut", zone: "nacelle", label: "Protection de poste haut — cassé", prix: 268 },
  { id: "tole_alu", zone: "nacelle", label: "Tôle ALU X62 — cassé / tordu", prix: 856 },
  { id: "plateforme_nacelle", zone: "nacelle", label: "Plateforme — cassé / tordu", prix: null, surDevis: true },
  { id: "carter_nacelle", zone: "nacelle", label: "Carter de protection nacelle — cassé", prix: 365 },
  { id: "porte_echelle", zone: "nacelle", label: "Porte échelle — cassé", prix: 1808 },
  { id: "soufflet_variateur", zone: "nacelle", label: "Soufflet variateur de vitesse — cassé", prix: 104 },
  { id: "eclaireur_plaque_led", zone: "nacelle", label: "Éclaireur plaque LED 12/24V", prix: 130 },
  { id: "verrouillage_portillon", zone: "nacelle", label: "Verrouillage portillon KLUBB", prix: 162 },
  { id: "ensemble_variateur", zone: "nacelle", label: "Ensemble variateur de vitesse", prix: 368 },
  { id: "arret_urgence", zone: "nacelle", label: "Arrêt d'urgence", prix: 128 },
  { id: "commutateur_rotatif", zone: "nacelle", label: "Commutateur rotatif couleur 12V", prix: 99 },
  { id: "kit_etiquette", zone: "nacelle", label: "Kit étiquette", prix: 125 },
  // NETTOYAGE
  { id: "forfait_nettoyage", zone: "nettoyage", label: "Forfait nettoyage", prix: 120 },
  { id: "enlevement_dechets", zone: "nettoyage", label: "Forfait enlèvement des déchets", prix: 240 },
  { id: "manuel_utilisation", zone: "nettoyage", label: "Manuel d'utilisation — manquant", prix: 60 },
  { id: "nettoyage_interieur", zone: "nettoyage", label: "Nettoyage intérieur", prix: 100 },
  { id: "nettoyage_exterieur", zone: "nettoyage", label: "Nettoyage extérieur", prix: 70 },
];
