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

  // ─── Postes ajoutés depuis la grille FRE prix (PDF Jonathan, 21/08/2026) ───
  // Seuls les postes CHIFFRÉS et absents de la liste ci-dessus sont repris.
  // Grâce à la fusion au chargement (src/App.jsx), ils apparaissent
  // automatiquement dans Admin → Postes tarifaires sans écraser l'existant.
  // CARROSSERIE
  { id: "aile_avant", zone: "carrosserie", label: "Aile avant — cassée / tordue", prix: 325 },
  { id: "aile_arriere", zone: "carrosserie", label: "Aile arrière — cassée / tordue", prix: 325 },
  { id: "bas_de_caisse", zone: "carrosserie", label: "Bas de caisse", prix: 104 },
  { id: "capot_calandre", zone: "carrosserie", label: "Capot / calandre", prix: 201.5 },
  { id: "porte_laterale", zone: "carrosserie", label: "Porte latérale", prix: 1457.3 },
  { id: "trappe_carburant", zone: "carrosserie", label: "Trappe carburant", prix: 78 },
  // OPTIQUES
  { id: "veilleuse", zone: "optiques", label: "Veilleuse — cassée", prix: 31.2 },
  { id: "feu_de_plaque", zone: "optiques", label: "Feu de plaque", prix: 66.71 },
  { id: "ampoule", zone: "optiques", label: "Ampoule", prix: 13 },
  // ROUES
  { id: "enjoliveur", zone: "roues", label: "Enjoliveur — cassé ou manquant", prix: 65 },
  { id: "cale_roue", zone: "roues", label: "Cale de roue — l'unité", prix: 66.3 },
  { id: "kit_crevaison", zone: "roues", label: "Kit crevaison — manquant", prix: 65 },
  // INTÉRIEUR / ÉQUIPEMENT
  { id: "antenne_autoradio", zone: "interieur", label: "Antenne autoradio", prix: 9.08 },
  { id: "aerateurs", zone: "interieur", label: "Ventilation / aérateurs", prix: 78 },
  { id: "documents_bord", zone: "interieur", label: "Documents de bord — manquants", prix: 39 },
  { id: "gilet_securite", zone: "interieur", label: "Gilet de sécurité — manquant", prix: 11.7 },
  { id: "triangle_secu", zone: "interieur", label: "Triangle — manquant", prix: 13 },
  { id: "plan_travail", zone: "interieur", label: "Plan de travail — cassé (MO 97,50 € en sus)", prix: 560.49 },
  { id: "tiroir_meuble", zone: "interieur", label: "Tiroir meuble plan de travail", prix: 39 },
  { id: "meuble_bacs", zone: "interieur", label: "Meuble à bacs — cassé (MO 97,50 € en sus)", prix: 393.12 },
  { id: "lampe_travail", zone: "interieur", label: "Lampe de travail", prix: 39 },
  { id: "garniture", zone: "interieur", label: "Garniture", prix: 634.4 },
  { id: "seuil_porte", zone: "interieur", label: "Seuil de porte (MO 32,50 € en sus)", prix: 9.36 },
  { id: "doseur_savon", zone: "interieur", label: "Équipement propreté — doseur savon", prix: 25.35 },
  { id: "porte_jerrycan", zone: "interieur", label: "Équipement propreté — porte jerrycan", prix: 44.07 },
  { id: "derouleur_papier", zone: "interieur", label: "Équipement propreté — dérouleur papier", prix: 25.4 },
  { id: "montage_proprete", zone: "interieur", label: "Équipement propreté — montage (par pièce)", prix: 65 },
  { id: "camera_recul", zone: "interieur", label: "Caméra de recul (MO 195 € en sus)", prix: 192.07 },
  { id: "capteur_recul", zone: "interieur", label: "Capteur de recul (MO 130 € en sus)", prix: 96.52 },
  { id: "bouton_fre", zone: "interieur", label: "Bouton FRE", prix: 35.1 },
  { id: "bouton_pto", zone: "interieur", label: "Bouton PTO", prix: 35.1 },
  // NACELLE
  { id: "poste_bas", zone: "nacelle", label: "Poste bas — cassé", prix: 858 },
  { id: "poste_haut", zone: "nacelle", label: "Poste haut — cassé", prix: 156 },
  { id: "contact_clef", zone: "nacelle", label: "Contact bas + clef", prix: 54.36 },
  { id: "capteur_devers", zone: "nacelle", label: "Capteur de dévers", prix: 863.25 },
  { id: "porte_panier", zone: "nacelle", label: "Porte panier", prix: 422.55 },
  { id: "bouton_pompe_secours", zone: "nacelle", label: "Bouton pompe de secours", prix: 39 },
  { id: "bandeau", zone: "nacelle", label: "Bandeau — cassé / tordu", prix: 4548.7 },
  { id: "feux_plateforme", zone: "nacelle", label: "Feux plateforme (MO comprise)", prix: 312 },
  { id: "veilleuse_plateforme", zone: "nacelle", label: "Veilleuse plateforme", prix: 31.2 },
  { id: "carter_pompe_secours", zone: "nacelle", label: "Carter pompe secours", prix: 1206.75 },
  { id: "consigne_securite", zone: "nacelle", label: "Consigne de sécurité 120/200 kg", prix: 85.8 },
  { id: "reflecto_panier", zone: "nacelle", label: "Réflecteur panier", prix: 85.8 },
  { id: "joystick", zone: "nacelle", label: "Joystick", prix: 130 },
  { id: "bouton_stabilisateur", zone: "nacelle", label: "Bouton stabilisateur", prix: 133.9 },
  { id: "stabilisateur", zone: "nacelle", label: "Stabilisateur", prix: 133.9 },
  { id: "plaque_repartition", zone: "nacelle", label: "Plaque de répartition", prix: 119.37 },
  { id: "fourreau_stabilisateur", zone: "nacelle", label: "Fourreau stabilisateur", prix: 637.81 },
  // DIVERS
  { id: "destickage", zone: "nettoyage", label: "Destickage", prix: 89.7 },
  { id: "forfait_plaquette", zone: "nettoyage", label: "Forfait plaquette", prix: 180 },
  { id: "frais_administratifs", zone: "nettoyage", label: "Frais administratifs", prix: 60 },
];

