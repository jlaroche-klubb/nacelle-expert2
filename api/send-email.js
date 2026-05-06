export const config = { runtime: 'edge' };
 
const RESEND_API_KEY = "re_GFYsMP3Y_FRLuxT3WGSfuf1XvdsRzWGky";
 
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }
 
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
 
  try {
    const { to, cc, immat, htmlRetour, htmlDepart } = await req.json();
 
    if (!to || !immat) {
      return new Response(JSON.stringify({ error: 'Email et immatriculation requis' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
 
    // Email 1 : État de départ
    const resp1 = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'Expertise Nacelle Delta Services <onboarding@resend.dev>',
        to: [to],
        cc: cc ? [cc] : [],
        subject: `État de départ · Nacelle ${immat}`,
        html: htmlDepart
      })
    });
 
    if (!resp1.ok) {
      const err = await resp1.json();
      throw new Error(err.message || 'Erreur envoi email départ');
    }
 
    // Email 2 : Rapport de retour
    const resp2 = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: 'Expertise Nacelle Delta Services <onboarding@resend.dev>',
        to: [to],
        cc: cc ? [cc] : [],
        subject: `Rapport d'expertise retour · Nacelle ${immat}`,
        html: htmlRetour
      })
    });
 
    if (!resp2.ok) {
      const err = await resp2.json();
      throw new Error(err.message || 'Erreur envoi email retour');
    }
 
    return new Response(JSON.stringify({ ok: true, message: '2 emails envoyés' }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
 
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
}
