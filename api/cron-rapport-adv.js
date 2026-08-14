// 📊 CRON hebdomadaire : rapport de suivi facturation pour la CHEF DES
//   SECRÉTAIRES — envoyé tous les VENDREDIS à 9h00 (voir vercel.json,
//   protégé par CRON_SECRET). Validé avec Jonathan.
//
// Contenu (données Delta VO, lues côté serveur comme le cron VNC) :
//   1. Nacelles en attente de facture de remise en état  (onglet Restitutions)
//   2. Nacelles facturées mais pas réglées               (onglet Restitutions)
//   3. Nacelles prêtes mais pas facturées                (onglet Préparation)
//   4. Nacelles facturées et pas réglées                 (onglet Clôturées)
//
// Destinataires : Admin NE → 📧 Emails (config/emails, champ rapport_adv_to).
// PRÉREQUIS Vercel (déjà en place pour le cron VNC) : FIREBASE_SERVICE_ACCOUNT,
//   FIREBASE_SERVICE_ACCOUNT_DELTAVO, BREVO_API_KEY, BREVO_SENDER_EMAIL,
//   CRON_SECRET.

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

const DEFAULT_TO = ["jlaroche@klubb.com"]; // ⚠ à remplacer dans Admin → 📧 Emails
const APP_URL = "https://delta-vo.vercel.app";