// ─── Barème de vétusté et calculs partagés (identiques à src/App.jsx) ───
// Utilisés par les fonctions serveur ET pour produire le résumé d'expertise
// stocké sur le dossier (expertise_resume), consommé par Delta VO.

export const VETUSTE = [
  { annee: 1, taux: 0 }, { annee: 2, taux: 0 }, { annee: 3, taux: -20 }, { annee: 4, taux: -25 },
  { annee: 5, taux: -30 }, { annee: 6, taux: -35 }, { annee: 7, taux: -40 }, { annee: 8, taux: -45 },
  { annee: 9, taux: -50 }, { annee: 10, taux: -55 },
];

export function getVetuste(annee_fab) {
  if (!annee_fab) return 0;
  let annee = annee_fab;
  if (String(annee_fab).includes("/")) {
    const parts = String(annee_fab).split("/");
    annee = parts[parts.length - 1];
  }
  const age = new Date().getFullYear() - parseInt(annee);
  if (!Number.isFinite(age) || age <= 0) return 0;
  const v = VETUSTE.find((v) => v.annee === Math.min(age, 10));
  return v ? v.taux : (age >= 10 ? -55 : 0);
}

export const prixAvecVetuste = (prix, taux) => (prix ? Math.round(prix * (1 + taux / 100)) : 0);

/**
 * Résumé d'expertise stocké sur le dossier (champ expertise_resume) :
 * dégâts avec libellés et montants calculés, total retenue HT (provisoire si
 * des postes sont en attente de devis), vétusté. Produit à la validation de
 * l'expertise (App.jsx) et RECALCULÉ à chaque chiffrage atelier (api/devis).
 * Delta VO le copie tel quel dans machines_vo.rapport_expertise.
 */
export function buildExpertiseResume(d, tarifs) {
  const info = (d && d.info) || {};
  const retour = (d && d.retour) || {};
  const ids = Array.isArray(retour.degats) ? retour.degats : [];
  const quantites = retour.quantites || {};
  const md = retour.montants_devis || {};
  const recu = (d && d.devis_recu) || {};
  const taux = getVetuste(info.annee_fab);

  let total = 0;
  let nbAttente = 0;
  const degats = ids.map((id) => {
    const t = tarifs.find((x) => x.id === id) || null;
    const label = (t && t.label) || (recu[id] && recu[id].label) || id;
    const q = Number(quantites[id]) || 1;
    const surDevis = t ? !!t.surDevis : (md[id] != null || !!recu[id]);
    let montant;
    let description = label + (q > 1 ? " × " + q : "");
    if (surDevis) {
      montant = Number(md[id]) || Number(recu[id] && recu[id].montant) || 0;
      if (!montant) { nbAttente++; description += " — en attente de devis"; }
      else if (recu[id] && recu[id].reference) description += " (réf. " + recu[id].reference + ")";
    } else {
      montant = prixAvecVetuste((t && t.prix) || 0, taux) * q;
    }
    total += montant;
    return { zone: (t && t.zone) || "", description, montant };
  });

  return {
    date_expertise: retour.date || "",
    agent: retour.agent || "",
    heures_nacelle: Number(retour.heures) || 0,
    km_porteur: Number(retour.km_porteur) || 0,
    taux_vetuste: taux,
    degats,
    total_retenue_ht: total,
    notes: retour.note || "",
    nb_attente: nbAttente,
  };
}
