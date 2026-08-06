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
import * as XLSX from "xlsx";

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

    // Destinataires : Admin NE → 📧 Emails (compta_to), défaut sinon
    let recipients = DEFAULT_COMPTA_TO;
    try {
      const cfgSnap = await admin.firestore().collection("config").doc("emails").get();
      const cfg = cfgSnap.exists ? cfgSnap.data() : {};
      if (Array.isArray(cfg.compta_to) && cfg.compta_to.length) recipients = cfg.compta_to;
    } catch { /* défaut conservé */ }

    // 🚜 Parc Delta VO actif (non archivé) — mêmes colonnes que l'export manuel
    const snap = await dvApp.firestore().collection("machines_vo").get();
    const rows = [];
    snap.forEach((d) => {
      const m = d.data();
      if (m.archived) return;
      rows.push({
        "N° occasion": m.numero_occasion || "",
        "Immatriculation": m.immat || d.id,
        "N° de châssis": m.num_chassis || "",
        "Type nacelle": m.type_nacelle || "",
        "Modèle porteur": m.modele || "",
        "Date de mise en service": m.date_mise_en_service || "",
        "Mise en circulation": m.annee_fab || "",
        "Propriétaire": m.proprietaire || "",
        "Catégorie": m.categorie_vehicule || "",
        "Prix de vente HT (€)": m.prix_fr ?? "",
        "VNC (€)": m.vr_vnc ?? "",
      });
    });
    rows.sort((a, b) => String(a["N° occasion"]).localeCompare(String(b["N° occasion"]), "fr", { numeric: true }));

    const ws = XLSX.utils.json_to_sheet(rows);
    ws["!cols"] = [
      { wch: 12 }, { wch: 13 }, { wch: 20 }, { wch: 14 }, { wch: 20 },
      { wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 14 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "VNC");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

    const dateStr = new Date().toISOString().slice(0, 10);
    const html =
      `<div style="font-family:Arial,sans-serif;max-width:560px;">` +
      `<h2 style="color:#1a2a6e;margin-bottom:4px;">💶 Mise à jour des VNC · Parc VO</h2>` +
      `<p style="color:#666;margin-top:0;">Delta VO · Delta Services</p>` +
      `<p>Bonjour,</p>` +
      `<p>Veuillez trouver en pièce jointe la liste du parc VO actif (<b>${rows.length} machine${rows.length > 1 ? "s" : ""}</b>).</p>` +
      `<p><b>Merci de mettre à jour la colonne « VNC (€) »</b> puis de renvoyer le fichier au service ADV, ` +
      `qui l'intégrera dans Delta VO (bouton « Import VNC »).</p>` +
      `<p style="color:#999;font-size:12px;margin-top:18px;">Envoi automatique le 1er et le 16 de chaque mois · ne pas répondre à cet email · destinataires modifiables dans Nacelle Expert, Admin → 📧 Emails.</p>` +
      `</div>`;

    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "accept": "application/json", "content-type": "application/json", "api-key": apiKey },
      body: JSON.stringify({
        sender: { email: senderEmail, name: process.env.BREVO_SENDER_NAME || "Delta VO · Delta Services" },
        to: recipients.map((email) => ({ email })),
        subject: `💶 VNC à mettre à jour · Parc VO (${rows.length} machines) · ${dateStr}`,
        htmlContent: html,
        attachment: [{ name: `delta-vo_vnc-compta_${dateStr}.xlsx`, content: buffer.toString("base64") }],
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.error("Brevo (cron VNC):", resp.status, detail);
      res.status(502).json({ error: "Envoi Brevo échoué (" + resp.status + ")" });
      return;
    }

    console.log(`📆 Fichier VNC envoyé à la compta (${recipients.length} destinataire(s), ${rows.length} machines)`);
    res.status(200).json({ ok: true, machines: rows.length, recipients: recipients.length });
  } catch (e) {
    console.error("cron-vnc-compta:", e);
    res.status(500).json({ error: e.message });
  }
}
