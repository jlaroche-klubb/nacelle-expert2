// Redirection courte vers le rapport d'un dossier — Nacelle Expert.
//
//   GET /api/rapport/{IMMAT}          → PDF de restitution (retour.pdf_url),
//                                       sinon rapport HTML (rapport_url)
//   GET /api/rapport/{IMMAT}/depart   → état de départ HTML (collection rapports_links)
//
// Pourquoi : les URLs Firebase brutes contiennent un token avec des caractères "="
// que certaines messageries corrompent à l'envoi (quoted-printable) → lien mort.
// Ce lien court, sans "=", est mis dans les emails et redirige vers le bon fichier.
//
// PRÉREQUIS : variable d'environnement Vercel FIREBASE_SERVICE_ACCOUNT
// contenant le JSON complet de la clé de compte de service Firebase
// (Console Firebase → Paramètres du projet → Comptes de service → Générer une clé privée).

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

export default async function handler(req, res) {
  try {
    const seg = [].concat(req.query.seg || []);
    const immat = decodeURIComponent(seg[0] || "").toUpperCase().trim();
    const wantDepart = (seg[1] || "").toLowerCase() === "depart";
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
