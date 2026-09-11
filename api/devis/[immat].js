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
import crypto from "crypto";
import { DEFAULT_TARIFS, buildExpertiseResume } from "../_tarifs-defaults.js";
import { jetonServeur, DELTA_VO_API } from "../_jeton-serveur.js";

// 🧾 DEVIS PDF + LECTURE IA (validé avec Jonathan, 11/09/2026) :
// Nacelle Assistance ne saisit plus les montants : elle DÉPOSE son devis
// (PDF ou photo) sur cette page. Le fichier est archivé dans le Storage du
// dossier, lu par l'IA (fonction Delta VO /api/lire-devis, jeton serveur),
// et les champs montant / référence sont PRÉ-REMPLIS — modifiables — avant
// « Valider et transmettre ». La validation finale reste à la secrétaire
// dans Delta VO, comme avant. Sans lecture possible : saisie manuelle.
const BUCKET = "nacelle-expert.firebasestorage.app";
const MAX_FICHIER_OCTETS = 3_000_000; // ≈ 4 Mo en base64 : sous la limite Vercel (4,5 Mo)

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

      // ── Étape 1 : dépôt du fichier + lecture IA (rien n'est écrit sur le devis) ──
      if (b.action === "lire") {
        const raw = String(b.fichier_base64 || "");
        const m = raw.match(/^data:([^;]+);base64,(.+)$/);
        const mime = (m ? m[1] : String(b.mime || "application/pdf")).toLowerCase();
        const data = m ? m[2] : raw;
        if (!data) { res.status(400).json({ error: "Fichier manquant." }); return; }
        const octets = Math.floor(data.length * 0.75);
        if (octets > MAX_FICHIER_OCTETS) { res.status(413).json({ error: "Fichier trop volumineux (max 3 Mo). Compressez le PDF ou saisissez le montant à la main." }); return; }
        const estPdf = mime === "application/pdf";
        const estImage = /^image\/(jpeg|jpg|png|webp)$/.test(mime);
        if (!estPdf && !estImage) { res.status(400).json({ error: "Format non pris en charge : déposez un PDF ou une photo (JPG/PNG)." }); return; }

        // Archivage dans le Storage du dossier (URL de téléchargement à jeton)
        const nomSur = String(b.nom || (estPdf ? "devis.pdf" : "devis.jpg")).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
        const chemin = `dossiers/${immat.replace(/[^A-Z0-9-]/gi, "_")}/devis/${Date.now()}_${nomSur}`;
        const token = crypto.randomUUID();
        await admin.storage().bucket(BUCKET).file(chemin).save(Buffer.from(data, "base64"), {
          metadata: { contentType: mime, metadata: { firebaseStorageDownloadTokens: token } },
        });
        const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(chemin)}?alt=media&token=${token}`;

        // Lecture IA via Delta VO (best-effort : sans lecture, saisie manuelle)
        let lecture = null;
        let erreurLecture = null;
        try {
          const jeton = await jetonServeur(admin, "lecture-devis");
          const r = await fetch(`${DELTA_VO_API}/lire-devis`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${jeton}` },
            body: JSON.stringify(estPdf ? { pdfBase64: data, immat, filename: nomSur } : { imageBase64: `data:${mime};base64,${data}`, immat, filename: nomSur }),
            signal: AbortSignal.timeout(55_000),
          });
          const j = await r.json().catch(() => null);
          if (r.ok && j?.ok) lecture = j;
          else erreurLecture = (j && j.error) || `lecture ${r.status}`;
        } catch (e) {
          erreurLecture = e?.message || String(e);
        }
        console.log(`🧾 devis ${immat} : fichier ${nomSur} (${Math.round(octets / 1024)} Ko) · lecture ${lecture ? `${lecture.montant_ht ?? "?"} € HT (${lecture.confiance})` : "échec : " + erreurLecture}`);
        res.status(200).json({ ok: true, pdf_url: url, nom: nomSur, lecture, erreur_lecture: erreurLecture });
        return;
      }

      // DEVIS GLOBAL (validé avec Jonathan) : quel que soit le nombre de postes,
      // l'atelier remet UN devis — un seul montant HT + une seule référence.
      // Le montant est porté par le premier poste du groupe ; les autres sont
      // marqués « inclus » (0 €) pour que le total ne soit jamais doublé.
      const updates = {};
      const devisRecu = { ...(d.devis_recu || {}) };
      const restants = pending.filter((id) => !devisRecu[id]);
      if (!restants.length) { res.status(400).json({ error: "Ce dossier n'est plus en attente de devis." }); return; }
      const montantGlobal = Math.round(Number(b.montant_global));
      if (!montantGlobal || montantGlobal <= 0) { res.status(400).json({ error: "Saisissez le montant total HT du devis." }); return; }
      const referenceGlobale = String(b.reference || "").slice(0, 80);
      const dateSaisie = new Date().toISOString();
      restants.forEach((id, i) => {
        devisRecu[id] = {
          montant: i === 0 ? montantGlobal : 0,
          inclus: i > 0, // couvert par le montant global porté par le 1er poste
          global: true,
          reference: referenceGlobale,
          date: dateSaisie,
          // Libellé mémorisé avec le chiffrage : affiché tel quel par le
          // rapport client et par Delta VO (bandeau secrétaire)
          label: labelOf(id),
        };
        updates[`retour.montants_devis.${id}`] = i === 0 ? montantGlobal : 0;
      });

      // 🧾 Devis PDF déposé (archivé à l'étape « lire ») + trace de la lecture IA
      if (b.pdf_url && /^https:\/\/firebasestorage\.googleapis\.com\//.test(String(b.pdf_url))) {
        updates.devis_pdf = {
          url: String(b.pdf_url),
          nom: String(b.pdf_nom || "devis.pdf").slice(0, 80),
          date: dateSaisie,
          lecture_ia: b.lecture_ia === true,
          confiance: b.confiance ? String(b.confiance).slice(0, 10) : null,
          fournisseur: b.fournisseur ? String(b.fournisseur).slice(0, 80) : null,
          montant_lu: Number(b.montant_lu) || null, // ce que l'IA avait lu (contrôle a posteriori)
        };
      }

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
    if (!pending.length) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(`<html><body style="font-family:Arial;padding:40px;text-align:center;"><h2 style="color:#1e7e46;">✓ Ce dossier n'est plus en attente de devis.</h2><p style="color:#666;">Le chiffrage a déjà été enregistré — merci ! Vous pouvez fermer cette page.</p></body></html>`);
      return;
    }
    const recu = d.devis_recu || {};
    const info = d.info || {};
    const lieu = (d.retour && d.retour.lieu_restitution) || "—";
    const expert = (d.retour && d.retour.agent) || "—";
    const photosOf = (id) => {
      const arr = (d.retour && d.retour.photos && d.retour.photos["degat_" + id]) || [];
      return arr.map((p) => p && p.url).filter(Boolean);
    };

    // UN devis global pour tous les postes : les cartes ne présentent que le
    // constat (libellé + photos), la saisie se fait en une fois sous la liste.
    const rows = pending.map((id) => {
      const photos = photosOf(id).map((u) => `<a href="${esc(u)}" target="_blank"><img src="${esc(u)}" style="width:90px;height:68px;object-fit:cover;border:1px solid #ccc;border-radius:4px;margin:2px;"></a>`).join("");
      return `
      <div style="border:1px solid #d8dbe6;border-radius:8px;padding:14px;margin-bottom:14px;background:#fff;">
        <div style="font-weight:700;color:#1a2a6e;margin-bottom:6px;">${esc(labelOf(id))}</div>
        ${photos ? `<div>${photos}</div>` : ""}
      </div>`;
    }).join("");
    const saisieGlobale = `
      <div style="border:2px solid #1a2a6e;border-radius:8px;padding:16px;margin-bottom:14px;background:#f4f6ff;">
        <div style="font-weight:700;color:#1a2a6e;margin-bottom:4px;">1 · Déposez votre devis (un seul devis pour l'ensemble des ${pending.length} poste${pending.length > 1 ? "s" : ""} ci-dessus)</div>
        <div style="font-size:12px;color:#556;margin-bottom:10px;">PDF de votre outil habituel, ou photo du devis. Le montant et la référence sont lus automatiquement — vous vérifiez, puis vous validez.</div>
        <label id="zone" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border:2px dashed #8b97c9;border-radius:8px;padding:22px;background:#fff;cursor:pointer;text-align:center;">
          <div style="font-size:28px;">📎</div>
          <div style="font-weight:700;color:#1a2a6e;">Cliquez ou glissez votre devis ici</div>
          <div style="font-size:12px;color:#889;">PDF, JPG ou PNG · 3 Mo max</div>
          <input type="file" id="fichier" accept="application/pdf,image/jpeg,image/png,image/webp" style="display:none">
        </label>
        <div id="etatFichier" style="margin-top:8px;font-size:13px;font-weight:700;"></div>
        <div id="lecture" style="display:none;margin-top:10px;padding:10px 12px;border-radius:6px;background:#eefaf2;border:1px solid #b5dfc4;font-size:13px;color:#1e5e36;"></div>

        <div style="font-weight:700;color:#1a2a6e;margin:18px 0 8px;">2 · Vérifiez et complétez</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap;">
          <label style="font-size:13px;">Montant total € HT *<br><input type="number" min="1" step="1" name="montant_global" style="width:150px;padding:8px;border:1px solid #ccd;border-radius:4px;font-size:16px;font-weight:700;"></label>
          <label style="font-size:13px;">Référence du devis<br><input type="text" name="reference_global" placeholder="DEV-2026-..." style="width:190px;padding:8px;border:1px solid #ccd;border-radius:4px;font-size:15px;"></label>
        </div>
        <div style="font-size:12px;color:#889;margin-top:8px;">Sans fichier, vous pouvez aussi saisir le montant directement.</div>
      </div>`;

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
    <p style="font-size:13px;color:#666;">Établissez UN devis de remise en état couvrant l'ensemble des postes ci-dessous, puis déposez-le : son montant est intégré à l'expertise et transmis aux secrétaires Delta Services pour validation.</p>
    <form id="f">${rows}${saisieGlobale}
      <button type="submit" id="btnValider" style="background:#1a2a6e;color:#fff;border:none;padding:12px 28px;border-radius:6px;font-size:16px;font-weight:700;cursor:pointer;">✓ Valider et transmettre le devis</button>
      <div id="msg" style="margin-top:12px;font-weight:700;"></div>
    </form>
  </div>
  <div style="font-size:11px;color:#999;padding:10px 4px;">Lien confidentiel réservé à l'atelier Nacelle Assistance · valable ${TOKEN_VALIDITY_DAYS} jours · Delta Services</div>
