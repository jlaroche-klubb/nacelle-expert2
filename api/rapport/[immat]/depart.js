// Redirection courte vers l'état de départ d'un dossier — Nacelle Expert.
//   GET /api/rapport/{IMMAT}/depart → rapport HTML d'état de départ (collection rapports_links)
// PRÉREQUIS : variable d'environnement Vercel FIREBASE_SERVICE_ACCOUNT.

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

export default async function handler(req, res) {
  try {
    // /api/rapport/GP-549-BA/depart → ["api","rapport","GP-549-BA","depart"]
    const path = (req.url || "").split("?")[0];
    const parts = path.split("/").filter(Boolean);
    const immat = decodeURIComponent(req.query.immat || parts[2] || "").toUpperCase().trim();

    if (!immat) {
      res.status(400).send("Immatriculation manquante.");
      return;
    }

    const snap = await admin.firestore().collection("rapports_links").doc(immat).get();
    const url = snap.exists ? snap.data().depart_url || null : null;
    // 🔐 Clé d'accès (depart_token, posée à la publication depuis l'appli)
    const attendu = snap.exists ? snap.data().depart_token || "" : "";
    const cle = String(req.query.cle || "").trim();
    if (!attendu || !cle || cle !== attendu) {
      res.setHeader("Cache-Control", "no-store");
      res.status(403).send("Lien invalide ou expiré. Utilisez le lien reçu dans l'email « État de départ », ou demandez un nouvel envoi à Delta Services.");
      return;
    }

    if (!url) {
      res.status(404).send("État de départ non disponible pour " + immat + ". Ouvrez le récap départ dans l'application et cliquez sur Email pour le publier.");
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    res.statusCode = 302;
    res.setHeader("Location", url);
    res.end();
  } catch (e) {
    console.error("api/rapport/depart:", e);
    res.status(500).send("Erreur serveur.");
  }
}
