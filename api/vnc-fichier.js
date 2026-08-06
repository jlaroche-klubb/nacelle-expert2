// 📥 Téléchargement du FICHIER DU PARC (format VOG) — Nacelle Expert.
//   GET /api/vnc-fichier?cle={jeton}
//
// Lien envoyé à la compta par le cron bi-mensuel (/api/cron-vnc-compta) à la
// place d'une pièce jointe : insensible au filtrage des pièces jointes, et le
// fichier est TOUJOURS généré à l'instant du clic (parc à jour).
//
// Accès par jeton (config/emails.vnc_token, généré par le cron), sans compte.
// PRÉREQUIS Vercel : FIREBASE_SERVICE_ACCOUNT, FIREBASE_SERVICE_ACCOUNT_DELTAVO.

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

export default async function handler(req, res) {
  try {
    const cle = String(req.query.cle || "");
    const cfgSnap = await admin.firestore().collection("config").doc("emails").get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};
    if (!cfg.vnc_token || !cle || cfg.vnc_token !== cle) {
      res.status(403).send("Lien invalide. Utilisez le lien du dernier email « VNC à mettre à jour », ou demandez un nouvel envoi à Delta Services.");
      return;
    }

    const dvApp = getDeltaVoApp();
    if (!dvApp) { res.status(500).send("Configuration serveur incomplète."); return; }

    const snap = await dvApp.firestore().collection("machines_vo").get();
    const { buffer, count } = buildVogWorkbook(snap.docs);

    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="delta-vo_parc-vog_${dateStr}.xlsx"`);
    console.log(`📥 Fichier parc VOG téléchargé (${count} machines)`);
    res.status(200).send(buffer);
  } catch (e) {
    console.error("vnc-fichier:", e);
    res.status(500).send("Erreur serveur.");
  }
}