</div>
<script>
const CLE = ${JSON.stringify(cle)};
let fichierDepose = null; // { pdf_url, nom, lecture }
const zone = document.getElementById("zone");
const input = document.getElementById("fichier");
const etat = document.getElementById("etatFichier");
const bloc = document.getElementById("lecture");
const champM = document.querySelector('[name="montant_global"]');
const champR = document.querySelector('[name="reference_global"]');
const fmt = (n) => Number(n).toLocaleString("fr-FR");

async function deposer(file) {
  if (!file) return;
  if (file.size > ${MAX_FICHIER_OCTETS}) { etat.style.color = "#c0392b"; etat.textContent = "⚠ Fichier trop volumineux (max 3 Mo). Compressez-le ou saisissez le montant à la main."; return; }
  etat.style.color = "#666"; etat.textContent = "⏳ Envoi et lecture du devis « " + file.name + " »… (quelques secondes)";
  bloc.style.display = "none";
  document.getElementById("btnValider").disabled = true;
  try {
    const b64 = await new Promise((ok, ko) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = ko; fr.readAsDataURL(file); });
    const resp = await fetch(location.pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cle: CLE, action: "lire", fichier_base64: b64, nom: file.name, mime: file.type }),
    });
    const j = await resp.json();
    if (!resp.ok) throw new Error(j.error || resp.status);
    fichierDepose = j;
    const L = j.lecture;
    if (L && L.montant_ht) {
      champM.value = Math.round(L.montant_ht);
      if (L.reference && !champR.value) champR.value = L.reference;
      etat.style.color = "#1e7e46"; etat.textContent = "✓ Devis joint : " + j.nom;
      const lignes = (L.lignes || []).slice(0, 8).map((l) => "<li>" + l.libelle + (l.montant_ht ? " — " + fmt(l.montant_ht) + " € HT" : "") + "</li>").join("");
      bloc.style.display = "block";
      bloc.style.background = L.confiance === "haute" ? "#eefaf2" : "#fff7e6";
      bloc.style.borderColor = L.confiance === "haute" ? "#b5dfc4" : "#f0c37a";
      bloc.style.color = L.confiance === "haute" ? "#1e5e36" : "#7a4a00";
      bloc.innerHTML = "<b>🤖 Lu sur votre devis :</b> " + fmt(L.montant_ht) + " € HT" + (L.montant_ttc ? " (" + fmt(L.montant_ttc) + " € TTC)" : "") +
        (L.reference ? " · réf. " + L.reference : "") + (L.date ? " · " + L.date : "") + (L.fournisseur ? " · " + L.fournisseur : "") +
        (L.confiance !== "haute" ? "<br><b>⚠ Lecture incertaine</b>" + (L.note ? " — " + L.note : "") + " : vérifiez le montant ci-dessous." : "") +
        (L.immat_detectee && L.immat_detectee.replace(/[^A-Z0-9]/g, "") !== ${JSON.stringify(immat.replace(/[^A-Z0-9]/g, ""))} ? "<br><b>⚠ Immatriculation lue : " + L.immat_detectee + "</b> — ce devis concerne-t-il bien la nacelle ${esc(immat)} ?" : "") +
        (lignes ? "<ul style='margin:6px 0 0 16px;padding:0;'>" + lignes + "</ul>" : "") +
        "<div style='margin-top:6px;'>Vérifiez, corrigez si besoin, puis validez.</div>";
      champM.focus();
    } else {
      etat.style.color = "#b7791f"; etat.textContent = "✓ Devis joint : " + j.nom + " — montant non lisible automatiquement" + (j.erreur_lecture ? "" : "") + " : saisissez le montant total HT ci-dessous.";
      champM.focus();
    }
  } catch (err) {
    fichierDepose = null;
    etat.style.color = "#c0392b"; etat.textContent = "⚠ Échec du dépôt : " + err.message + " — vous pouvez saisir le montant à la main.";
  } finally {
    document.getElementById("btnValider").disabled = false;
  }
}
input.addEventListener("change", () => deposer(input.files[0]));
zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.style.background = "#eef2ff"; });
zone.addEventListener("dragleave", () => { zone.style.background = "#fff"; });
zone.addEventListener("drop", (e) => { e.preventDefault(); zone.style.background = "#fff"; deposer(e.dataTransfer.files[0]); });

