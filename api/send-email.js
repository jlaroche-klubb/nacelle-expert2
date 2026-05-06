export const config = { runtime: 'edge' };

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxi4yUjWBZmO-hd07ryP6bjx9Qvx25qAgYSomnOsa-0P3QRMofKyzcsKVAh9N2R-KWQ4g/exec";
const SA_EMAIL = "nacelle-expert-drive@api-gemini-mail.iam.gserviceaccount.com";

const SA_KEY_PARTS = [
  "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDMQB2eQwIKFi95",
  "Jcgf23JXcsDQbBEa+XyLqVA/n99gVzpH5yRtg3jyZt+qZg7ebXRZE1MekvAQIOBE",
  "iN+SKaKB8X3vAbNTmALxAytbqkSUT5D+UnfeUJQrvBfo09KT5mBGQnV0tFNuOo99",
  "TSmz/UOCTBrKosCanBTB9YCukLLjIyUiSAFUB7pVrnnVM3NBUXRt7r/HQVq7W2JM",
  "pc1EUkVC9yShPvB00r6MSfpp8VLlCoK+MPZjXcZQmE+N52FhOlD8vRqj/pyX3OmU",
  "VkVTQCuD7pvEfLxGGeDh8SBJ77F5NDYLa9Hr0NA7INbz9AOr5zPLa+Ke7wYmZLtR",
  "OcXhYAp/AgMBAAECggEAGgn2fK2oPeb0KGqzp7QPUKy1fhy41YqG4Ts1mtbj4GFe",
  "cbo6/6cqLSUGUK/wJ1Um5xA6oYQ0DKpUTQhyEC00pYJG/shltzuC7Hzt8yKy2YGH",
  "R5T16Sa2rRiup6URjH9rOKnSVY2DsWLP1jaXIXYhPCQ9qiWzjkJltxB4VkjmNWSU",
  "UjbT3n/jmjWbTmBrgP9hS5iSa5BNAisaYnnu+/G4KdLcfdI2ckbRjG5fF+mhTdZd",
  "wccNUc36eXSErEkwmNGuuAN+LcrQo4RF0InujzZ+Hn4Rr1H+evQ/t3clAZr4P+oz",
  "gwsKqR5FdlpXvpbbma91eraOeCCP2kTdBplkUpIPIQKBgQDmLN9dsDf1cvWgaZ3N",
  "cEMGxCoERGUVESuMSVeUVWNVmWq7vEJW17DoebtW4TDj5oPt0B2qXLNq2R9OFv7M",
  "xbxsOUtsruwl3NacVIJOtY2+93I9yokQuyOBg5Ce0vdjrXpk2PEwWu+P3+Y01JnK",
  "QM/GqGg0W0r4xoDn71DVM3BVUQKBgQDjKqBfFmIarPEeqvzg8I7k8lwIsKVJLI7d",
  "iF3laVm+vmIV9fh0ldTnWJKi+VUvje69na5Vh2gyPf3buLpouuuRzHn6Jq3T5c0d",
  "4pjiwbKg2i8WNGxmLLiUwLyYmxh7DhwRUeYoOa346iQ7cuPisIVMKZnX6gRTJdXQ",
  "ZWu3Ky6uzwKBgA/USCwuQTrtA/1bJhIJxWJCvUz70yPGwYLtTEuUL7ekTFXK1ZkZ",
  "Tj4+mOaZp/4UTUBejpu3slMHyYJaTH2Sn6mlqw03XmAgNtYbbbax/6SBaebb9d8j",
  "r4ZpoNl7Uq4VMRScYsHbjxwK3s8FS+o/2MolrLzlBlvjctwAdkOjPPdxAoGBANCc",
  "nJm13HHSz7ryGzgWsaLeTlZMof0Ixkn6qP+8N4ZLH5g7QecOkW3CkSbJAcmh9dR7",
  "sVUp/C3nb/EPO2BiB2Lk/D8Uth0Zs7v2E6BpcLj2pLcnfUR3XSp9tLQP+fNHic79",
  "/vaBwZoMqylM4KmUoVTH/1eguEgDPs8Z1Elphn1RAoGBALZ5gbwGOcXMngd1K5Su",
  "HJGsOQ9BHKaWuC+4yfxuzvsTUKl5Z99hV193bqm3VehCD/vcq3dZjQxbAwh0O5nK",
  "JweTsg75y6QeJf9cBmsuhYjqs8eL/N6y5ZSBmVsI/OplnnWf+OQ3JZ/Wzu5OiKeW",
  "mhxizNbbCsMyiOAYjOYEz9hb"
];

const SA_KEY = "-----BEGIN PRIVATE KEY-----\n" + SA_KEY_PARTS.join("\n") + "\n-----END PRIVATE KEY-----\n";

async function getGoogleToken() {
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const now = Math.floor(Date.now() / 1000);
  const claim = btoa(JSON.stringify({ iss: SA_EMAIL, scope: "https://www.googleapis.com/auth/drive", aud: "https://oauth2.googleapis.com/token", exp: now + 3600, iat: now })).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const sigInput = `${header}.${claim}`;
  const pemContents = SA_KEY.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\n/g, "");
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", binaryDer.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(sigInput));
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_");
  const jwt = `${sigInput}.${sig}`;
  const tokenResp = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}` });
  const tokenData = await tokenResp.json();
  return tokenData.access_token;
}

async function uploadToDrive(token, filename, htmlContent) {
  // Upload dans le Drive du compte de service (sans spécifier de dossier parent)
  const metadata = { name: filename, mimeType: "application/vnd.google-apps.document" };
  const boundary = "nacelle_boundary";
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${htmlContent}\r\n--${boundary}--`;
  
  const uploadResp = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body
  });
  const file = await uploadResp.json();
  
  if (!file.id) throw new Error("Upload Drive echoue: " + JSON.stringify(file));
  
  // Rendre public
  await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" })
  });
  
  return file.webViewLink;
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    const { to, immat, htmlRetour, htmlDepart, departOnly } = await req.json();
    if (!to || !immat) return new Response(JSON.stringify({ error: "Email et immatriculation requis" }), { status: 400, headers: { "Content-Type": "application/json" } });

    const token = await getGoogleToken();
    const dateStr = new Date().toLocaleDateString("fr-FR").replace(/\//g, "-");

    // Upload dans le Drive du compte de service
    const linkDepart = await uploadToDrive(token, `Expertise_Depart_${immat}_${dateStr}`, htmlDepart);

    let linkRetour = null;
    if (!departOnly && htmlRetour) {
      linkRetour = await uploadToDrive(token, `Expertise_Retour_${immat}_${dateStr}`, htmlRetour);
    }

    // Email via Apps Script
    const emailResp = await fetch(APPS_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, immat, linkDepart, linkRetour, departOnly: !!departOnly })
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
