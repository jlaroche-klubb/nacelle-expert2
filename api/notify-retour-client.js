// Envoi AUTOMATIQUE du rapport de restitution au client — Nacelle Expert.
//   POST /api/notify-retour-client  (jeton Firebase de l'expert)
//
// Deux modes :
//   - provisoire: true  → expertise avec postes en attente de devis : le client
//     reçoit le rapport (photos + montants déjà chiffrés) avec la mention claire
//     « postes en attente de devis — montant définitif à venir »
//   - provisoire: false → expertise complète (utilisé après validation du devis)
//
// Copie : configurable dans Admin → Emails (config/emails, champ cc_assistanat).
// PRÉREQUIS Vercel : FIREBASE_SERVICE_ACCOUNT, BREVO_API_KEY, BREVO_SENDER_EMAIL.

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const DEFAULT_CC = ["assistanat.commerce@delta-services.fr"];
const APP_URL = "https://nacelle-expert2.vercel.app";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Méthode non autorisée" }); return; }
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) { res.status(401).json({ error: "Non authentifié" }); return; }
    await admin.auth().verifyIdToken(token);

    const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    if (!b.immat) { res.status(400).json({ error: "Immatriculation manquante" }); return; }
    const clientEmail = (b.email_client || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
      res.status(400).json({ error: "Email client manquant ou invalide" });
      return;
    }

    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL;
    if (!apiKey || !senderEmail) { res.status(500).json({ error: "Brevo non configuré" }); return; }
    const senderName = process.env.BREVO_SENDER_NAME || "Delta Services";

    let cc = DEFAULT_CC;
    try {
      const snap = await admin.firestore().collection("config").doc("emails").get();
      const cfg = snap.exists ? snap.data() : {};
      if (Array.isArray(cfg.cc_assistanat) && cfg.cc_assistanat.length) cc = cfg.cc_assistanat;
      else if (typeof cfg.cc_assistanat === "string" && cfg.cc_assistanat) cc = [cfg.cc_assistanat];
    } catch { /* défaut conservé */ }

    const esc = (s) => String(s ?? "—").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
    const lien = `${APP_URL}/api/rapport/${encodeURIComponent(b.immat)}`;
    const provisoire = !!b.provisoire;
    const nb = Number(b.nb_attente) || 0;

    const html =
      `<div style="font-family:Arial,sans-serif;max-width:560px;">` +
      `<h2 style="color:#1a2a6e;margin-bottom:4px;">Rapport de restitution · Nacelle ${esc(b.immat)}</h2>` +
      `<p style="color:#666;margin-top:0;">Delta Services</p>` +
      `<p>Bonjour,</p>` +
      `<p>Suite à la restitution de la nacelle <b>${esc(b.immat)}</b>` +
      (b.modele || b.type_nacelle ? ` (${esc(b.type_nacelle)} ${esc(b.modele)})` : "") +
      `, veuillez trouver ci-dessous le rapport d'expertise${provisoire ? "" : " complet"} (état de départ + état de retour, photos incluses).</p>` +
      (provisoire
        ? `<div style="background:#fdf3ec;border:1px solid #e8c9a8;border-radius:6px;padding:12px 16px;margin:14px 0;">` +
          `<b style="color:#b3541e;">⏳ Rapport provisoire</b><br>` +
          `${nb || "Certains"} poste${nb > 1 ? "s sont" : " est"} en attente de devis : les montants indiqués sont provisoires. ` +
          `Le montant définitif de la remise en état vous sera communiqué après chiffrage.</div>`
        : `<p><b>Ce rapport intègre l'ensemble des montants de remise en état.</b></p>`) +
      `<p style="margin-top:18px;"><a href="${esc(lien)}" style="background:#1a2a6e;color:#fff;padding:10px 22px;text-decoration:none;font-weight:bold;">&#128196; Consulter le rapport</a></p>` +
      `<p style="margin-top:22px;">Cordialement,<br><b>Delta Services</b><br>` +
      `14 Avenue James de Rothschild · 77164 Ferrières-en-Brie<br>Tél. +33 (0)1 60 95 47 80</p>` +
      `</div>`;

    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "accept": "application/json", "content-type": "application/json", "api-key": apiKey },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: [{ email: clientEmail }],
        cc: cc.map((email) => ({ email })),
        subject: `Rapport de restitution${provisoire ? " (provisoire)" : ""} · Nacelle ${b.immat}`,
        htmlContent: html,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.error("Brevo (retour client):", resp.status, detail);
      res.status(502).json({ error: "Envoi Brevo échoué (" + resp.status + ")" });
      return;
    }
    res.status(200).json({ ok: true, to: clientEmail });
  } catch (e) {
    console.error("notify-retour-client:", e);
    res.status(500).json({ error: e.message });
  }
}