document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = document.getElementById("msg");
  const m = champM;
  const r = champR;
  if (!m || !m.value || Number(m.value) <= 0) { msg.style.color = "#c0392b"; msg.textContent = "Déposez votre devis ou saisissez le montant total HT."; return; }
  if (!fichierDepose && !window.confirm("Aucun devis joint : transmettre uniquement le montant saisi ?")) return;
  msg.style.color = "#666"; msg.textContent = "⏳ Transmission...";
  try {
    const L = fichierDepose && fichierDepose.lecture;
    const resp = await fetch(location.pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cle: CLE, montant_global: Number(m.value), reference: r ? r.value : "",
        pdf_url: fichierDepose ? fichierDepose.pdf_url : null, pdf_nom: fichierDepose ? fichierDepose.nom : null,
        lecture_ia: !!(L && L.montant_ht), confiance: L ? L.confiance : null, fournisseur: L ? L.fournisseur : null, montant_lu: L ? L.montant_ht : null,
      }),
    });
    const j = await resp.json();
    if (!resp.ok) throw new Error(j.error || resp.status);
    msg.style.color = "#1e7e46";
    msg.textContent = "✓ Devis transmis — merci ! Les secrétaires Delta Services le valident de leur côté. Vous pouvez fermer cette page.";
    document.querySelectorAll("#f input,#f button").forEach((el) => el.disabled = true);
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
