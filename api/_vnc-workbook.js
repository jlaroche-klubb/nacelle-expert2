// Construction du FICHIER DU PARC AU FORMAT VOG — partagé entre le cron
// d'envoi à la compta (/api/cron-vnc-compta) et le lien de téléchargement
// (/api/vnc-fichier). Fichier préfixé « _ » : non exposé comme endpoint.
//
// ⚠ MÊMES colonnes que l'« Export parc (VOG) » de Delta VO
// (src/utils/importVnc.ts, buildVogRow) : le fichier se réimporte tel quel
// via « Import du stock VOG ». À maintenir en phase si le format évolue.

import * as XLSX from "xlsx";

// 📅 Colonnes date : vraies cellules Excel au format français jj/mm/aaaa
const VOG_DATE_COLS = ["Data ajout vog", "Date de mise en service", "Date prix de vente"];

/** "2026-08-05" ou "05/08/2026" → Date Excel ; sinon la valeur brute (texte) */
function toExcelDate(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return s;
}

export function buildVogWorkbook(machinesDocs) {
  const rows = [];
  machinesDocs.forEach((d) => {
    const m = d.data();
    if (m.archived) return;
    const mp = String(m.modele || "").trim();
    const marque = mp.split(" ")[0] || "";
    const porteur = mp.split(" ").slice(1).join(" ");
    rows.push({
      "Dossier Delta ou KLUBB France": m.numero_dossier || "",
      "N° OCCASION": m.numero_occasion || "", // vide = à attribuer par l'ADV
      "Propriétaire": m.proprietaire || "",
      "Fiche d'occasion": m.fiche_occasion_vog || "",
      "Data ajout vog": toExcelDate(m.date_ajout_vog),
      "Carte grise": m.carte_grise_vog || "",
      "VL / PL /TR": m.categorie_vehicule || "",
      "N° de cube": m.numero_cube || "",
      "IMMAT": m.immat || d.id,
      "Vérification HISTOVEC": m.histovec || "",
      "N° de châssis": m.num_chassis || "",
      "Etat général extérieur": m.etat_exterieur || "",
      "Etat de la nacelle": m.etat_nacelle_vog || "",
      "Etat": m.etat_note_vog || "",
      "Date de mise en service": toExcelDate(m.date_mise_en_service),
      "Année de mise en service": m.annee_fab || "",
      "Marque porteur": marque,
      "Porteur": porteur,
      "Type nacelle": m.type_nacelle || "",
      "KM porteur": m.km_porteur ?? (m.km_note || ""),
      "Heures de la nacelle": m.heures ?? (m.heures_note || ""),
      "Lieu de stockage du véhicule": m.localite || "",
      // 💶 Retenue d'expertise (aide à la décision de prix du PDG)
      "Montant expertise VO (€)": (m.rapport_expertise && m.rapport_expertise.total_retenue_ht) ?? "",
      "PRIX DE VENTE HT": m.prix_fr ?? "", // ← rempli / révisé par le PDG
      "Date prix de vente": toExcelDate(m.prix_modifie_le || m.date_prix_vog),
      "VR OU VNC EUR": m.vr_vnc ?? "", // ← rempli / mis à jour par la COMPTA
      "Mascus": (m.diffusion && m.diffusion.mascus) || "",
      "ViaMobilis": (m.diffusion && m.diffusion.viamobilis) || "",
      "Site Delta": (m.diffusion && m.diffusion.site_delta) || "",
      "Klubb.com": (m.diffusion && m.diffusion.klubb_com) || "",
      "Klubb France": (m.diffusion && m.diffusion.klubb_france) || "",
      "LOT": (m.diffusion && m.diffusion.lot) || "",
    });
  });
  rows.sort((a, b) => String(a["N° OCCASION"]).localeCompare(String(b["N° OCCASION"]), "fr", { numeric: true }));

  const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true });
  ws["!cols"] = Object.keys(rows[0] || {}).map((k) => ({ wch: Math.max(12, Math.min(24, k.length + 2)) }));
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  for (let C = range.s.c; C <= range.e.c; C++) {
    const header = ws[XLSX.utils.encode_cell({ r: 0, c: C })] && ws[XLSX.utils.encode_cell({ r: 0, c: C })].v;
    if (!VOG_DATE_COLS.includes(String(header))) continue;
    for (let R = 1; R <= range.e.r; R++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (cell && cell.v instanceof Date) { cell.t = "d"; cell.z = "dd/mm/yyyy"; }
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Liste complète");
  return { buffer: XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellDates: true }), count: rows.length };
}
