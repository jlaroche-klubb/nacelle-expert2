// 📧 Email « Devis à chiffrer » adressé à l'atelier Nacelle Assistance —
// construit ici pour être partagé par notify-devis (1er envoi, depuis
// l'appli) et valider-devis action « relancer » (relance depuis Delta VO).
// Fichier préfixé « _ » : pas un endpoint Vercel.

export const DEFAULT_DEVIS_TO = ["jlaroche@klubb.com"]; // ⚠ à remplacer dans Admin → Emails
export const APP_URL = "https://nacelle-expert2.vercel.app";

const esc = (s) => String(s ?? "—").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

export async function destinatairesDevis(admin) {
  try {
    const snap = await admin.firestore().collection("config").doc("emails").get();
    const cfg = snap.exists ? snap.data() : {};
    return Array.isArray(cfg.devis_to) && cfg.devis_to.length ? cfg.devis_to : DEFAULT_DEVIS_TO;
  } catch {
    return DEFAULT_DEVIS_TO;
  }
}

/**
 * @param d { immat, cle, type_nacelle, modele, lieu_restitution, agent, client, contrat, postes[], relance?: { numero, par, date_demande } }
 */
export function construireEmailDevis(d) {
  const lien = `${APP_URL}/api/devis/${encodeURIComponent(d.immat)}?cle=${encodeURIComponent(d.cle)}`;
  const postes = Array.isArray(d.postes) ? d.postes : [];
  const row = (label, value, alt) =>
    `<tr${alt ? ' style="background:#f5f6fa;"' : ""}><td style="padding:6px 10px;color:#666;">${label}</td><td style="padding:6px 10px;">${value}</td></tr>`;
  const relance = d.relance;
  const titre = relance ? `🔔 Relance — devis toujours attendu · Nacelle ${esc(d.immat)}` : `⏳ Devis à chiffrer · Nacelle ${esc(d.immat)}`;
  const bandeauRelance = relance
    ? `<div style="background:#fdf3ec;border:1px solid #e8c9a8;border-radius:6px;padding:10px 14px;margin:10px 0;font-size:14px;color:#8a4a10;">` +
      `<b>Relance${relance.numero > 1 ? ` n°${relance.numero}` : ""}</b> — la demande de devis${relance.date_demande ? ` du ${esc(relance.date_demande)}` : ""} est toujours en attente. ` +
      `Merci de déposer votre devis dès que possible (délai convenu : 48 h).` +
      (relance.par ? `<br><span style="color:#999;font-size:12px;">Relance envoyée par ${esc(relance.par)} · Delta Services</span>` : "") +
      `</div>`
    : "";
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:560px;">` +
    `<h2 style="color:#b3541e;margin-bottom:4px;">${titre}</h2>` +
    `<p style="color:#666;margin-top:0;">Nacelle Expert · Delta Services</p>` +
    bandeauRelance +
    `<table style="border-collapse:collapse;width:100%;font-size:14px;">` +
    row("Nacelle", `<b>${esc(d.type_nacelle)} ${esc(d.modele)}</b>`) +
    row("Lieu de stockage", `📍 <b>${esc(d.lieu_restitution)}</b>`, true) +
    row("Expert", esc(d.agent)) +
    row("Client", `${esc(d.client)} (contrat ${esc(d.contrat)})`, true) +
    `</table>` +
    `<p style="margin:14px 0 6px;font-weight:bold;">UN devis global à établir, couvrant ${postes.length > 1 ? "les " + postes.length + " postes suivants" : "le poste suivant"} :</p>` +
    `<ul style="font-size:14px;">${postes.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` +
    `<p style="margin-top:18px;"><a href="${esc(lien)}" style="background:#1a2a6e;color:#fff;padding:12px 24px;text-decoration:none;font-weight:bold;">📎 Déposer votre devis PDF (photos incluses)</a></p>` +
    `<p style="font-size:13px;color:#444;margin-top:10px;">Établissez votre devis comme d'habitude, puis déposez le PDF (ou une photo) sur cette page — rien d'autre à faire. Les secrétaires Delta Services vérifient et valident ensuite de leur côté.</p>` +
    `<p style="color:#999;font-size:12px;margin-top:18px;">Lien confidentiel, valable 30 jours, réservé à ce dossier. L'expertise sera transmise au client une fois le devis validé.</p>` +
    `</div>`;
  const subject = relance
    ? `🔔 Relance devis · Nacelle ${d.immat} (${d.lieu_restitution || "?"})`
    : `⏳ Devis à chiffrer · Nacelle ${d.immat} (${d.lieu_restitution || "?"})`;
  return { html, subject, lien };
}

export async function envoyerBrevo({ to, subject, html, senderName }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  if (!apiKey || !senderEmail) throw new Error("Brevo non configuré");
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "api-key": apiKey },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName || process.env.BREVO_SENDER_NAME || "Nacelle Expert · Delta Services" },
      to: to.map((email) => ({ email })),
      subject,
      htmlContent: html,
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    console.error("Brevo (devis):", resp.status, detail);
    throw new Error("Envoi Brevo échoué (" + resp.status + ")");
  }
  return true;
}
