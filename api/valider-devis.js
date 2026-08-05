// Validation du devis par la SECRÉTAIRE (depuis Delta VO) — Nacelle Expert.
//   POST /api/valider-devis  { immat }  (jeton Firebase DELTA VO de la secrétaire)
//
// La secrétaire n'a pas de compte Nacelle Expert : son identité est vérifiée
// contre le projet Firebase delta-vo (second compte de service), et son rôle
// (secretaire ou admin) est contrôlé dans la collection users de Delta VO.
//
// Effets :
//   1. Envoie au client le RAPPORT COMPLET (tous les montants, devis inclus)
//      avec copie à l'assistanat commerce
//   2. Clôt l'attente : le dossier repasse en « Retour traité » et Delta VO
//      débloque l'étape Facture
//
// PRÉREQUIS Vercel :
//   FIREBASE_SERVICE_ACCOUNT           (projet nacelle-expert — déjà en place)
//   FIREBASE_SERVICE_ACCOUNT_DELTAVO   (projet delta-vo — à ajouter : Firebase
//     console → delta-vo → Paramètres → Comptes de service → Générer une clé)
//   BREVO_API_KEY, BREVO_SENDER_EMAIL  (déjà en place)

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

function getDeltaVoApp() {
  const existing = admin.apps.find((a) => a && a.name === "delta-vo");
  if (existing) return existing;
  const sa = process.env.FIREBASE_SERVICE_ACCOUNT_DELTAVO;
  if (!sa) return null;
  return admin.initializeApp(
    { credential: admin.credential.cert(JSON.parse(sa)) },
    "delta-vo"
  );
}

const DEFAULT_CC = ["assistanat.commerce@delta-services.fr"];
const APP_URL = "https://nacelle-expert2.vercel.app";

export default async function handler(req, res) {
  // CORS : l'appel vient du domaine Delta VO (cross-origin). La sécurité repose
  // sur le jeton Firebase vérifié, pas sur l'origine.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Méthode non autorisée" }); return; }
  try {
    // ── 1. Identité Delta VO de la secrétaire ──
    const dvApp = getDeltaVoApp();
    if (!dvApp) {
      res.status(500).json({ error: "FIREBASE_SERVICE_ACCOUNT_DELTAVO non configuré dans Vercel" });
      return;
    }
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) { res.status(401).json({ error: "Non authentifié" }); return; }
    const decoded = await dvApp.auth().verifyIdToken(token);

    // Rôle contrôlé dans la collection users de Delta VO
    const userSnap = await dvApp.firestore().collection("users").doc(decoded.uid).get();
    const role = userSnap.exists ? userSnap.data().role : null;
    if (!["admin", "secretaire"].includes(role)) {
      res.status(403).json({ error: "Réservé aux profils Secrétaire/ADV et Administrateur" });
      return;
    }
    const validePar = userSnap.exists
      ? `${userSnap.data().prenom || ""} ${userSnap.data().nom || ""}`.trim() || decoded.email
      : decoded.email;

    // ── 2. Dossier Nacelle Expert ──
    const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const immat = String(b.immat || "").toUpperCase().trim();
    if (!immat) { res.status(400).json({ error: "Immatriculation manquante" }); return; }

    const db = admin.firestore();
    const snap = await db.collection("dossiers").doc(immat).get();
    if (!snap.exists) { res.status(404).json({ error: "Dossier introuvable : " + immat }); return; }
    const d = snap.data();

    if (d.devis_pending?.length) {
      res.status(400).json({ error: `Devis incomplet : ${d.devis_pending.length} poste(s) restent à chiffrer par l'atelier.` });
      return;
    }
    if (!d.devis_complet) {
      res.status(400).json({ error: "Ce dossier n'est pas en attente de validation de devis." });
      return;
    }

    // ── 3. Envoi du rapport COMPLET au client ──
    const clientEmail = (d.info?.email || "").trim();
    let emailEnvoye = false;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
      const apiKey = process.env.BREVO_API_KEY;
      const senderEmail = process.env.BREVO_SENDER_EMAIL;
      if (apiKey && senderEmail) {
        let cc = DEFAULT_CC;
        try {
          const cfgSnap = await db.collection("config").doc("emails").get();
          const cfg = cfgSnap.exists ? cfgSnap.data() : {};
          if (Array.isArray(cfg.cc_assistanat) && cfg.cc_assistanat.length) cc = cfg.cc_assistanat;
        } catch { /* défaut */ }

        const esc = (s) => String(s ?? "—").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
        const lien = `${APP_URL}/api/rapport/${encodeURIComponent(immat)}`;
        const html =
          `<div style="font-family:Arial,sans-serif;max-width:560px;">` +
          `<h2 style="color:#1a2a6e;margin-bottom:4px;">Rapport de restitution définitif · Nacelle ${esc(immat)}</h2>` +
          `<p style="color:#666;margin-top:0;">Delta Services</p>` +
          `<p>Bonjour,</p>` +
          `<p>Le chiffrage des postes en attente de devis pour la nacelle <b>${esc(immat)}</b> est terminé. ` +
          `Veuillez trouver ci-dessous le rapport d'expertise <b>définitif</b>, intégrant l'ensemble des montants de remise en état.</p>` +
          `<p style="margin-top:18px;"><a href="${esc(lien)}" style="background:#1a2a6e;color:#fff;padding:10px 22px;text-decoration:none;font-weight:bold;">&#128196; Consulter le rapport définitif</a></p>` +
          `<p style="margin-top:22px;">Cordialement,<br><b>Delta Services</b><br>` +
          `14 Avenue James de Rothschild · 77164 Ferrières-en-Brie<br>Tél. +33 (0)1 60 95 47 80</p>` +
          `</div>`;

        const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: { "accept": "application/json", "content-type": "application/json", "api-key": apiKey },
          body: JSON.stringify({
            sender: { email: senderEmail, name: process.env.BREVO_SENDER_NAME || "Delta Services" },
            to: [{ email: clientEmail }],
            cc: cc.map((email) => ({ email })),
            subject: `Rapport de restitution définitif · Nacelle ${immat}`,
            htmlContent: html,
          }),
        });
        emailEnvoye = resp.ok;
        if (!resp.ok) console.error("Brevo (valider-devis):", resp.status, await resp.text());
      }
    }

    // ── 4. Clôture de l'attente ──
    await db.collection("dossiers").doc(immat).update({
      devis_complet: true,
      devis_valide: { par: validePar, email: decoded.email || "", date: new Date().toISOString() },
      synced_to_delta_vo: false, // Delta VO récupère l'état final
      updatedAt: new Date().toISOString(),
    });

    res.status(200).json({ ok: true, email_envoye: emailEnvoye, client: clientEmail || null });
  } catch (e) {
    console.error("valider-devis:", e);
    const msg = /auth|token|decoded/i.test(String(e.message)) ? "Identité Delta VO non reconnue" : e.message;
    res.status(500).json({ error: msg });
  }
}
