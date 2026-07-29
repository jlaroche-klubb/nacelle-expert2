// Redirection courte vers le rapport d'un dossier — Nacelle Expert.
//
//   GET /api/rapport/{IMMAT}          → PDF de restitution (retour.pdf_url),
//                                       sinon rapport HTML (rapport_url)
//   GET /api/rapport/{IMMAT}/depart   → état de départ HTML (collection rapports_links)
//
// PRÉREQUIS : variable d'environnement Vercel FIREBASE_SERVICE_ACCOUNT.

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

export default async function handler(req, res) {
  try {
    // Lecture des segments directement depuis l'URL (fiable quel que soit le routage Vercel)
    // req.url = "/api/rapport/GP-549-BA" ou "/api/rapport/GP-549-BA/depart"
    const path = (req.url || "").split("?")[0];
    const parts = path.split("/").filter(Boolean); // ["api","rapport","GP-549-BA","depart"?]
    const immat = decodeURIComponent(parts[2] || "").toUpperCase().trim();
    const wantDepart = (parts[3] || "").toLowerCase() === "depart";

    if (!immat) {
      res.status(400).send("Immatriculation manquante.");
      return;
    }

    const db = admin.firestore();
    let url = null;

    if (wantDepart) {
      const snap = await db.collection("rapports_links").doc(immat).get();
      url = snap.exists ? snap.data().depart_url || null : null;
    } else {
      const snap = await db.collection("dossiers").doc(immat).get();
      if (!snap.exists) {
        res.status(404).send("Dossier introuvable : " + immat);
        return;
      }
      const d = snap.data();
      url = (d.retour && d.retour.pdf_url) || d.rapport_url || null;
    }

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
