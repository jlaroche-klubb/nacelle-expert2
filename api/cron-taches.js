// ⏰ TÂCHES PLANIFIÉES (une seule fonction — limite Vercel Hobby : 12) :
//
//   1. 💶 VNC compta   : le 1er et le 16 du mois (5h00 UTC) — envoi au service
//      compta du lien vers le fichier VNC du parc VO (ex api/cron-vnc-compta)
//   2. 📊 Rapport ADV  : tous les VENDREDIS 9h00 (7h00 UTC) — suivi facturation
//      pour la chef des secrétaires (ex api/cron-rapport-adv)
//
// Les deux entrées de vercel.json pointent ici ; la tâche à exécuter est
// choisie selon la DATE du déclenchement (1er/16 → VNC ; vendredi → rapport),
// avec un marqueur anti-doublon en base (config/cron_state) car les crons
// Hobby peuvent se déclencher avec du retard. Déclenchement manuel possible
// avec ?tache=vnc ou ?tache=rapport (toujours protégé par CRON_SECRET).
//
// Destinataires : Admin NE → 📧 Emails (compta_to / rapport_adv_to).
// PRÉREQUIS Vercel : FIREBASE_SERVICE_ACCOUNT, FIREBASE_SERVICE_ACCOUNT_DELTAVO,
//   BREVO_API_KEY, BREVO_SENDER_EMAIL, CRON_SECRET.

import admin from "firebase-admin";
import { buildVogWorkbook } from "./_vnc-workbook.js";

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

const NE_APP_URL = "https://nacelle-expert2.vercel.app";
const DV_APP_URL = "https://delta-vo.vercel.app";
const DEFAULT_COMPTA_TO = ["jlaroche@klubb.com"]; // ⚠ à remplacer dans Admin → Emails
const DEFAULT_RAPPORT_TO = ["jlaroche@klubb.com"]; // ⚠ idem (chef des secrétaires)

async function envoyerBrevo({ recipients, subject, html }) {
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender: {
        email: process.env.BREVO_SENDER_EMAIL,
        name: process.env.BREVO_SENDER_NAME || "Delta VO · Delta Services",
      },
      to: recipients.map((email) => ({ email })),
      subject,
      htmlContent: html,
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Brevo ${resp.status} : ${detail.slice(0, 200)}`);
  }
}

// ════════════════════════════════════════════════════════════════
// 💶 TÂCHE 1 — Fichier VNC au service compta (1er et 16 du mois)
// ════════════════════════════════════════════════════════════════
async function tacheVnc(dvApp) {
  const cfgRef = admin.firestore().collection("config").doc("emails");
  let recipients = DEFAULT_COMPTA_TO;
  let vncToken = "";
  try {
    const cfgSnap = await cfgRef.get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};
    if (Array.isArray(cfg.compta_to) && cfg.compta_to.length) recipients = cfg.compta_to;
    vncToken = cfg.vnc_token || "";
  } catch { /* défaut conservé */ }

  // 🔑 Jeton du lien de téléchargement (généré une fois, réutilisé ensuite)
  if (!vncToken) {
    vncToken = Array.from({ length: 48 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
    await cfgRef.set({ vnc_token: vncToken }, { merge: true });
  }

  const snap = await dvApp.firestore().collection("machines_vo").get();
  const { count } = buildVogWorkbook(snap.docs);

  const dateStr = new Date().toISOString().slice(0, 10);
  const lien = `${NE_APP_URL}/api/vnc-fichier?cle=${encodeURIComponent(vncToken)}`;
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:560px;">` +
    `<h2 style="color:#1a2a6e;margin-bottom:4px;">💶 Mise à jour des VNC · Parc VO</h2>` +
    `<p style="color:#666;margin-top:0;">Delta VO · Delta Services</p>` +
    `<p>Bonjour,</p>` +
    `<p>Le fichier du parc VO actif (<b>${count} machine${count > 1 ? "s" : ""}</b>, format VOG) est prêt :</p>` +
    `<p style="margin:18px 0;"><a href="${lien}" style="background:#1a2a6e;color:#fff;padding:12px 26px;text-decoration:none;font-weight:bold;border-radius:4px;">&#128229; Télécharger le fichier Excel</a></p>` +
    `<p><b>Merci de mettre à jour la colonne « VR OU VNC EUR »</b> puis de renvoyer le fichier au service ADV, ` +
    `qui le réintégrera dans Delta VO.</p>` +
    `<p style="color:#999;font-size:12px;margin-top:18px;">Le fichier est généré au moment du clic (données à jour). Lien réservé au service comptable. Envoi automatique le 1er et le 16 de chaque mois · ne pas répondre à cet email · destinataires modifiables dans Nacelle Expert, Admin → 📧 Emails.</p>` +
    `</div>`;

  await envoyerBrevo({
    recipients,
    subject: `💶 VNC à mettre à jour · Parc VO (${count} machines) · ${dateStr}`,
    html,
  });
  console.log(`💶 VNC : lien envoyé (${recipients.length} destinataire(s), ${count} machines)`);
  return { machines: count, recipients: recipients.length };
}

