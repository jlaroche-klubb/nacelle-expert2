// Alerte automatique « DEVIS À FAIRE » à l'atelier Nacelle Assistance — Nacelle Expert.
//   POST /api/notify-devis  (appelé par l'app à la validation d'une expertise retour
//   contenant des postes sur devis non chiffrés, avec le jeton Firebase de l'expert)
//
// Contenu : nacelle, lieu de stockage, expert, postes à chiffrer, et le LIEN
// D'ACCÈS PROVISOIRE vers la page de saisie du devis (jeton lié au dossier).
//
// Destinataires : configurables dans le panneau Admin → Emails de l'application
// (document Firestore config/emails, champ devis_to). Défaut si non configuré.
//
// PRÉREQUIS Vercel : FIREBASE_SERVICE_ACCOUNT, BREVO_API_KEY, BREVO_SENDER_EMAIL.

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const DEFAULT_DEVIS_TO = ["jlaroche@klubb.com"]; // ⚠ à remplacer dans Admin → Emails
const APP_URL = "https://nacelle-expert2.vercel.app";

async function getEmailConfig() {
  try {
    const snap = await admin.firestore().collection("config").doc("emails").get();
    return snap.exists ? snap.data() : {};
  } catch { return {}; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Méthode non autorisée" }); return; }
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) { res.status(401).json({ error: "Non authentifié" }); return; }
    await admin.auth().verifyIdToken(token);

    const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    if (!b.immat || !b.cle) { res.status(400).json({ error: "immat / cle manquants" }); return; }

    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL;
    if (!apiKey || !senderEmail) { res.status(500).json({ error: "Brevo non configuré" }); return; }
    const senderName = process.env.BREVO_SENDER_NAME || "Nacelle Expert · Delta Services";

    const cfg = await getEmailConfig();
    const recipients = (Array.isArray(cfg.devis_to) && cfg.devis_to.length) ? cfg.devis_to : DEFAULT_DEVIS_TO;

    const esc = (s) => String(s ?? "—").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
    const lien = `${APP_URL}/api/devis/${encodeURIComponent(b.immat)}?cle=${encodeURIComponent(b.cle)}`;
    const postes = Array.isArray(b.postes) ? b.postes : [];

    const row = (label, value, alt) =>
      `<tr${alt ? ' style="background:#f5f6fa;"' : ""}><td style="padding:6px 10px;color:#666;">${label}</td><td style="padding:6px 10px;">${value}</td></tr>`;

    const html =
      `<div style="font-family:Arial,sans-serif;max-width:560px;">` +
      `<h2 style="color:#b3541e;margin-bottom:4px;">⏳ Devis à chiffrer · Nacelle ${esc(b.immat)}</h2>` +
      `<p style="color:#666;margin-top:0;">Nacelle Expert · Delta Services</p>` +
      `<table style="border-collapse:collapse;width:100%;font-size:14px;">` +
      row("Nacelle", `<b>${esc(b.type_nacelle)} ${esc(b.modele)}</b>`) +
      row("Lieu de stockage", `📍 <b>${esc(b.lieu_restitution)}</b>`, true) +
      row("Expert", esc(b.agent)) +
      row("Client", `${esc(b.client)} (contrat ${esc(b.contrat)})`, true) +
      `</table>` +
      `<p style="margin:14px 0 6px;font-weight:bold;">UN devis global à établir, couvrant ${postes.length > 1 ? "les " + postes.length + " postes suivants" : "le poste suivant"} :</p>` +
      `<ul style="font-size:14px;">${postes.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` +
      `<p style="margin-top:18px;"><a href="${esc(lien)}" style="background:#1a2a6e;color:#fff;padding:12px 24px;text-decoration:none;font-weight:bold;">✏️ Saisir le devis (photos incluses)</a></p>` +
      `<p style="color:#999;font-size:12px;margin-top:18px;">Lien confidentiel, valable 30 jours, réservé à ce dossier. L'expertise sera transmise au client une fois le devis validé.</p>` +
      `</div>`;

    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "accept": "application/json", "content-type": "application/json", "api-key": apiKey },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: recipients.map((email) => ({ email })),
        subject: `⏳ Devis à chiffrer · Nacelle ${b.immat} (${b.lieu_restitution || "?"})`,
        htmlContent: html,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.error("Brevo (devis):", resp.status, detail);
      res.status(502).json({ error: "Envoi Brevo échoué (" + resp.status + ")" });
      return;
    }
    res.status(200).json({ ok: true, recipients: recipients.length });
  } catch (e) {
    console.error("notify-devis:", e);
    res.status(500).json({ error: e.message });
  }
}
