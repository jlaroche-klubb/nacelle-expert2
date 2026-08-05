// Page de saisie du DEVIS par l'atelier Nacelle Assistance — Nacelle Expert.
//
//   GET  /api/devis/{IMMAT}?cle={jeton}  → formulaire de chiffrage (accès provisoire)
//   POST /api/devis/{IMMAT}              → enregistrement des montants (jeton dans le corps)
//
// Accès SANS compte, par lien à jeton unique :
// - le jeton est généré à la validation de l'expertise retour (dossier « En attente de devis »)
// - il ne donne accès qu'à CE dossier, et uniquement à la saisie des montants
//   des postes en attente (jamais aux photos/expertise en modification)
// - validité : 30 jours après émission
//
// PRÉREQUIS : variable d'environnement Vercel FIREBASE_SERVICE_ACCOUNT.

import admin from "firebase-admin";
import { DEFAULT_TARIFS, buildExpertiseResume } from "../_tarifs-defaults.js";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const TOKEN_VALIDITY_DAYS = 30;

const esc = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));

function checkToken(d, cle) {
  if (!d.devis_token || !cle || d.devis_token !== cle) return "Lien invalide ou expiré.";
  if (d.devis_token_created) {
    const age = Date.now() - new Date(d.devis_token_created).getTime();
    if (age > TOKEN_VALIDITY_DAYS * 24 * 3600 * 1000) return "Ce lien a expiré (plus de " + TOKEN_VALIDITY_DAYS + " jours). Contactez Delta Services.";
  }
  return null;
}