// ════════════════════════════════════════════════════════════════
// 📊 TÂCHE 2 — Rapport suivi facturation ADV (vendredi 9h00)
// ════════════════════════════════════════════════════════════════
function joursDepuis(dateStr) {
  if (!dateStr) return 0;
  const t = new Date(dateStr).getTime();
  if (isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

function prepaFinie(m) {
  if (m.type_prepa === "en_etat") return true; // vendue en l'état : rien à préparer
  const etapes = Array.isArray(m.etapes_prepa) ? m.etapes_prepa : [];
  return etapes.length > 0 && etapes.every((e) => e.done || e.non_necessaire);
}

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

async function tacheRapportAdv(dvApp) {
  let recipients = DEFAULT_RAPPORT_TO;
  try {
    const cfgSnap = await admin.firestore().collection("config").doc("emails").get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : {};
    if (Array.isArray(cfg.rapport_adv_to) && cfg.rapport_adv_to.length) {
      recipients = cfg.rapport_adv_to;
    }
  } catch { /* défaut conservé */ }

  const snap = await dvApp.firestore().collection("machines_vo").get();

  const aFacturerResti = [];
  const factureesPasReglees = [];
  const pretesPasFacturees = [];
  const clotureesPasReglees = [];

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
    `<p>Voici l'état du suivi de facturation dans <a href="${DV_APP_URL}">Delta VO</a> :</p>` +
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

  await envoyerBrevo({
    recipients,
    subject: `📊 Suivi facturation Delta VO · ${total} machine${total > 1 ? "s" : ""} à suivre · ${dateStr}`,
    html,
  });
  console.log(`📊 Rapport ADV envoyé (${recipients.length} destinataire(s), ${total} machines à suivre)`);
  return {
    recipients: recipients.length,
    a_facturer_resti: aFacturerResti.length,
    facturees_pas_reglees: factureesPasReglees.length,
    pretes_pas_facturees: pretesPasFacturees.length,
    cloturees_pas_reglees: clotureesPasReglees.length,
  };
}

// ════════════════════════════════════════════════════════════════
// Point d'entrée : choix de la tâche + anti-doublon
// ════════════════════════════════════════════════════════════════
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
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
      res.status(500).json({ error: "Brevo non configuré" });
      return;
    }

    // Quelle(s) tâche(s) ? Par la date du déclenchement, ou forcée par ?tache=
    const force = String((req.query && req.query.tache) || "");
    const now = new Date();
    const jour = now.getUTCDate();
    const vendredi = now.getUTCDay() === 5;
    let doVnc = force === "vnc" || (!force && (jour === 1 || jour === 16));
    let doRapport = force === "rapport" || (!force && vendredi);

    // 🛡️ Anti-doublon : les crons Hobby peuvent se déclencher en retard, et un
    // vendredi 1er/16 les DEUX horaires appellent cette fonction — chaque tâche
    // ne doit partir qu'UNE fois par jour (marqueur config/cron_state).
    const aujourdHui = now.toISOString().slice(0, 10);
    const stateRef = admin.firestore().collection("config").doc("cron_state");
    if (!force) {
      try {
        const st = (await stateRef.get()).data() || {};
        if (doVnc && st.vnc_last === aujourdHui) doVnc = false;
        if (doRapport && st.rapport_last === aujourdHui) doRapport = false;
      } catch { /* en cas de doute, on envoie */ }
    }

    const resultat = { ok: true, date: aujourdHui };
    if (doVnc) {
      resultat.vnc = await tacheVnc(dvApp);
      await stateRef.set({ vnc_last: aujourdHui }, { merge: true });
    }
    if (doRapport) {
      resultat.rapport_adv = await tacheRapportAdv(dvApp);
      await stateRef.set({ rapport_last: aujourdHui }, { merge: true });
    }
    if (!doVnc && !doRapport) {
      resultat.noop = "Rien à envoyer aujourd'hui (ou déjà envoyé).";
    }

    res.status(200).json(resultat);
  } catch (e) {
    console.error("cron-taches:", e);
    res.status(500).json({ error: e.message });
  }
}
