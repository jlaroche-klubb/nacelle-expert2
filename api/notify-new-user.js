// 🔔 Notification « nouvelle demande d'accès » — Nacelle Expert.
//   POST /api/notify-new-user  (appelé automatiquement par l'app à la
//   PREMIÈRE connexion d'un compte Google inconnu, avec son jeton Firebase)
//
// Même fonctionnement que Delta VO : la demande est créée dans pending_users
// (sans rôle) et le SUPER ADMIN reçoit cet email pour la valider dans
// Admin → Utilisateurs.
//
// Destinataires : les comptes au rôle « superadmin » + toujours le compte
// d'amorçage jlaroche@klubb.com (filet de sécurité anti-verrouillage).
//
// L'identité (nom, email) est prise dans le JETON VÉRIFIÉ, pas dans le corps
// de la requête : impossible d'usurper une adresse.
//
// PRÉREQUIS Vercel (déjà en place) : FIREBASE_SERVICE_ACCOUNT, BREVO_API_KEY,
//   BREVO_SENDER_EMAIL, BREVO_SENDER_NAME.

import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

const BOOTSTRAP_SUPERADMIN = "jlaroche@klubb.com";
const APP_URL = "https://nacelle-expert2.vercel.app";

async function getSuperAdminEmails() {
  const emails = new Set([BOOTSTRAP_SUPERADMIN]);
  try {
    const snap = await admin
      .firestore()
      .collection("users")
      .where("role", "==", "superadmin")
      .get();
    snap.docs.forEach((d) => {
      const e = (d.data().email || "").trim().toLowerCase();
      if (e) emails.add(e);
    });
  } catch {
    /* le compte d'amorçage reste destinataire */
  }
  return [...emails];
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Méthode non autorisée" });
    return;
  }
  try {
    // Sécurité : l'appelant doit être authentifié Google (même sans profil)
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
      res.status(401).json({ error: "Non authentifié" });
      return;
    }
    const decoded = await admin.auth().verifyIdToken(token);
    const email = decoded.email || "(email inconnu)";
    const nomComplet = decoded.name || email;

    // Anti-spam : on ne notifie que si une demande existe bien en attente
    const pendingId = String(email).replace(/[@.]/g, "_");
    const pendingSnap = await admin.firestore().collection("pending_users").doc(pendingId).get();
    if (!pendingSnap.exists) {
      res.status(409).json({ error: "Aucune demande d'accès en attente pour ce compte" });
      return;
    }
    // Une seule notification par demande
    if (pendingSnap.data().notified_at) {
      res.status(200).json({ ok: true, deja_notifie: true });
      return;
    }

    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL;
    if (!apiKey || !senderEmail) {
      res.status(500).json({ error: "Configuration Brevo manquante" });
      return;
    }

    const to = await getSuperAdminEmails();
    const dateStr = new Date().toLocaleString("fr-FR", {
      timeZone: "Europe/Paris",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a1a2e">
        <h2 style="color:#14213d">🔔 Nouvelle demande d'accès — Nacelle Expert</h2>
        <p>Une personne vient de se connecter pour la première fois et attend la validation de son compte :</p>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:6px 10px;border:1px solid #ccc"><strong>Nom</strong></td><td style="padding:6px 10px;border:1px solid #ccc">${nomComplet}</td></tr>
          <tr><td style="padding:6px 10px;border:1px solid #ccc"><strong>Email</strong></td><td style="padding:6px 10px;border:1px solid #ccc">${email}</td></tr>
          <tr><td style="padding:6px 10px;border:1px solid #ccc"><strong>Date</strong></td><td style="padding:6px 10px;border:1px solid #ccc">${dateStr}</td></tr>
        </table>
        <p>Pour valider : ouvrez <a href="${APP_URL}">Nacelle Expert</a> → ⚙ Administration → onglet <strong>Utilisateurs</strong> → choisissez le rôle puis « ✓ Valider ».</p>
        <p style="font-size:12px;color:#777">Email automatique Nacelle Expert · Delta Services</p>
      </div>`;

    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender: { email: senderEmail, name: process.env.BREVO_SENDER_NAME || "Nacelle Expert · Delta Services" },
        to: to.map((e) => ({ email: e })),
        replyTo: { email: process.env.REPLY_TO_EMAIL || "assistanat.commerce@delta-services.fr" },
        subject: `🔔 Demande d'accès Nacelle Expert — ${nomComplet}`,
        htmlContent: html,
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.error("Brevo error:", resp.status, txt);
      res.status(502).json({ error: "Échec de l'envoi de la notification" });
      return;
    }

    await pendingSnap.ref.update({ notified_at: new Date().toISOString() });
    res.status(200).json({ ok: true, destinataires: to.length });
  } catch (e) {
    console.error("notify-new-user:", e);
    res.status(500).json({ error: e.message });
  }
}
