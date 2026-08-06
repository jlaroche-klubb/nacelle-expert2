// 📆 CRON bi-mensuel : envoi du fichier VNC au SERVICE COMPTA — Nacelle Expert.
//   GET /api/cron-vnc-compta   (déclenché par Vercel Cron le 1er et le 16 du mois,
//   voir vercel.json — protégé par CRON_SECRET)
//
// Circuit VNC/prix (validé avec Jonathan) :
//   1. Ce cron envoie à la compta l'Excel du parc Delta VO actif avec la
//      colonne « VNC (€) » à mettre à jour
//   2. La compta renvoie le fichier à l'ADV → bouton « Import VNC » (Delta VO)
//   3. L'ADV vérifie la cohérence puis génère l'« Export Pricing PDG »
//      (prix à faire / prix à revoir) pour la décision du PDG
//   4. Le PDG renvoie ses prix → « Import Pricing » (Delta VO)
//
// Le fichier est IDENTIQUE à l'« Export VNC compta » manuel de Delta VO
// (mêmes colonnes) : l'import accepte l'un comme l'autre.
//
// Destinataires : Admin NE → 📧 Emails (config/emails, champ compta_to).
// PRÉREQUIS Vercel : FIREBASE_SERVICE_ACCOUNT_DELTAVO, BREVO_API_KEY,
//   BREVO_SENDER_EMAIL, et CRON_SECRET (chaîne aléatoire : Vercel l'envoie
//   automatiquement en Authorization sur les déclenchements de cron).

import admin from "firebase-admin";
import { buildVogWorkbook } from "./_vnc-workbook.js";

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

const DEFAULT_COMPTA_TO = ["jlaroche@klubb.com"]; // ⚠ à remplacer dans Admin → Emails
const APP_URL = "https://nacelle-expert2.vercel.app";

export default async function handler(req, res) {
  try {
    // 🔒 Réservé au cron Vercel (ou à un déclenchement manuel avec le secret)
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization || "";
    if (!secret || authHeader !== `Bearer ${secret}`) {
      res.status(401).json({ error: "Non autorisé" });
      return;
    }

    const dvApp = getDeltaVoApp();
    if (!dvApp) {
      res.status(500).json({ error: "FIREBASE_SERVICE_ACCOUNT_DELTAVO non configuré" });
      return;
    }

    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL;
    if (!apiKey || !senderEmail) {
      res.status(500).json({ error: "Brevo non configuré" });
      return;
    }

    // Destinataires + jeton de téléchargement : Admin NE → 📧 Emails (config/emails)
    const cfgRef = admin.firestore().collection("config").doc("emails");
    let recipients = DEFAULT_COMPTA_TO;
    let vncToken = "";
    try {
      const cfgSnap = await cfgRef.get();
      const cfg = cfgSnap.exists ? cfgSnap.data() : {};
      if (Array.isArray(cfg.compta_to) && cfg.compta_to.length) recipients = cfg.compta_to;
      vncToken = cfg.vnc_token || "";
    } catch { /* défaut conservé */ }

    // 🔑 Jeton du lien de téléchargement (généré une fois, réutilisé ensuite)
    if (!vncToken) {
      vncToken = Array.from({ length: 48 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
      await cfgRef.set({ vnc_token: vncToken }, { merge: true });
    }

    // 🚜 Décompte du parc actif (le fichier lui-même est généré AU CLIC sur le
    // lien — /api/vnc-fichier — donc toujours à jour, même colonnes que
    // l'« Export parc (VOG) » de Delta VO)
    const snap = await dvApp.firestore().collection("machines_vo").get();
    const { count } = buildVogWorkbook(snap.docs);

    const dateStr = new Date().toISOString().slice(0, 10);
    const lien = `${APP_URL}/api/vnc-fichier?cle=${encodeURIComponent(vncToken)}`;
    const html =
      `<div style="font-family:Arial,sans-serif;max-width:560px;">` +
      `<h2 style="color:#1a2a6e;margin-bottom:4px;">💶 Mise à jour des VNC · Parc VO</h2>` +
      `<p style="color:#666;margin-top:0;">Delta VO · Delta Services</p>` +
      `<p>Bonjour,</p>` +
      `<p>Le fichier du parc VO actif (<b>${count} machine${count > 1 ? "s" : ""}</b>, format VOG) est prêt :</p>` +
      `<p style="margin:18px 0;"><a href="${lien}" style="background:#1a2a6e;color:#fff;padding:12px 26px;text-decoration:none;font-weight:bold;border-radius:4px;">&#128229; Télécharger le fichier Excel</a></p>` +
      `<p><b>Merci de mettre à jour la colonne « VR OU VNC EUR »</b> puis de renvoyer le fichier au service ADV, ` +
      `qui le réintégrera dans Delta VO.</p>` +
      `<p style="color:#999;font-size:12px;margin-top:18px;">Le fichier est généré au moment du clic (données à jour). Lien réservé au service comptable. Envoi automatique le 1er et le 16 de chaque mois · ne pas répondre à cet email · destinataires modifiables dans Nacelle Expert, Admin → 📧 Emails.</p>` +
      `</div>`;

    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "accept": "application/json", "content-type": "application/json", "api-key": apiKey },
      body: JSON.stringify({
        sender: { email: senderEmail, name: process.env.BREVO_SENDER_NAME || "Delta VO · Delta Services" },
        to: recipients.map((email) => ({ email })),
        subject: `💶 VNC à mettre à jour · Parc VO (${count} machines) · ${dateStr}`,
        htmlContent: html,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.error("Brevo (cron VNC):", resp.status, detail);
      res.status(502).json({ error: "Envoi Brevo échoué (" + resp.status + ")" });
      return;
    }

    console.log(`📆 Lien du fichier parc VOG envoyé à la compta (${recipients.length} destinataire(s), ${count} machines)`);
    res.status(200).json({ ok: true, machines: count, recipients: recipients.length });
  } catch (e) {
    console.error("cron-vnc-compta:", e);
    res.status(500).json({ error: e.message });
  }
}
