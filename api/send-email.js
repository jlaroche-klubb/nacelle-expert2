export const config = { runtime: 'edge' };

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxi4yUjWBZmO-hd07ryP6bjx9Qvx25qAgYSomnOsa-0P3QRMofKyzcsKVAh9N2R-KWQ4g/exec";

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    const { to, immat, htmlRetour, htmlDepart, departOnly } = await req.json();
    if (!to || !immat) return new Response(JSON.stringify({ error: "Email et immatriculation requis" }), { status: 400, headers: { "Content-Type": "application/json" } });

    // Tout délégué à Apps Script : upload Drive + envoi email
    const emailResp = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, immat, htmlDepart, htmlRetour, departOnly: !!departOnly })
    });

    const emailData = await emailResp.json();
    if (emailData.error) throw new Error(emailData.error);

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  }
}
