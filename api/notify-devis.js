// Alerte automatique « DEVIS À FAIRE » à l'atelier Nacelle Assistance — Nacelle Expert.
//   POST /api/notify-devis  (appelé par l'app à la validation d'une expertise retour
//   contenant des postes sur devis non chiffrés, avec le jeton Firebase de l'expert)
//
// Contenu : nacelle, lieu de stockage, expert, postes à chiffrer, et le LIEN
// D'ACCÈS PROVISOIRE vers la page de saisie du devis (jeton lié au dossier).
//
// Destinataires : configurables dans le panneau Admin → Emails de l'application
// (document Firestore config/emails, champ devis_to). Défaut si non configuré.
//
// PRÉREQUIS Vercel : FIREBASE_SERVICE_ACCOUNT, BREVO_API_KEY, BREVO_SENDER_EMAIL.

import admin from "firebase-admin";
import { exigerRole } from "./_auth-role.js";
import { construireEmailDevis, destinatairesDevis, envoyerBrevo } from "./_devis-email.js";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}



export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Méthode non autorisée" }); return; }
  try {
    // 🔐 Jeton + rôle (expert / admin / super admin) — un compte « en attente » ne peut pas envoyer d'email
    const user = await exigerRole(admin, req, res);
    if (!user) return;

    const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    if (!b.immat || !b.cle) { res.status(400).json({ error: "immat / cle manquants" }); return; }

    const recipients = await destinatairesDevis(admin);
    const { html, subject } = construireEmailDevis({
      immat: b.immat, cle: b.cle, type_nacelle: b.type_nacelle, modele: b.modele,
      lieu_restitution: b.lieu_restitution, agent: b.agent, client: b.client, contrat: b.contrat,
      postes: Array.isArray(b.postes) ? b.postes : [],
    });
    try {
      await envoyerBrevo({ to: recipients, subject, html });
    } catch (e) {
      res.status(502).json({ error: e.message });
      return;
    }
    // 🧾 Trace de la demande (relances comptées depuis cette date)
    try {
      await admin.firestore().collection("dossiers").doc(String(b.immat).toUpperCase().trim()).set(
        { devis_demande: { date: new Date().toISOString(), par: user.email || "", destinataires: recipients } },
        { merge: true }
      );
    } catch (e) { console.warn("trace devis_demande :", e); }
    res.status(200).json({ ok: true, recipients: recipients.length });
  } catch (e) {
    console.error("notify-devis:", e);
    res.status(500).json({ error: e.message });
  }
}
