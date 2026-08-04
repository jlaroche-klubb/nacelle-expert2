// Envoi AUTOMATIQUE de l'état de départ au client — Nacelle Expert.
//   POST /api/notify-depart  (appelé par l'app au clic sur « 📧 Envoyer au client »,
//   avec le jeton Firebase de l'expert)
//
// Contrairement à l'ancien fonctionnement (lien mailto: qui ouvrait la messagerie
// du téléphone de l'expert), l'email part directement du SERVEUR via Brevo :
// plus de dépendance à une application mail configurée sur l'appareil.
//
// Destinataire : l'email du client saisi sur le dossier (fourni par l'app).
// Copie : assistanat commerce Delta Services (fixe, côté serveur).
//
// PRÉREQUIS — mêmes variables d'environnement Vercel que /api/notify-rapport :
//   FIREBASE_SERVICE_ACCOUNT, BREVO_API_KEY, BREVO_SENDER_EMAIL, BREVO_SENDER_NAME

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

// Copie fixe (côté serveur : non modifiable depuis le navigateur)
const CC_RECIPIENTS = ["assistanat.commerce@delta-services.fr"];

const APP_URL = "https://nacelle-expert2.vercel.app";

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
    const clientEmail = (b.email_client || "").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
      res.status(400).json({ error: "Email client manquant ou invalide" });
      return;
    }

    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL;
    if (!apiKey || !senderEmail) {
      res.status(500).json({ error: "BREVO_API_KEY / BREVO_SENDER_EMAIL non configurés dans Vercel" });
      return;
    }
    const senderName = process.env.BREVO_SENDER_NAME || "Delta Services";

    const esc = (s) => String(s ?? "—").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
    const lien = `${APP_URL}/api/rapport/${encodeURIComponent(b.immat)}/depart`;

    const html =
      `<div style="font-family:Arial,sans-serif;max-width:560px;">` +
      `<h2 style="color:#1a2a6e;margin-bottom:4px;">État de départ · Nacelle ${esc(b.immat)}</h2>` +
      `<p style="color:#666;margin-top:0;">Delta Services</p>` +
      `<p>Bonjour,</p>` +
      `<p>Veuillez trouver ci-dessous le constat d'état de départ de la nacelle <b>${esc(b.immat)}</b>` +
      (b.modele || b.type_nacelle ? ` (${esc(b.type_nacelle)} ${esc(b.modele)})` : "") +
      `.<br>Ce document fera référence lors de la restitution.</p>` +
      `<p style="margin-top:18px;"><a href="${esc(lien)}" style="background:#1a2a6e;color:#fff;padding:10px 22px;text-decoration:none;font-weight:bold;">&#128196; Consulter l'état de départ</a></p>` +
      `<p style="margin-top:22px;">Cordialement,<br><b>Delta Services</b><br>` +
      `14 Avenue James de Rothschild · 77164 Ferrières-en-Brie<br>` +
      `Tél. +33 (0)1 60 95 47 80</p>` +
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
        to: [{ email: clientEmail }],
        cc: CC_RECIPIENTS.map((email) => ({ email })),
        subject: `État de départ · Nacelle ${b.immat}`,
        htmlContent: html,
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text();
      console.error("Brevo (depart):", resp.status, detail);
      res.status(502).json({ error: "Envoi Brevo échoué (" + resp.status + ")", detail });
      return;
    }

    res.status(200).json({ ok: true, to: clientEmail });
  } catch (e) {
    console.error("notify-depart:", e);
    res.status(500).json({ error: e.message });
  }
}
