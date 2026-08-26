// Rapport de restitution d'un dossier — Nacelle Expert.
//   GET /api/rapport/{IMMAT}
//
// - Dossier SANS poste sur devis : redirection vers le PDF généré à la
//   validation de l'expertise (comportement historique, inchangé).
// - Dossier AVEC postes sur devis : le PDF est FIGÉ au moment de l'expertise
//   (« SUR DEVIS », total provisoire) alors que l'atelier chiffre APRÈS.
//   On rend donc une page HTML à jour depuis Firestore : montants chiffrés
//   (référence de devis incluse), total provisoire ou définitif, et lien vers
//   le PDF complet pour le détail photos.
//
// PRÉREQUIS : variable d'environnement Vercel FIREBASE_SERVICE_ACCOUNT.

import admin from "firebase-admin";
import { DEFAULT_TARIFS, getVetuste, prixAvecVetuste } from "../../_tarifs-defaults.js";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const esc = (s) => String(s ?? "—").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));
const eur = (n) => Number(n || 0).toLocaleString("fr-FR");
const frDate = (iso) => {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || "");
};

export default async function handler(req, res) {
  try {
    // /api/rapport/GP-549-BA → ["api","rapport","GP-549-BA"]
    const path = (req.url || "").split("?")[0];
    const parts = path.split("/").filter(Boolean);
    const immat = decodeURIComponent(req.query.immat || parts[2] || "").toUpperCase().trim();

    if (!immat) {
      res.status(400).send("Immatriculation manquante.");
      return;
    }

    const db = admin.firestore();
    const snap = await db.collection("dossiers").doc(immat).get();
    if (!snap.exists) {
      res.status(404).send("Dossier introuvable : " + immat);
      return;
    }
    const d = snap.data();
    const pdfUrl = (d.retour && d.retour.pdf_url) || d.rapport_url || null;

    // Dossier concerné par le workflow devis ? (postes en attente, chiffrés,
    // ou devis complet). Sinon : comportement historique, redirection PDF.
    const hasDevisWorkflow =
      (Array.isArray(d.devis_pending) && d.devis_pending.length > 0) ||
      (d.devis_recu && Object.keys(d.devis_recu).length > 0) ||
      d.devis_complet === true;

    if (!hasDevisWorkflow || !d.retour) {
      if (!pdfUrl) {
        res.status(404).send("Rapport non disponible pour " + immat + ".");
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.statusCode = 302;
      res.setHeader("Location", pdfUrl);
      res.end();
      return;
    }

    // ───────── Page HTML à jour (montants relus de Firestore) ─────────
    const tarifsSnap = await db.collection("config").doc("tarifs").get();
    const tarifsCfg = (tarifsSnap.exists && Array.isArray(tarifsSnap.data().data)) ? tarifsSnap.data().data : [];
    // ⚠ Tant qu'aucun admin n'a modifié les postes, config/tarifs n'existe pas
    // dans Firestore : on retombe sur le barème par défaut de l'application.
    const tarifs = tarifsCfg.length ? tarifsCfg : DEFAULT_TARIFS;
    const tarifOf = (id) => tarifs.find((t) => t.id === id) || null;

    const info = d.info || {};
    const retour = d.retour || {};
    const degats = Array.isArray(retour.degats) ? retour.degats : [];
    const quantites = retour.quantites || {};
    const md = retour.montants_devis || {};
    const tranches = retour.tranches_devis || {};
    const recu = d.devis_recu || {};
    const taux = getVetuste(info.annee_fab);

    // Photos des dégâts (mêmes données que la page de chiffrage atelier)
    const photosOf = (id) => {
      const arr = (retour.photos && retour.photos["degat_" + id]) || [];
      return arr.map((p) => p && p.url).filter(Boolean);
    };

    let total = 0;
    let nbAttente = 0;
    const rows = degats.map((id) => {
      const t = tarifOf(id);
      // Libellé : tarif connu → son label ; sinon label mémorisé au chiffrage ; sinon id brut
      const label = (t && t.label) || (recu[id] && recu[id].label) || id;
      const q = Number(quantites[id]) || 1;
      const tranche = tranches[id] && tranches[id] !== "__LIBRE__" ? tranches[id] : "";
      // Poste « sur devis » : tarif connu → son flag ; tarif inconnu (supprimé
      // du barème depuis) → on se fie aux montants devis présents sur le dossier
      const surDevis = t ? !!t.surDevis : (md[id] != null || !!recu[id]);
      let montantHtml;
      if (surDevis) {
        const m = Number(md[id]) || Number(recu[id] && recu[id].montant) || 0;
        if (recu[id] && recu[id].inclus) {
          // Devis GLOBAL de l'atelier : le montant est porté par le premier
          // poste du groupe, celui-ci est couvert par le même devis.
          const ref = recu[id].reference ? ` <span style="color:#888;font-weight:400;">· réf. ${esc(recu[id].reference)}</span>` : "";
          montantHtml = `<span style="color:#1a2a6e;font-weight:700;">Inclus au devis</span>${ref}`;
        } else if (m > 0) {
          total += m;
          const ref = recu[id] && recu[id].reference ? ` <span style="color:#888;font-weight:400;">· réf. ${esc(recu[id].reference)}</span>` : "";
          montantHtml = `<b>${eur(m)} €</b>${ref}`;
        } else {
          nbAttente++;
          montantHtml = `<span style="color:#b3541e;font-weight:700;">⏳ En attente de devis</span>`;
        }
      } else {
        const unit = prixAvecVetuste((t && t.prix) || 0, taux);
        const m = unit * q;
        total += m;
        montantHtml = q > 1 ? `${q} × ${eur(unit)} € = <b>${eur(m)} €</b>` : `<b>${eur(m)} €</b>`;
      }
      const photos = photosOf(id).map((u) =>
        `<a href="${esc(u)}" target="_blank"><img src="${esc(u)}" alt="" style="width:86px;height:64px;object-fit:cover;border:1px solid #ccd;border-radius:4px;margin:2px;"></a>`
      ).join("");
      return `<tr style="${photos ? "" : "border-bottom:1px solid #e4e7f0;"}">
        <td style="padding:8px 10px;">${esc(label)}${tranche ? ` <span style="color:#888;font-size:12px;">(${esc(tranche)})</span>` : ""}${q > 1 ? ` <span style="color:#1a2a6e;font-weight:700;">× ${q}</span>` : ""}</td>
        <td style="padding:8px 10px;text-align:right;white-space:nowrap;">${montantHtml}</td>
      </tr>${photos ? `<tr style="border-bottom:1px solid #e4e7f0;"><td colspan="2" style="padding:0 10px 8px;">${photos}</td></tr>` : ""}`;
    }).join("");

    const definitif = nbAttente === 0;
    const valide = d.devis_valide || null;

    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Rapport de restitution · Nacelle ${esc(immat)}</title>
<style>@media print{.no-print{display:none!important;}body{background:#fff!important;}a{text-decoration:none;color:inherit;}}</style></head>
<body style="margin:0;font-family:Arial,sans-serif;background:#f0f2f5;">
<div style="max-width:640px;margin:0 auto;padding:20px;">
  <div style="background:#1a2a6e;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0;">
    <div style="font-size:11px;letter-spacing:2px;">DELTA SERVICES · NACELLE EXPERT</div>
    <h2 style="margin:6px 0 0;">Rapport de restitution ${definitif ? "définitif" : "provisoire"} · Nacelle ${esc(immat)}</h2>
  </div>
  <div style="background:#fff;padding:18px 22px;border:1px solid #d8dbe6;border-top:none;">
    <table style="font-size:14px;border-collapse:collapse;">
      <tr><td style="color:#888;padding:3px 14px 3px 0;">Nacelle</td><td><b>${esc(info.type_nacelle || "—")} ${esc(info.modele || "")}</b></td></tr>
      <tr><td style="color:#888;padding:3px 14px 3px 0;">Client</td><td>${esc(info.client || "—")}${info.contrat ? ` (contrat ${esc(info.contrat)})` : ""}</td></tr>
      <tr><td style="color:#888;padding:3px 14px 3px 0;">Date de retour</td><td>${esc(frDate(retour.date))}</td></tr>
      ${retour.lieu_restitution ? `<tr><td style="color:#888;padding:3px 14px 3px 0;">Lieu de restitution</td><td>${esc(retour.lieu_restitution)}</td></tr>` : ""}
      ${retour.agent ? `<tr><td style="color:#888;padding:3px 14px 3px 0;">Expert</td><td>${esc(retour.agent)}</td></tr>` : ""}
      ${retour.heures ? `<tr><td style="color:#888;padding:3px 14px 3px 0;">Heures au retour</td><td>${esc(retour.heures)} h</td></tr>` : ""}
      ${retour.km_porteur ? `<tr><td style="color:#888;padding:3px 14px 3px 0;">Km porteur</td><td>${esc(retour.km_porteur)} km</td></tr>` : ""}
    </table>

    <h3 style="color:#1a2a6e;border-bottom:2px solid #1a2a6e;padding-bottom:6px;margin:20px 0 0;">Dégâts retenus</h3>
    ${degats.length
      ? `<table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>`
      : `<p style="color:#208040;font-weight:600;">✓ Aucun dégât — nacelle rendue conforme</p>`}
    ${taux !== 0 ? `<div style="font-size:12px;color:#888;margin-top:8px;">Taux de vétusté appliqué : ${taux}% (hors postes sur devis)</div>` : ""}
    ${!definitif ? `<div style="margin-top:10px;padding:10px 14px;background:#fdf3ec;border:1px solid #e8c9a8;border-radius:6px;font-size:13px;font-weight:600;color:#b3541e;">⏳ Devis atelier en attente (${nbAttente} poste${nbAttente > 1 ? "s" : ""}) — un seul devis global, le montant définitif sera communiqué après chiffrage.</div>` : ""}

    <div style="display:flex;justify-content:space-between;align-items:center;background:#1a2a6e;color:#fff;padding:12px 18px;margin-top:14px;border-radius:4px;">
      <span style="font-size:12px;letter-spacing:2px;font-weight:700;">${definitif ? "TOTAL RETENUE HT" : "TOTAL PROVISOIRE HT"}</span>
      <span style="font-size:26px;font-weight:700;">${eur(total)} €</span>
    </div>
    ${valide ? `<div style="font-size:12px;color:#1e7e46;margin-top:8px;">✓ Devis validé${valide.par ? ` par ${esc(valide.par)}` : ""}${valide.date ? ` le ${esc(frDate(valide.date))}` : ""}.</div>` : ""}
    ${retour.note ? `<div style="margin-top:14px;font-size:13px;"><b style="color:#1a2a6e;">Notes de l'expert :</b> ${esc(retour.note)}</div>` : ""}

    <div class="no-print" style="margin-top:22px;display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
      <a href="javascript:window.print()" style="background:#1a2a6e;color:#fff;padding:10px 22px;text-decoration:none;font-weight:bold;border-radius:4px;">&#128424; Télécharger / imprimer en PDF</a>
      ${pdfUrl ? `<a href="${esc(pdfUrl)}" style="background:#fff;color:#1a2a6e;border:1px solid #1a2a6e;padding:9px 22px;text-decoration:none;font-weight:bold;border-radius:4px;">&#128196; Expertise signée${retour.date ? ` du ${esc(frDate(retour.date))}` : ""}</a>` : ""}
    </div>
    ${pdfUrl ? `<p class="no-print" style="font-size:11px;color:#999;margin-top:8px;">L'expertise signée est le document d'origine (état complet, photos, signatures), édité le jour de la restitution — avant chiffrage des postes sur devis. Les montants du présent rapport font foi.</p>` : ""}
  </div>
  <div style="font-size:11px;color:#999;padding:10px 4px;">Delta Services · 14 Avenue James de Rothschild · 77164 Ferrières-en-Brie · Tél. +33 (0)1 60 95 47 80</div>
</div>
</body></html>`;

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (e) {
    console.error("api/rapport:", e);
    res.status(500).send("Erreur serveur.");
  }
}
