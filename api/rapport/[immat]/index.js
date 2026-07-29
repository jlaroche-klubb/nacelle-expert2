// Redirection courte vers le rapport de restitution d'un dossier — Nacelle Expert.
//   GET /api/rapport/{IMMAT} → PDF de restitution (retour.pdf_url), sinon rapport HTML (rapport_url)
// PRÉREQUIS : variable d'environnement Vercel FIREBASE_SERVICE_ACCOUNT.

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

export default async function handler(req, res) {
  try {
    // /api/rapport/GP-549-BA → ["api","rapport","GP-549-BA"]
    const path = (req.url || "").split("?")[0];
    const parts = path.split("/").filter(Boolean);
    const immat = decodeURIComponent(req.query.immat || parts[2] || "").toUpperCase().trim();

    if (!immat) {
      res.status(400).send("Immatriculation manquante.");
      return;
    }

    const snap = await admin.firestore().collection("dossiers").doc(immat).get();
    if (!snap.exists) {
      res.status(404).send("Dossier introuvable : " + immat);
      return;
    }
    const d = snap.data();
    const url = (d.retour && d.retour.pdf_url) || d.rapport_url || null;

    if (!url) {
      res.status(404).send("Rapport non disponible pour " + immat + ".");
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.statusCode = 302;
    res.setHeader("Location", url);
    res.end();
  } catch (e) {
    console.error("api/rapport:", e);
    res.status(500).send("Erreur serveur.");
  }
}
