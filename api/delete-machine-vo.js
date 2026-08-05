// Suppression MIROIR de la fiche Delta VO quand un ADMIN supprime un dossier
// dans Nacelle Expert — évite les fiches orphelines (tests, créations par erreur).
//   POST /api/delete-machine-vo  { immat }   (jeton Firebase Nacelle Expert)
//
// Garde-fous :
//   - réservé aux utilisateurs Nacelle Expert de rôle « admin » (collection users)
//   - la fiche Delta VO n'est supprimée QUE si elle est encore en début de
//     cycle (statut « restitution » ou « disponible ») et non archivée :
//     une machine en préparation, vendue/clôturée ou louée LLD n'est JAMAIS
//     touchée — la réponse l'indique et l'admin est prévenu côté interface.
//
// PRÉREQUIS Vercel :
//   FIREBASE_SERVICE_ACCOUNT           (projet nacelle-expert — déjà en place)
//   FIREBASE_SERVICE_ACCOUNT_DELTAVO   (projet delta-vo — déjà en place pour
//                                       /api/valider-devis)

import admin from "firebase-admin";

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

// Statuts Delta VO encore « en début de cycle » : suppression autorisée.
// Tout le reste (en_cours, cloturee, louee_lld...) est protégé.
const STATUTS_SUPPRIMABLES = ["restitution", "disponible"];

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Méthode non autorisée" }); return; }
  try {
    // ── 1. Identité + rôle admin Nacelle Expert ──
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) { res.status(401).json({ error: "Non authentifié" }); return; }
    const decoded = await admin.auth().verifyIdToken(token);

    const userSnap = await admin.firestore().collection("users").doc(decoded.uid).get();
    const role = userSnap.exists ? userSnap.data().role : null;
    if (role !== "admin") {
      res.status(403).json({ error: "Réservé aux administrateurs Nacelle Expert" });
      return;
    }

    const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const immat = String(b.immat || "").toUpperCase().trim();
    if (!immat) { res.status(400).json({ error: "Immatriculation manquante" }); return; }

    // ── 2. Fiche Delta VO ──
    const dvApp = getDeltaVoApp();
    if (!dvApp) {
      res.status(500).json({ error: "FIREBASE_SERVICE_ACCOUNT_DELTAVO non configuré dans Vercel" });
      return;
    }
    const machineRef = dvApp.firestore().collection("machines_vo").doc(immat);
    const machineSnap = await machineRef.get();

    if (!machineSnap.exists) {
      res.status(200).json({ ok: true, deleted: false, motif: "aucune_fiche" });
      return;
    }

    const m = machineSnap.data();

    // ── 3. Garde-fous : jamais de suppression d'une fiche avancée ──
    if (m.archived) {
      res.status(200).json({ ok: true, deleted: false, motif: "protegee", statut: "archivée" });
      return;
    }
    if (!STATUTS_SUPPRIMABLES.includes(m.statut)) {
      res.status(200).json({ ok: true, deleted: false, motif: "protegee", statut: m.statut || "inconnu" });
      return;
    }

    // ── 4. Suppression ──
    await machineRef.delete();
    console.log(`🗑 Fiche Delta VO ${immat} supprimée (miroir NE, par ${decoded.email || decoded.uid})`);
    res.status(200).json({ ok: true, deleted: true });
  } catch (e) {
    console.error("delete-machine-vo:", e);
    res.status(500).json({ error: e.message });
  }
}
