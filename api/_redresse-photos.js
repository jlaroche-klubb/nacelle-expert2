// 🤖 REDRESSEMENT SERVEUR DES PHOTOS D'UN DOSSIER (validé avec Jonathan).
// ------------------------------------------------------------------
// Problème : le contrôle d'orientation côté téléphone dépend de la version
// de l'appli chargée sur l'appareil — une vieille page ouverte (cas du
// Samsung de Carinne : GC-104-XY, GC-315-TD, GQ-115-JH) envoie les photos
// couchées sans aucun contrôle.
// Solution : le SERVEUR (toujours à jour) refait le contrôle sur toutes les
// photos du dossier au moment de la validation (appelé depuis notify-rapport
// et notify-depart, que les vieilles versions appellent aussi).
// - vérification via /api/photo-orientation (projet delta-vo, IA vision) ;
// - rotation via sharp, ré-upload en Storage, URL remplacée partout dans le
//   dossier (même mécanique que le bouton ↻) — synced_to_delta_vo intact ;
// - best-effort : une photo illisible est simplement laissée telle quelle.
// (Fichier préfixé « _ » : PAS une fonction serverless — limite 12 respectée.)

import sharp from "sharp";
import crypto from "crypto";

const BUCKET = "nacelle-expert.firebasestorage.app";
const ORIENTATION_API = "https://delta-vo.vercel.app/api/photo-orientation";

function remplaceUrl(obj, ancienne, nouvelle) {
  if (obj == null) return obj;
  if (typeof obj === "string") return obj === ancienne ? nouvelle : obj;
  if (Array.isArray(obj)) return obj.map((x) => remplaceUrl(x, ancienne, nouvelle));
  if (typeof obj === "object") {
    const o = {};
    for (const k of Object.keys(obj)) o[k] = remplaceUrl(obj[k], ancienne, nouvelle);
    return o;
  }
  return obj;
}

function listeUrls(dossier) {
  const urls = new Set();
  for (const part of [dossier.depart, dossier.retour]) {
    if (!part) continue;
    for (const arr of Object.values(part.photos || {})) {
      if (Array.isArray(arr))
        arr.forEach((p) => {
          const u = typeof p === "string" ? p : p?.url;
          if (u) urls.add(u);
        });
    }
    for (const z of Object.values(part.zones || {})) {
      if (Array.isArray(z?.photos))
        z.photos.forEach((p) => {
          const u = typeof p === "string" ? p : p?.url;
          if (u) urls.add(u);
        });
    }
  }
  return Array.from(urls);
}

export async function redresserPhotosDossier(admin, immatRaw, ctxLabel) {
  const immat = String(immatRaw || "").trim().toUpperCase();
  if (!immat) return { ok: false, raison: "immat manquante" };
  const ref = admin.firestore().collection("dossiers").doc(immat);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, raison: "dossier introuvable" };
  const dossier = snap.data();
  if (dossier.archived) return { ok: false, raison: "cycle archivé" };

  const liste = listeUrls(dossier);
  if (!liste.length) return { ok: true, verifiees: 0, redressees: 0, erreurs: 0 };

  const bucket = admin.storage().bucket(BUCKET);
  const remplacements = [];
  let erreurs = 0;

  // 4 photos en parallèle : ~30 photos tiennent largement dans les 60 s
  const file = [...liste];
  async function worker() {
    while (file.length) {
      const url = file.shift();
      if (!url) break;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error("téléchargement " + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        // L'API orientation accepte ~1,4 Mo ; au-delà on envoie une miniature
        const envoi =
          buf.length > 1_400_000
            ? await sharp(buf).resize(512, 512, { fit: "inside" }).jpeg({ quality: 60 }).toBuffer()
            : buf;
        const resp = await fetch(ORIENTATION_API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            imageBase64: envoi.toString("base64"),
            ctx: `serveur ${ctxLabel || immat}`,
          }),
        });
        const j = await resp.json().catch(() => null);
        const rot = Number(j?.rotation) || 0;
        if (resp.ok && (rot === 90 || rot === 180 || rot === 270)) {
          const tournee = await sharp(buf).rotate(rot).jpeg({ quality: 85 }).toBuffer();
          const token = crypto.randomUUID();
          const chemin = `dossiers/${immat.replace(/[^A-Z0-9-]/gi, "_")}/rotations/serveur/${Date.now()}_${crypto
            .randomBytes(3)
            .toString("hex")}.jpg`;
          await bucket.file(chemin).save(tournee, {
            metadata: {
              contentType: "image/jpeg",
              metadata: { firebaseStorageDownloadTokens: token },
            },
          });
          const nouvelle = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(
            chemin
          )}?alt=media&token=${token}`;
          remplacements.push([url, nouvelle]);
          console.log(`🤖 ${immat} : photo redressée de ${rot}°`);
        }
      } catch (e) {
        erreurs++;
        console.warn(`⚠ redressement ${immat} :`, e?.message || e);
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);

  if (remplacements.length) {
    // Relecture fraîche juste avant l'écriture (limite les écrasements
    // concurrents) — synced_to_delta_vo et le reste du dossier intacts.
    const frais = (await ref.get()).data() || dossier;
    let maj = frais;
    for (const [a, n] of remplacements) maj = remplaceUrl(maj, a, n);
    await ref.set(maj);
  }
  console.log(
    `🤖 Redressement serveur ${immat} : ${liste.length} vérifiée(s), ${remplacements.length} redressée(s), ${erreurs} erreur(s)`
  );
  return { ok: true, verifiees: liste.length, redressees: remplacements.length, erreurs };
}
