export const config = { runtime: 'edge' };

const RESEND_API_KEY = "re_GFYsMP3Y_FRLuxT3WGSfuf1XvdsRzWGky";
const EMAIL_CC = "assistanat.commerce@delta-services.fr";
const DRIVE_FOLDER_RETOUR = "1HR5SzLhZr1aNd4AjlbKTGeqKWw1uCKbm";
const DRIVE_FOLDER_DEPART = "1dcJaSEQ9fR2W-cuFZ2Mo2h8QBGQZNzUk";

const SA_EMAIL = "nacelle-expert-drive@api-gemini-mail.iam.gserviceaccount.com";
const SA_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDMQB2eQwIKFi95\nJcgf23JXcsDQbBEa+XyLqVA/n99gVzpH5yRtg3jyZt+qZg7ebXRZE1MekvAQIOBE\niN+SKaKB8X3vAbNTmALxAytbqkSUT5D+UnfeUJQrvBfo09KT5mBGQnV0tFNuOo99\nTSmz/UOCTBrKosCanBTB9YCukLLjIyUiSAFUB7pVrnnVM3NBUXRt7r/HQVq7W2JM\npc1EUkVC9yShPvB00r6MSfpp8VLlCoK+MPZjXcZQmE+N52FhOlD8vRqj/pyX3OmU\nVkVTQCuD7pvEfLxGGeDh8SBJ77F5NDYLa9Hr0NA7INbz9AOr5zPLa+Ke7wYmZLtR\nOcXhYAp/AgMBAAECggEAGgn2fK2oPeb0KGqzp7QPUKy1fhy41YqG4Ts1mtbj4GFe\ncbo6/6cqLSUGUK/wJ1Um5xA6oYQ0DKpUTQhyEC00pYJG/shltzuC7Hzt8yKy2YGH\nR5T16Sa2rRiup6URjH9rOKnSVY2DsWLP1jaXIXYhPCQ9qiWzjkJltxB4VkjmNWSU\nUjbT3n/jmjWbTmBrgP9hS5iSa5BNAisaYnnu+/G4KdLcfdI2ckbRjG5fF+mhTdZd\nwccNUc36eXSErEkwmNGuuAN+LcrQo4RF0InujzZ+Hn4Rr1H+evQ/t3clAZr4P+oz\ngwsKqR5FdlpXvpbbma91eraOeCCP2kTdBplkUpIPIQKBgQDmLN9dsDf1cvWgaZ3N\ncEMGxCoERGUVESuMSVeUVWNVmWq7vEJW17DoebtW4TDj5oPt0B2qXLNq2R9OFv7M\nxbxsOUtsruwl3NacVIJOtY2+93I9yokQuyOBg5Ce0vdjrXpk2PEwWu+P3+Y01JnK\nQM/GqGg0W0r4xoDn71DVM3BVUQKBgQDjKqBfFmIarPEeqvzg8I7k8lwIsKVJLI7d\niF3laVm+vmIV9fh0ldTnWJKi+VUvje69na5Vh2gyPf3buLpouuuRzHn6Jq3T5c0d\n4pjiwbKg2i8WNGxmLLiUwLyYmxh7DhwRUeYoOa346iQ7cuPisIVMKZnX6gRTJdXQ\nZWu3Ky6uzwKBgA/USCwuQTrtA/1bJhIJxWJCvUz70yPGwYLtTEuUL7ekTFXK1ZkZ\nTj4+mOaZp/4UTUBejpu3slMHyYJaTH2Sn6mlqw03XmAgNtYbbbax/6SBaebb9d8j\nr4ZpoNl7Uq4VMRScYsHbjxwK3s8FS+o/2MolrLzlBlvjctwAdkOjPPdxAoGBANCc\nnJm13HHSz7ryGzgWsaLeTlZMof0Ixkn6qP+8N4ZLH5g7QecOkW3CkSbJAcmh9dR7\nsVUp/C3nb/EPO2BiB2Lk/D8Uth0Zs7v2E6BpcLj2pLcnfUR3XSp9tLQP+fNHic79\n/vaBwZoMqylM4KmUoVTH/1eguEgDPs8Z1Elphn1RAoGBALZ5gbwGOcXMngd1K5Su\nHJGsOQ9BHKaWuC+4yfxuzvsTUKl5Z99hV193bqm3VehCD/vcq3dZjQxbAwh0O5nK\nJweTsg75y6QeJf9cBmsuhYjqs8eL/N6y5ZSBmVsI/OplnnWf+OQ3JZ/Wzu5OiKeW\nmhxizNbbCsMyiOAYjOYEz9hb\n-----END PRIVATE KEY-----\n";

