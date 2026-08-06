// 🧮 RATTRAPAGE des montants d'expertise — Nacelle Expert.
//   GET /api/backfill-expertise-resume?cle={CRON_SECRET}
//
// Le « résumé d'expertise » (expertise_resume : dégâts + montants + total
// retenue) n'existe que pour les dossiers validés ou chiffrés APRÈS sa mise
// en place : les dossiers plus anciens n'en ont pas, donc leur montant
// d'expertise n'apparaît ni sur les fiches Delta VO ni dans le fichier VOG.
//
// Ce rattrapage, déclenchable à volonté (idempotent) :
//   1. recalcule expertise_resume pour TOUS les dossiers ayant un retour
//      (barème config/tarifs, repli sur le barème par défaut)
//   2. l'écrit sur le dossier Nacelle Expert (SANS toucher synced_to_delta_vo :
//      on ne déclenche pas la synchro, qui réinitialiserait des statuts)
//   3. écrit DIRECTEMENT rapport_expertise sur la fiche machines_vo Delta VO
//      correspondante (si elle existe et n'est pas archivée) — montant total,
//      dégâts détaillés, lien vers le rapport dynamique
//
// PRÉREQUIS Vercel : FIREBASE_SERVICE_ACCOUNT, FIREBASE_SERVICE_ACCOUNT_DELTAVO,
// CRON_SECRET (protection).

import admin from "firebase-admin";
import { DEFAULT_TARIFS, buildExpertiseResume } from "./_tarifs-defaults.js";

export const config = { maxDuration: 60 };

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

const APP_URL = "https://nacelle-expert2.vercel.app";

export default async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || String(req.query.cle || "") !== secret) {
      res.status(403).json({ error: "Clé invalide (utilisez ?cle=CRON_SECRET)" });
      return;
    }
    const dvApp = getDeltaVoApp();
    if (!dvApp) { res.status(500).json({ error: "FIREBASE_SERVICE_ACCOUNT_DELTAVO non configuré" }); return; }

    const db = admin.firestore();
    const dvDb = dvApp.firestore();

    // Barème : config/tarifs, repli sur le barème par défaut de l'application
    const tarifsSnap = await db.collection("config").doc("tarifs").get();
    const tarifsCfg = (tarifsSnap.exists && Array.isArray(tarifsSnap.data().data)) ? tarifsSnap.data().data : [];
    const tarifs = tarifsCfg.length ? tarifsCfg : DEFAULT_TARIFS;

    const [dossiersSnap, machinesSnap] = await Promise.all([
      db.collection("dossiers").get(),
      dvDb.collection("machines_vo").get(),
    ]);
    const machines = new Map();
    machinesSnap.forEach((d) => machines.set(d.id.toUpperCase(), { ref: d.ref, data: d.data() }));

    let dossiersMaj = 0;
    let fichesMaj = 0;
    let sansRetour = 0;
    let sansFiche = 0;

    // Écritures par lots (limite Firestore : 500 opérations par lot)
    let neBatch = db.batch(); let neOps = 0;
    let dvBatch = dvDb.batch(); let dvOps = 0;
    const commits = [];
    const flush = () => {
      if (neOps) { commits.push(neBatch.commit()); neBatch = db.batch(); neOps = 0; }
      if (dvOps) { commits.push(dvBatch.commit()); dvBatch = dvDb.batch(); dvOps = 0; }
    };

    dossiersSnap.forEach((doc) => {
      const d = doc.data();
      if (!d.retour) { sansRetour++; return; }

      const resume = buildExpertiseResume(d, tarifs);

      // 1. Sur le dossier NE (⚠ sans toucher synced_to_delta_vo)
      neBatch.update(doc.ref, { expertise_resume: resume });
      neOps++; dossiersMaj++;

      // 2. Directement sur la fiche Delta VO (si présente et non archivée)
      const immat = (d.immat || d.info?.immat || doc.id || "").trim().toUpperCase();
      const m = machines.get(immat);
      if (m && !m.data.archived) {
        dvBatch.update(m.ref, {
          rapport_expertise: { ...resume, rapport_url: `${APP_URL}/api/rapport/${encodeURIComponent(immat)}` },
          updatedAt: new Date().toISOString(),
        });
        dvOps++; fichesMaj++;
      } else {
        sansFiche++;
      }

      if (neOps >= 400 || dvOps >= 400) flush();
    });
    flush();
    await Promise.all(commits);

    console.log(`🧮 Rattrapage expertise : ${dossiersMaj} dossier(s), ${fichesMaj} fiche(s) Delta VO`);
    res.status(200).json({
      ok: true,
      dossiers_mis_a_jour: dossiersMaj,
      fiches_delta_vo_mises_a_jour: fichesMaj,
      dossiers_sans_retour_ignores: sansRetour,
      dossiers_sans_fiche_delta_vo: sansFiche,
    });
  } catch (e) {
    console.error("backfill-expertise-resume:", e);
    res.status(500).json({ error: e.message });
  }
}