export default async function handler(req, res) {
  try {
    const path = (req.url || "").split("?")[0];
    const parts = path.split("/").filter(Boolean);
    const immat = decodeURIComponent(req.query.immat || parts[2] || "").toUpperCase().trim();
    if (!immat) { res.status(400).send("Immatriculation manquante."); return; }

    const db = admin.firestore();
    const snap = await db.collection("dossiers").doc(immat).get();
    if (!snap.exists) { res.status(404).send("Dossier introuvable : " + immat); return; }
    const d = snap.data();

    // Tarifs (libellés des postes)
    // ⚠ Tant qu'aucun admin n'a modifié les postes, config/tarifs n'existe pas
    // dans Firestore : on retombe sur le barème par défaut de l'application.
    const tarifsSnap = await db.collection("config").doc("tarifs").get();
    const tarifsCfg = (tarifsSnap.exists && Array.isArray(tarifsSnap.data().data)) ? tarifsSnap.data().data : [];
    const tarifs = tarifsCfg.length ? tarifsCfg : DEFAULT_TARIFS;
    const labelOf = (id) => (tarifs.find((t) => t.id === id) || {}).label || id;

    // ───────────────────────── POST : enregistrement ─────────────────────────
    if (req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const err = checkToken(d, b.cle);
      if (err) { res.status(403).json({ error: err }); return; }

      const pending = Array.isArray(d.devis_pending) ? d.devis_pending : [];
      if (!pending.length) { res.status(400).json({ error: "Ce dossier n'est plus en attente de devis." }); return; }

      const entries = b.montants || {}; // { tarifId: { montant, reference } }
      const updates = {};
      const devisRecu = { ...(d.devis_recu || {}) };
      let saisis = 0;
      for (const id of pending) {
        const e = entries[id];
        const montant = e && Number(e.montant);
        if (montant && montant > 0) {
          devisRecu[id] = {
            montant: Math.round(montant),
            reference: String(e.reference || "").slice(0, 80),
            date: new Date().toISOString(),
            // Libellé mémorisé avec le chiffrage : affiché tel quel par le
            // rapport client et par Delta VO (bandeau secrétaire)
            label: labelOf(id),
          };
          updates[`retour.montants_devis.${id}`] = Math.round(montant);
          saisis++;
        }
      }
      if (!saisis) { res.status(400).json({ error: "Aucun montant saisi." }); return; }

      const resteEnAttente = pending.filter((id) => !devisRecu[id]);
      updates.devis_recu = devisRecu;
      updates.devis_pending = resteEnAttente;
      updates.devis_pending_labels = resteEnAttente.map(labelOf);
      updates.devis_complet = resteEnAttente.length === 0;
      updates.synced_to_delta_vo = false; // Delta VO récupère la mise à jour (badge secrétaire)
      updates.updatedAt = new Date().toISOString();

      // 💶 Résumé d'expertise recalculé avec les nouveaux montants (total
      // retenue à jour) — copié tel quel par Delta VO (secrétaires/commerciaux)
      const mdMerged = { ...((d.retour && d.retour.montants_devis) || {}) };
      for (const id of Object.keys(devisRecu)) mdMerged[id] = Number(devisRecu[id].montant) || mdMerged[id];
      updates.expertise_resume = buildExpertiseResume(
        { ...d, devis_recu: devisRecu, retour: { ...(d.retour || {}), montants_devis: mdMerged } },
        tarifs
      );

      await db.collection("dossiers").doc(immat).update(updates);
      res.status(200).json({ ok: true, complet: resteEnAttente.length === 0, restants: resteEnAttente.length });
      return;
    }

    // ───────────────────────── GET : formulaire ─────────────────────────
    const cle = String(req.query.cle || "");
    const err = checkToken(d, cle);
    if (err) { res.status(403).send(`<html><body style="font-family:Arial;padding:40px;text-align:center;"><h2>⛔ ${esc(err)}</h2></body></html>`); return; }

    const pending = Array.isArray(d.devis_pending) ? d.devis_pending : [];
    const recu = d.devis_recu || {};
    const info = d.info || {};
    const lieu = (d.retour && d.retour.lieu_restitution) || "—";
    const expert = (d.retour && d.retour.agent) || "—";
    const photosOf = (id) => {
      const arr = (d.retour && d.retour.photos && d.retour.photos["degat_" + id]) || [];
      return arr.map((p) => p && p.url).filter(Boolean);
    };

    const rows = pending.map((id) => {
      const done = recu[id];
      const photos = photosOf(id).map((u) => `<a href="${esc(u)}" target="_blank"><img src="${esc(u)}" style="width:90px;height:68px;object-fit:cover;border:1px solid #ccc;border-radius:4px;margin:2px;"></a>`).join("");
      return `
      <div style="border:1px solid #d8dbe6;border-radius:8px;padding:14px;margin-bottom:14px;background:#fff;">
        <div style="font-weight:700;color:#1a2a6e;margin-bottom:6px;">${esc(labelOf(id))}</div>
        ${photos ? `<div style="margin-bottom:8px;">${photos}</div>` : ""}
        ${done
          ? `<div style="color:#1e7e46;font-weight:700;">✓ Déjà chiffré : ${done.montant.toLocaleString("fr-FR")} € HT${done.reference ? " · réf. " + esc(done.reference) : ""}</div>`
          : `<div style="display:flex;gap:10px;flex-wrap:wrap;">
              <label style="font-size:13px;">Montant € HT *<br><input type="number" min="1" step="1" name="montant_${esc(id)}" style="width:130px;padding:8px;border:1px solid #ccd;border-radius:4px;font-size:15px;"></label>
              <label style="font-size:13px;">Référence du devis<br><input type="text" name="reference_${esc(id)}" placeholder="DEV-2026-..." style="width:180px;padding:8px;border:1px solid #ccd;border-radius:4px;font-size:15px;"></label>
            </div>`}
      </div>`;
    }).join("");

    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Devis · Nacelle ${esc(immat)}</title></head>
<body style="margin:0;font-family:Arial,sans-serif;background:#f0f2f5;">
<div style="max-width:640px;margin:0 auto;padding:20px;">
  <div style="background:#1a2a6e;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0;">
    <div style="font-size:11px;letter-spacing:2px;">DELTA SERVICES · NACELLE EXPERT</div>
    <h2 style="margin:6px 0 0;">Devis à chiffrer · Nacelle ${esc(immat)}</h2>
  </div>
  <div style="background:#fff;padding:18px 22px;border:1px solid #d8dbe6;border-top:none;">
    <table style="font-size:14px;border-collapse:collapse;">
      <tr><td style="color:#888;padding:3px 14px 3px 0;">Nacelle</td><td><b>${esc(info.type_nacelle || "—")} ${esc(info.modele || "")}</b></td></tr>
      <tr><td style="color:#888;padding:3px 14px 3px 0;">Lieu de stockage</td><td><b>📍 ${esc(lieu)}</b></td></tr>
      <tr><td style="color:#888;padding:3px 14px 3px 0;">Expert</td><td><b>${esc(expert)}</b></td></tr>
      <tr><td style="color:#888;padding:3px 14px 3px 0;">Client</td><td>${esc(info.client || "—")} (contrat ${esc(info.contrat || "—")})</td></tr>
    </table>
    <p style="font-size:13px;color:#666;">Saisissez le montant HT de remise en état pour chaque poste ci-dessous, puis validez. Les montants seront intégrés à l'expertise et transmis pour validation.</p>
    <form id="f">${rows}
      <button type="submit" style="background:#1a2a6e;color:#fff;border:none;padding:12px 28px;border-radius:6px;font-size:16px;font-weight:700;cursor:pointer;">✓ Enregistrer le devis</button>
      <div id="msg" style="margin-top:12px;font-weight:700;"></div>
    </form>
  </div>
  <div style="font-size:11px;color:#999;padding:10px 4px;">Lien confidentiel réservé à l'atelier Nacelle Assistance · valable ${TOKEN_VALIDITY_DAYS} jours · Delta Services</div>
</div>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("msg");
  const montants = {};
  ${JSON.stringify(pending.filter((id) => !recu[id]))}.forEach((id) => {
    const m = document.querySelector('[name="montant_' + id + '"]');
    const r = document.querySelector('[name="reference_' + id + '"]');
    if (m && m.value) montants[id] = { montant: Number(m.value), reference: r ? r.value : "" };
  });
  if (!Object.keys(montants).length) { msg.style.color = "#c0392b"; msg.textContent = "Saisissez au moins un montant."; return; }
  msg.style.color = "#666"; msg.textContent = "⏳ Enregistrement...";
  try {
    const resp = await fetch(location.pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cle: ${JSON.stringify(cle)}, montants }),
    });
    const j = await resp.json();
    if (!resp.ok) throw new Error(j.error || resp.status);
    msg.style.color = "#1e7e46";
    msg.textContent = j.complet
      ? "✓ Devis complet enregistré — merci ! L'équipe Delta Services prend le relais. Vous pouvez fermer cette page."
      : "✓ Enregistré. Il reste " + j.restants + " poste(s) à chiffrer (ce lien reste valable).";
    if (j.complet) document.querySelectorAll("#f input,#f button").forEach((el) => el.disabled = true);
    else setTimeout(() => location.reload(), 1500);
  } catch (err) {
    msg.style.color = "#c0392b"; msg.textContent = "⚠ Échec : " + err.message;
  }
});
</script>
</body></html>`;

    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (e) {
    console.error("devis:", e);
    res.status(500).send("Erreur : " + e.message);
  }
}