async function getGoogleToken() {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const now = Math.floor(Date.now() / 1000);
  const claim = btoa(JSON.stringify({
    iss: SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');

  const sigInput = `${header}.${claim}`;
  const pemContents = SA_KEY.replace('-----BEGIN PRIVATE KEY-----', '').replace('-----END PRIVATE KEY-----', '').replace(/\n/g, '');
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', binaryDer.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(sigInput));
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const jwt = `${sigInput}.${sig}`;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const tokenData = await tokenResp.json();
  return tokenData.access_token;
}

async function uploadToDrive(token, folderId, filename, htmlContent) {
  const metadata = { name: filename, mimeType: 'application/vnd.google-apps.document', parents: [folderId] };
  const boundary = 'nacelle_boundary';
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${htmlContent}\r\n--${boundary}--`;

  const uploadResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  });
  const file = await uploadResp.json();

  await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' })
  });

  return file.webViewLink;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  try {
    const { to, immat, htmlRetour, htmlDepart } = await req.json();
    if (!to || !immat) return new Response(JSON.stringify({ error: 'Email et immatriculation requis' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

    const token = await getGoogleToken();
    const dateStr = new Date().toLocaleDateString('fr-FR').replace(/\//g, '-');

    const linkDepart = await uploadToDrive(token, DRIVE_FOLDER_DEPART, `Expertise_Depart_${immat}_${dateStr}`, htmlDepart);
    const linkRetour = await uploadToDrive(token, DRIVE_FOLDER_RETOUR, `Expertise_Retour_${immat}_${dateStr}`, htmlRetour);

    const emailHTML = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,sans-serif;"><div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);"><div style="background:#1a2a6e;padding:28px 32px;"><div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:2px;">EXPERTISE NACELLE</div><div style="color:rgba(255,255,255,.7);font-size:12px;margin-top:4px;">Delta Services · Documents de restitution</div></div><div style="height:4px;background:linear-gradient(90deg,#1a2a6e,#c8102e);"></div><div style="padding:32px;"><p style="color:#1a2a6e;font-size:16px;font-weight:700;margin:0 0 20px;">Bonjour,</p><p style="color:#444;font-size:14px;line-height:1.6;margin:0 0 24px;">Veuillez trouver ci-dessous les rapports d'expertise de votre nacelle élévatrice <strong>${immat}</strong>.</p><div style="margin-bottom:16px;"><a href="${linkDepart}" style="display:block;background:#f8f9fb;border:1px solid #e0e4ea;border-radius:6px;padding:16px 20px;text-decoration:none;margin-bottom:10px;"><div style="color:#1a2a6e;font-weight:700;font-size:14px;">📋 État de départ</div><div style="color:#888;font-size:12px;margin-top:4px;">Constat d'état au départ en location</div></a><a href="${linkRetour}" style="display:block;background:#f8f9fb;border:1px solid #e0e4ea;border-radius:6px;padding:16px 20px;text-decoration:none;"><div style="color:#1a2a6e;font-weight:700;font-size:14px;">🔍 Rapport de retour</div><div style="color:#888;font-size:12px;margin-top:4px;">Constat d'état et dégâts constatés au retour</div></a></div><p style="color:#888;font-size:12px;line-height:1.6;margin:0;">Pour toute question : <a href="mailto:assistanat.commerce@delta-services.fr" style="color:#1a2a6e;">assistanat.commerce@delta-services.fr</a></p></div><div style="background:#f8f9fb;border-top:1px solid #e0e4ea;padding:16px 32px;font-size:11px;color:#888;text-align:center;">DELTA SERVICES · 14 Avenue James de Rothschild · 77164 Ferrières-en-Brie · Tél. +33 (0)1 60 95 47 80</div></div></body></html>`;

    const emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Expertise Nacelle Delta Services <onboarding@resend.dev>',
        to: [to],
        cc: [EMAIL_CC],
        subject: `Rapports d'expertise · Nacelle ${immat}`,
        html: emailHTML
      })
    });

    if (!emailResp.ok) {
      const err = await emailResp.json();
      throw new Error(err.message || 'Erreur envoi email');
    }

    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}
