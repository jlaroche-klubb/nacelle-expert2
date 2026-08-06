// 🔔 Demande d'accès + notification — Nacelle Expert.
//   POST /api/notify-new-user  (appelé automatiquement par l'app à la
//   PREMIÈRE connexion d'un compte Google inconnu, avec son jeton Firebase)
//
// C'est le SERVEUR qui crée la demande dans pending_users (les règles
// Firestore interdisent cette écriture aux comptes sans profil — c'est
// pour cela que la v1 côté client ne fonctionnait pas), puis envoie
// l'email de notification au super admin.
//
// L'identité (nom, email) est prise dans le JETON VÉRIFIÉ, pas dans le corps
// de la requête : impossible d'usurper une adresse.
//
// Réponses : { status: "active" | "approved" | "pending" }
//   active   → un profil users existe déjà (rien à faire)
//   approved → une pré-création avec rôle attend la personne (recharger)
//   pending  → demande créée/en attente de validation du super admin
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

async function envoyerNotification(nomComplet, email) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) throw new Error("Configuration Brevo manquante");

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
    throw new Error("Échec de l'envoi de la notification");
  }
  return to.length;
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
    const email = (decoded.email || "").trim();
    if (!email) {
      res.status(400).json({ error: "Jeton sans adresse email" });
      return;
    }
    const nomComplet = decoded.name || email;
    const db = admin.firestore();

    // 1) Un profil actif existe déjà ? (l'app n'aurait pas dû appeler)
    const userSnap = await db.collection("users").doc(decoded.uid).get();
    if (userSnap.exists) {
      res.status(200).json({ status: "active" });
      return;
    }

    // 2) Demande / pré-création existante ?
    const pendingId = email.replace(/[@.]/g, "_");
    const pendingRef = db.collection("pending_users").doc(pendingId);
    const pendingSnap = await pendingRef.get();

    if (pendingSnap.exists) {
      const p = pendingSnap.data();
      if (p.role) {
        // Pré-créé (ou validé) avec un rôle : l'app migre à la connexion
        res.status(200).json({ status: "approved" });
        return;
      }
      // Demande déjà en attente : une seule notification par demande
      if (!p.notified_at) {
        await envoyerNotification(nomComplet, email);
        await pendingRef.update({ notified_at: new Date().toISOString() });
      }
      res.status(200).json({ status: "pending" });
      return;
    }

    // 3) 🆕 Première connexion inconnue → le SERVEUR crée la demande
    const dn = decoded.name || "";
    const prenomAuto = dn.split(" ")[0] || "Prénom";
    const nomAuto = dn.split(" ").slice(1).join(" ") || "Nom";
    await pendingRef.set({
      email,
      nom: nomAuto,
      prenom: prenomAuto,
      createdAt: new Date().toISOString(),
      status: "pending",
      demande_acces: true, // demande spontanée (pas de rôle tant que non validée)
    });
    try {
      await envoyerNotification(nomComplet, email);
      await pendingRef.update({ notified_at: new Date().toISOString() });
    } catch (e) {
      // La demande existe même si l'email a échoué : le super admin la
      // verra dans Admin → Utilisateurs ; on ne bloque pas la personne.
      console.error("Notification non envoyée:", e);
    }
    res.status(200).json({ status: "pending" });
  } catch (e) {
    console.error("notify-new-user:", e);
    res.status(500).json({ error: e.message });
  }
}
