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
import { DEFAULT_TARIFS } from "../../_tarifs-defaults.js";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

// ⚠ Barème de vétusté et calculs identiques à src/App.jsx (getVetuste,
// prixAvecVetuste, montantPoste) — à maintenir en phase si le barème change.
const VETUSTE = [
  { annee: 1, taux: 0 }, { annee: 2, taux: 0 }, { annee: 3, taux: -20 }, { annee: 4, taux: -25 },
  { annee: 5, taux: -30 }, { annee: 6, taux: -35 }, { annee: 7, taux: -40 }, { annee: 8, taux: -45 },
  { annee: 9, taux: -50 }, { annee: 10, taux: -55 },
];

function getVetuste(annee_fab) {
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

const prixAvecVetuste = (prix, taux) => (prix ? Math.round(prix * (1 + taux / 100)) : 0);

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
        if (m > 0) {
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
      return `<tr style="border-bottom:1px solid #e4e7f0;">
        <td style="padding:8px 10px;">${esc(label)}${tranche ? ` <span style="color:#888;font-size:12px;">(${esc(tranche)})</span>` : ""}${q > 1 ? ` <span style="color:#1a2a6e;font-weight:700;">× ${q}</span>` : ""}</td>
        <td style="padding:8px 10px;text-align:right;white-space:nowrap;">${montantHtml}</td>
      </tr>`;
    }).join("");

    const definitif = nbAttente === 0;
    const valide = d.devis_valide || null;

    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Rapport de restitution · Nacelle ${esc(immat)}</title></head>
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
    </table>

    <h3 style="color:#1a2a6e;border-bottom:2px solid #1a2a6e;padding-bottom:6px;margin:20px 0 0;">Dégâts retenus</h3>
    ${degats.length
      ? `<table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>`
      : `<p style="color:#208040;font-weight:600;">✓ Aucun dégât — nacelle rendue conforme</p>`}
    ${taux !== 0 ? `<div style="font-size:12px;color:#888;margin-top:8px;">Taux de vétusté appliqué : ${taux}% (hors postes sur devis)</div>` : ""}
    ${!definitif ? `<div style="margin-top:10px;padding:10px 14px;background:#fdf3ec;border:1px solid #e8c9a8;border-radius:6px;font-size:13px;font-weight:600;color:#b3541e;">⏳ ${nbAttente} poste${nbAttente > 1 ? "s" : ""} en attente de devis — le montant définitif sera communiqué après chiffrage.</div>` : ""}

    <div style="display:flex;justify-content:space-between;align-items:center;background:#1a2a6e;color:#fff;padding:12px 18px;margin-top:14px;border-radius:4px;">
      <span style="font-size:12px;letter-spacing:2px;font-weight:700;">${definitif ? "TOTAL RETENUE HT" : "TOTAL PROVISOIRE HT"}</span>
      <span style="font-size:26px;font-weight:700;">${eur(total)} €</span>
    </div>
    ${valide ? `<div style="font-size:12px;color:#1e7e46;margin-top:8px;">✓ Devis validé${valide.par ? ` par ${esc(valide.par)}` : ""}${valide.date ? ` le ${esc(frDate(valide.date))}` : ""}.</div>` : ""}

    ${pdfUrl ? `<p style="margin-top:20px;"><a href="${esc(pdfUrl)}" style="background:#1a2a6e;color:#fff;padding:10px 22px;text-decoration:none;font-weight:bold;border-radius:4px;">&#128196; Rapport d'expertise complet (photos)</a></p>
    <p style="font-size:11px;color:#999;">Le PDF détaille l'état de la machine et les photos. Les montants ci-dessus font foi${definitif ? "" : " une fois le chiffrage terminé"} : le PDF a pu être édité avant le chiffrage des postes sur devis.</p>` : ""}
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
