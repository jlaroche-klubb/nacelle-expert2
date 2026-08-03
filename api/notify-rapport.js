// Alerte automatique par email à la validation d'une expertise retour — Nacelle Expert.
//   POST /api/notify-rapport  (appelé par l'app à la validation, avec le jeton Firebase de l'expert)
//
// Envoi via l'API Brevo (compte gratuit, 300 emails/jour, partagé avec les envois Delta VO).
//
// PRÉREQUIS — variables d'environnement Vercel :
//   FIREBASE_SERVICE_ACCOUNT  (déjà configurée pour /api/rapport)
//   BREVO_API_KEY             clé API Brevo (app.brevo.com → SMTP & API → clés API)
//   BREVO_SENDER_EMAIL        adresse expéditrice validée dans Brevo
//   BREVO_SENDER_NAME         (optionnel) nom d'affichage — défaut "Nacelle Expert · Delta Services"

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

// Destinataires fixes de l'alerte (côté serveur : non modifiable depuis le navigateur)
// ⚠ PHASE DE TEST : envoi à Jonathan uniquement. Une fois validé, rétablir la liste complète :
// nneguy@klubb.com, gcloarec@delta-services.fr, bbenavente@delta-services.fr,
// anebotsaudin@delta-services.fr, rbourdin@delta-services.fr, jbessadet@delta-services.fr
const RECIPIENTS = [
  "jlaroche@klubb.com",
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Méthode non autorisée" });
    return;
  }
  try {
    // Sécurité : l'appel doit venir d'un utilisateur authentifié de l'app
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: "Non authentifié" });
      return;
    }
    await admin.auth().verifyIdToken(token);

    const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    if (!b.immat) {
      res.status(400).json({ error: "Immatriculation manquante" });
      return;
    }

    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL;
    if (!apiKey || !senderEmail) {
      res.status(500).json({ error: "BREVO_API_KEY / BREVO_SENDER_EMAIL non configurés dans Vercel" });
      return;
    }
    const senderName = process.env.BREVO_SENDER_NAME || "Nacelle Expert · Delta Services";

    const esc = (s) => String(s ?? "—").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
    const row = (label, value, alt) =>
      `<tr${alt ? ' style="background:#f5f6fa;"' : ""}><td style="padding:6px 10px;color:#666;">${label}</td><td style="padding:6px 10px;">${value}</td></tr>`;

    const html =
      `<div style="font-family:Arial,sans-serif;max-width:560px;">` +
      `<h2 style="color:#1a2a6e;margin-bottom:4px;">${esc(b.type_envoi || "Nouvelle expertise retour")}</h2>` +
      `<p style="color:#666;margin-top:0;">Nacelle Expert · Delta Services</p>` +
      `<table style="border-collapse:collapse;width:100%;font-size:14px;">` +
      row("Immatriculation", `<b>${esc(b.immat)}</b>`) +
      row("Modèle", `${esc(b.modele)} — ${esc(b.type_nacelle)}`, true) +
      row("Client", `${esc(b.client)} (contrat ${esc(b.contrat)})`) +
      row("Date retour", esc(b.date_retour), true) +
      row("Expert", esc(b.agent)) +
      row("Dégâts constatés", esc(b.nb_degats), true) +
      row("Total retenue", `<b style="color:#c8102e;">${esc(b.total_retenue)}</b>`) +
      `</table>` +
      (b.lien_rapport
        ? `<p style="margin-top:18px;"><a href="${esc(b.lien_rapport)}" style="background:#1a2a6e;color:#fff;padding:10px 22px;text-decoration:none;font-weight:bold;">&#128196; Voir le rapport complet</a></p>`
        : "") +
      `<p style="color:#999;font-size:12px;margin-top:18px;">Email automatique envoyé à la validation de l'expertise dans Nacelle Expert.</p>` +
      `</div>`;

    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "content-type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: RECIPIENTS.map((email) => ({ email })),
        subject: `\u{1F514} ${b.type_envoi || "Nouvelle expertise retour"} · Nacelle ${b.immat}`,
        htmlContent: html,
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      console.error("Brevo:", resp.status, detail);
      res.status(502).json({ error: "Envoi Brevo échoué (" + resp.status + ")", detail });
      return;
    }

    res.status(200).json({ ok: true, recipients: RECIPIENTS.length });
  } catch (e) {
    console.error("notify-rapport:", e);
    res.status(500).json({ error: e.message });
  }
}