/** Jours écoulés depuis une date AAAA-MM-JJ (0 si absente/invalide). */
function joursDepuis(dateStr) {
  if (!dateStr) return 0;
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

/** Toutes les étapes de préparation faites (ou non nécessaires) ? */
function prepaFinie(m) {
  if (m.type_prepa === "en_etat") return true; // vendue en l'état : rien à préparer
  const etapes = Array.isArray(m.etapes_prepa) ? m.etapes_prepa : [];
  return etapes.length > 0 && etapes.every((e) => e.done || e.non_necessaire);
}

/** Liste d'immats en HTML, avec nombre de jours optionnel (rouge > 60 j). */
function listeHtml(items) {
  if (!items.length) return `<p style="color:#1a7f37;margin:6px 0 0;">✓ Aucune — rien en attente.</p>`;
  const lis = items
    .map((it) => {
      const j =
        it.jours != null
          ? ` — <b style="color:${it.jours > 60 ? "#c0392b" : "#92400e"};">${it.jours} j${it.jours > 60 ? " ⚠" : ""}</b>`
          : "";
      const extra = it.extra ? ` <span style="color:#888;">(${it.extra})</span>` : "";
      return `<li style="margin:2px 0;"><b>${it.immat}</b>${extra}${j}</li>`;
    })
    .join("");
  return `<ul style="margin:6px 0 0;padding-left:20px;">${lis}</ul>`;
}

export default async function handler(req, res) {
  try {
    // 🔒 Réservé au cron Vercel (ou à un déclenchement manuel avec le secret)
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization || "";
    if (!secret || authHeader !== `Bearer ${secret}`) {
      res.status(401).json({ error: "Non autorisé" });
      return;
    }

    const dvApp = getDeltaVoApp();
    if (!dvApp) {
      res.status(500).json({ error: "FIREBASE_SERVICE_ACCOUNT_DELTAVO non configuré" });
      return;
    }
    const apiKey = process.env.BREVO_API_KEY;
    const senderEmail = process.env.BREVO_SENDER_EMAIL;
    if (!apiKey || !senderEmail) {
      res.status(500).json({ error: "Brevo non configuré" });
      return;
    }

    // Destinataires : Admin NE → 📧 Emails (champ rapport_adv_to)
    let recipients = DEFAULT_TO;
    try {
      const cfgSnap = await admin.firestore().collection("config").doc("emails").get();
      const cfg = cfgSnap.exists ? cfgSnap.data() : {};
      if (Array.isArray(cfg.rapport_adv_to) && cfg.rapport_adv_to.length) {
        recipients = cfg.rapport_adv_to;
      }
    } catch { /* défaut conservé */ }

    // 🚜 Lecture du stock Delta VO (serveur, comme le cron VNC)
    const snap = await dvApp.firestore().collection("machines_vo").get();

    const aFacturerResti = [];   // 1. restitution, facture de remise en état à faire
    const factureesPasReglees = []; // 2. restitution, facturée pas réglée
    const pretesPasFacturees = []; // 3. préparation (vente) finie, pas facturée
    const clotureesPasReglees = []; // 4. clôturée (vente facturée), pas réglée

    snap.docs.forEach((d) => {
      const m = d.data() || {};
      if (m.archived) return;
      const immat = m.immat || d.id;

      if (m.statut === "restitution") {
        if (!m.facture_ok) {
          aFacturerResti.push({ immat, extra: m.client_precedent || "" });
        } else if (!m.facture_reglee_ok) {
          factureesPasReglees.push({
            immat,
            extra: m.facture_resti_numero ? `n° ${m.facture_resti_numero}` : "",
            jours: joursDepuis(m.facture_resti_date),
          });
        }
      } else if (m.statut === "en_cours" && m.type_sortie !== "lld") {
        if (prepaFinie(m)) {
          // Date « prête » = dernière étape validée
          const dates = (Array.isArray(m.etapes_prepa) ? m.etapes_prepa : [])
            .map((e) => e.done_at)
            .filter(Boolean)
            .sort();
          pretesPasFacturees.push({
            immat,
            extra: m.acheteur || "",
            jours: dates.length ? joursDepuis(dates[dates.length - 1]) : null,
          });
        }
      } else if (m.statut === "cloturee" && !m.date_reglement) {
        clotureesPasReglees.push({
          immat,
          extra: m.numero_facture ? `n° ${m.numero_facture}` : "",
          jours: joursDepuis(m.date_facturation),
        });
      }
    });

    // Les plus anciennes en premier
    const parJours = (a, b) => (b.jours || 0) - (a.jours || 0);
    factureesPasReglees.sort(parJours);
    pretesPasFacturees.sort(parJours);
    clotureesPasReglees.sort(parJours);

    const dateStr = new Date().toLocaleDateString("fr-FR");
    const bloc = (titre, sousTitre, items) =>
      `<div style="margin:16px 0;padding:12px 14px;background:#f6f8fc;border-radius:8px;">` +
      `<div style="font-weight:bold;color:#1a2a6e;">${titre} : ${items.length}</div>` +
      `<div style="font-size:12px;color:#888;">${sousTitre}</div>` +
      listeHtml(items) +
      `</div>`;

    const html =
      `<div style="font-family:Arial,sans-serif;max-width:620px;">` +
      `<h2 style="color:#1a2a6e;margin-bottom:4px;">📊 Suivi facturation · ${dateStr}</h2>` +
      `<p style="color:#666;margin-top:0;">Delta VO · Delta Services — rapport hebdomadaire</p>` +
      `<p>Bonjour,</p>` +
      `<p>Voici l'état du suivi de facturation dans <a href="${APP_URL}">Delta VO</a> :</p>` +
      bloc("🧾 Factures de remise en état À FAIRE", "Onglet Restitutions — machines pas encore facturées", aFacturerResti) +
      bloc("💶 Facturées mais PAS RÉGLÉES (remise en état)", "Onglet Restitutions — ⚠ rouge au-delà de 60 jours", factureesPasReglees) +
      bloc("⏳ Prêtes mais PAS FACTURÉES", "Onglet Préparation — préparation finie, facture de vente à faire", pretesPasFacturees) +
      bloc("📄 Facturées et PAS RÉGLÉES (ventes)", "Onglet Clôturées — ⚠ rouge au-delà de 60 jours", clotureesPasReglees) +
      `<p style="color:#999;font-size:12px;margin-top:18px;">Envoi automatique tous les vendredis à 9h00 · ne pas répondre à cet email · ` +
      `destinataires modifiables dans Nacelle Expert, Admin → 📧 Emails.</p>` +
      `</div>`;

    const total =
      aFacturerResti.length + factureesPasReglees.length +
      pretesPasFacturees.length + clotureesPasReglees.length;

    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "api-key": apiKey },
      body: JSON.stringify({
        sender: { email: senderEmail, name: process.env.BREVO_SENDER_NAME || "Delta VO · Delta Services" },
        to: recipients.map((email) => ({ email })),
        subject: `📊 Suivi facturation Delta VO · ${total} machine${total > 1 ? "s" : ""} à suivre · ${dateStr}`,
        htmlContent: html,
      }),
    });
    if (!resp.ok) {
      const detail = await resp.text();
      console.error("Brevo (rapport ADV):", resp.status, detail);
      res.status(502).json({ error: "Envoi Brevo échoué (" + resp.status + ")" });
      return;
    }

    console.log(`📊 Rapport ADV envoyé (${recipients.length} destinataire(s), ${total} machines à suivre)`);
    res.status(200).json({
      ok: true,
      recipients: recipients.length,
      a_facturer_resti: aFacturerResti.length,
      facturees_pas_reglees: factureesPasReglees.length,
      pretes_pas_facturees: pretesPasFacturees.length,
      cloturees_pas_reglees: clotureesPasReglees.length,
    });
  } catch (e) {
    console.error("cron-rapport-adv:", e);
    res.status(500).json({ error: e.message });
  }
}
