import { useState, useEffect, useRef } from "react";
import { db, auth, googleProvider, storage } from "./firebase";
import { collection, doc, setDoc, getDocs, deleteDoc, getDoc, updateDoc, query, orderBy, limit, startAfter } from "firebase/firestore";
import { getStorage, ref, uploadString, uploadBytes, getDownloadURL } from "firebase/storage";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import html2pdf from "html2pdf.js";
import { DEFAULT_TARIFS, buildExpertiseResume } from "../api/_tarifs-defaults.js";

const ADMIN_PASSWORD = "nacelle2024";
const EMAIL_CC = "assistanat.commerce@delta-services.fr";
const REMOVE_BG_KEY = "EwW4qNTWQbKeGVs1GaQkiX3W";
const APP_URL = "https://nacelle-expert2.vercel.app"; // production — utilisé pour les liens courts /api/rapport
const PAGE_DOSSIERS = 60; // pagination : nombre de dossiers chargés par page (accueil + « Voir plus »)

// ─── Alerte automatique par email à la validation d'une expertise retour ───
// L'envoi est fait CÔTÉ SERVEUR par la fonction Vercel /api/notify-rapport
// (destinataires fixes définis dans api/notify-rapport.js, envoi via Gmail).
// Silencieux en cas d'échec : ne bloque jamais la sauvegarde de l'expertise.
// ─── Dossier « En attente de devis » : alerte atelier + rapport provisoire client ───
// Appelé à la validation d'une expertise retour contenant des postes sur devis
// non chiffrés. Silencieux en cas d'échec : ne bloque jamais la sauvegarde.
async function notifyDevisEnAttente(dossier, tarifs) {
  if (!dossier?.immat || !dossier.devis_pending?.length) return;
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) { console.warn("📧 Alerte devis non envoyée (non authentifié)"); return; }
    const headers = { "Content-Type": "application/json", "Authorization": "Bearer " + token };
    const postes = dossier.devis_pending.map(id => (tarifs.find(t => t.id === id) || {}).label || id);
    // 1) Alerte « devis à faire » à l'atelier Nacelle Assistance (lien de saisie inclus)
    const r1 = await fetch("/api/notify-devis", {
      method: "POST", headers,
      body: JSON.stringify({
        immat: dossier.immat,
        modele: dossier.info?.modele || "—",
        type_nacelle: dossier.info?.type_nacelle || "—",
        client: dossier.info?.client || "—",
        contrat: dossier.info?.contrat || "—",
        lieu_restitution: dossier.retour?.lieu_restitution || "—",
        agent: dossier.retour?.agent || "—",
        postes,
        cle: dossier.devis_token,
      }),
    });
    if (!r1.ok) console.error("❌ Alerte devis :", r1.status, await r1.text());
    else console.log("📧 Alerte devis envoyée à l'atelier");
    // 2) Rapport PROVISOIRE au client (mention « en attente de devis »)
    if (dossier.info?.email) {
      const r2 = await fetch("/api/notify-retour-client", {
        method: "POST", headers,
        body: JSON.stringify({
          immat: dossier.immat,
          email_client: dossier.info.email,
          modele: dossier.info?.modele || "",
          type_nacelle: dossier.info?.type_nacelle || "",
          provisoire: true,
          nb_attente: dossier.devis_pending.length,
        }),
      });
      if (!r2.ok) console.error("❌ Rapport provisoire client :", r2.status, await r2.text());
      else console.log("📧 Rapport provisoire envoyé au client");
    }
  } catch (e) { console.error("notifyDevisEnAttente:", e); }
}

async function notifyRapportExpertise(dossier, tarifs, isUpdate) {
  if (!dossier?.immat) return;
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) { console.warn("📧 Alerte rapport non envoyée (utilisateur non authentifié)"); return; }
    const vt = getVetuste(dossier.info?.annee_fab);
    const md = dossier.retour?.montants_devis || {};
    const total = (dossier.retour?.degats || []).reduce((s, id) => {
      const t = tarifs.find(t => t.id === id);
      return s + montantPoste(t, dossier.retour?.quantites?.[id] || 1, vt, md);
    }, 0);
    // "+ postes sur devis" : uniquement s'il reste des postes sur devis SANS montant saisi
    const surDevis = (dossier.retour?.degats || []).some(id => {
      const t = tarifs.find(t => t.id === id);
      return t?.surDevis && !md[id];
    });
    const resp = await fetch("/api/notify-rapport", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({
        immat: dossier.immat,
        modele: dossier.info?.modele || "—",
        type_nacelle: dossier.info?.type_nacelle || "—",
        client: dossier.info?.client || "—",
        contrat: dossier.info?.contrat || "—",
        date_retour: dossier.retour?.date || new Date().toISOString().slice(0, 10),
        lieu_restitution: dossier.retour?.lieu_restitution || "—",
        agent: dossier.retour?.agent || "—",
        nb_degats: String((dossier.retour?.degats || []).length),
        total_retenue: total.toLocaleString("fr-FR") + " € HT" + (surDevis ? " (+ postes sur devis)" : ""),
        type_envoi: isUpdate ? "Rapport d'expertise mis à jour" : "Nouvelle expertise retour",
        lien_rapport: `${APP_URL}/api/rapport/${dossier.immat}`,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      console.error("❌ Alerte rapport :", resp.status, t);
    } else {
      console.log("📧 Alerte rapport envoyée aux destinataires");
    }
  } catch (e) {
    console.error("notifyRapportExpertise:", e);
  }
}

// Normalise une immatriculation au format SIV "AB-123-CD" (majuscules, tirets)
// dès que la saisie correspond au motif 2 lettres + 3 chiffres + 2 lettres,
// quels que soient les séparateurs tapés (espaces, points, rien...).
// Hors format SIV (engins, plaques étrangères) : majuscules simples, inchangé.
function normalizeImmat(raw) {
  const s = (raw || "").toUpperCase();
  const compact = s.replace(/[\s.\-_]/g, "");
  if (/^[A-Z]{2}[0-9]{3}[A-Z]{2}$/.test(compact)) {
    return compact.slice(0, 2) + "-" + compact.slice(2, 5) + "-" + compact.slice(5);
  }
  return s;
}
// Photos de ventes (remplies après l'expertise) — détourage Pro+ uniquement sur les 2 extérieures
// Lieux de restitution autorisés (champ OBLIGATOIRE de l'expertise retour)
const LIEUX_RESTITUTION = ["EGI", "Ferrières", "Avignon", "St Alban"];

// Types de nacelle par défaut — liste modifiable dans le panneau ADMIN (onglet "Types nacelle"),
// stockée dans Firestore (config/types_nacelle). "AUTRE" est ajouté automatiquement au menu
// et ouvre un champ de saisie libre.
const DEFAULT_TYPES_NACELLE = ["KL 32", "KL26 TRQ", "KL26 CC", "KL 21B", "KL 38P", "KL 38P TRQ", "KL 42P", "KL 17P"];

// Menu déroulant "Type nacelle" avec option AUTRE → saisie libre
function TypeNacelleSelect({ value, onChange, types }) {
  const inList = !!value && types.includes(value);
  const [autre, setAutre] = useState(!!value && !types.includes(value));
  useEffect(() => {
    if (value && types.includes(value)) setAutre(false);
    else if (value && !types.includes(value)) setAutre(true);
  }, [value, types]);
  return (
    <div>
      <select
        value={autre ? "__AUTRE__" : (inList ? value : "")}
        onChange={e => {
          const v = e.target.value;
          if (v === "__AUTRE__") { setAutre(true); onChange(""); }
          else { setAutre(false); onChange(v); }
        }}
      >
        <option value="">-- Sélectionner --</option>
        {types.map(t => <option key={t} value={t}>{t}</option>)}
        <option value="__AUTRE__">AUTRE</option>
      </select>
      {autre && <input value={value || ""} onChange={e => onChange(e.target.value)} placeholder="Saisir le type de nacelle..." style={{ marginTop: 6 }} autoFocus />}
    </div>
  );
}

const VENTE_SLOTS = [
  { key: "vente_3_4_av_droit", label: "3/4 avant droit", detour: true },
  { key: "vente_3_4_ar_gauche", label: "3/4 arrière gauche", detour: true },
  { key: "vente_habitacle_av", label: "Habitacle avant", detour: false },
  { key: "vente_habitacle_ar", label: "Habitacle arrière", detour: false },
];

// Function to upload HTML report to Firebase Storage and get public URL
async function uploadReportToStorage(htmlContent, immat, reportType = "depart") {
  try {
    const storage = getStorage();
    const timestamp = new Date().getTime();
    const filename = `rapports/${immat}_${reportType}_${timestamp}.html`;
    const storageRef = ref(storage, filename);
    
    // Upload HTML content
    await uploadString(storageRef, htmlContent, 'raw', {
      contentType: 'text/html',
      cacheControl: 'public, max-age=31536000'
    });
    
    // Get public URL
    const url = await getDownloadURL(storageRef);
    return url;
  } catch (error) {
    console.error('Upload error:', error);
    throw error;
  }
}

// Function to generate HTML report from current page
function captureCurrentPageHTML() {
  // Clone the document and clean it up for standalone HTML
  const clone = document.documentElement.cloneNode(true);
  
  // Remove no-print elements
  clone.querySelectorAll('.no-print').forEach(el => el.remove());
  
  // Get the HTML
  return '<!DOCTYPE html>\n' + clone.outerHTML;
}

// Génère un PDF à partir d'un élément DOM et l'upload sur Firebase Storage
// Renvoie l'URL publique du PDF
async function generateAndUploadRetourPdf(element, immat) {
  if (!element) throw new Error("Élément du rapport introuvable");
  console.log("📄 [PDF] Début génération pour", immat);
  console.log("📄 [PDF] Élément trouvé, dimensions:", element.offsetWidth, "x", element.offsetHeight);

  // Attendre que toutes les images soient chargées avant la capture
  const imgs = Array.from(element.querySelectorAll("img"));
  console.log("📄 [PDF] Images dans l'élément:", imgs.length);
  await Promise.all(imgs.map((img, i) => {
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise(res => {
      img.onload = () => { console.log("📄 [PDF] Image", i, "chargée"); res(); };
      img.onerror = (e) => { console.warn("📄 [PDF] Image", i, "échouée:", img.src.substring(0, 80), e); res(); };
      setTimeout(() => { console.warn("📄 [PDF] Image", i, "timeout 4s"); res(); }, 4000);
    });
  }));
  console.log("📄 [PDF] Toutes les images traitées");

  const opt = {
    margin: [10, 8, 10, 8],
    filename: `Restitution_${immat}.pdf`,
    image: { type: "jpeg", quality: 0.85 },
    html2canvas: {
      scale: 2,
      useCORS: true,
      allowTaint: false,
      logging: true, // Active les logs de html2canvas pour debug
      backgroundColor: "#ffffff",
      onclone: (clonedDoc) => {
        const removed = clonedDoc.querySelectorAll(".no-print");
        console.log("📄 [PDF] onclone: retrait de", removed.length, "éléments .no-print");
        removed.forEach(el => el.remove());
      }
    },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait", compress: true },
    pagebreak: { mode: ["css", "legacy"] }
  };

  console.log("📄 [PDF] Lancement html2pdf...");
  const pdfBlob = await html2pdf().set(opt).from(element).outputPdf("blob");
  console.log("📄 [PDF] Blob généré, taille:", pdfBlob.size, "octets");

  const cleanImmat = (immat || "no-immat").replace(/[^A-Z0-9-]/gi, "_");
  const storagePath = `rapports/${cleanImmat}_retour_${Date.now()}.pdf`;
  const storageRef = ref(storage, storagePath);
  console.log("📄 [PDF] Upload vers", storagePath);
  await uploadBytes(storageRef, pdfBlob, { contentType: "application/pdf" });
  const url = await getDownloadURL(storageRef);
  console.log("📄 [PDF] Terminé, URL:", url);
  return { url, path: storagePath };
}

// Ouvre la messagerie avec un email pré-rempli contenant un LIEN COURT (/api/rapport).
// Pourquoi : les URLs Firebase brutes contiennent un token avec des caractères '='
// que certaines messageries corrompent (encodage quoted-printable) → lien mort.
// Le lien court, sans '=', passe par une redirection Vercel vers le bon rapport.
async function openEmailClient(emailTo, immat, reportType = "depart", dossier = null) {
  const isDepart = reportType === "depart";
  const subject = isDepart
    ? `État de départ · Nacelle ${immat}`
    : `Rapport de restitution · Nacelle ${immat}`;
  const shortLink = isDepart
    ? `${APP_URL}/api/rapport/${immat}/depart`
    : `${APP_URL}/api/rapport/${immat}`;

  try {
    if (isDepart) {
      // Publie l'état de départ (page HTML) et mémorise son URL dans la collection
      // "rapports_links" (cible de la redirection /api/rapport/{immat}/depart).
      // Collection séparée : ne crée pas de dossier fantôme avant la validation.
      const htmlContent = captureCurrentPageHTML();
      const reportUrl = await uploadReportToStorage(htmlContent, immat, "depart");
      await setDoc(doc(db, "rapports_links", immat), { depart_url: reportUrl, updatedAt: new Date().toISOString() }, { merge: true });
    } else if (!dossier?.retour?.pdf_url && !dossier?.rapport_url) {
      // Ancien dossier retour sans PDF : publie une version HTML comme cible de la redirection
      const htmlContent = captureCurrentPageHTML();
      const reportUrl = await uploadReportToStorage(htmlContent, immat, "retour");
      await updateDoc(doc(db, "dossiers", immat), {
        rapport_url: reportUrl,
        rapport_url_at: new Date().toISOString(),
      });
    }
  } catch (error) {
    console.error('Préparation du lien rapport:', error);
    alert("⚠ Le lien du rapport n'a pas pu être préparé (" + error.message + ").\nL'email sera ouvert quand même, mais vérifiez le lien avant envoi.");
  }

  const body = (isDepart
    ? `Bonjour,\n\nVeuillez trouver ci-dessous le constat d'état de départ de la nacelle ${immat}.\nCe document fera référence lors de la restitution.\n\nConsulter le rapport :\n${shortLink}\n\n`
    : `Bonjour,\n\nSuite à la restitution de la nacelle ${immat}, veuillez trouver ci-dessous le rapport d'expertise complet (état de départ + état de retour).\n\nConsulter le rapport :\n${shortLink}\n\n`)
    + `Cordialement,\nDelta Services\n14 Avenue James de Rothschild · 77164 Ferrières-en-Brie\nTél. +33 (0)1 60 95 47 80`;

  const mailtoLink = `mailto:${emailTo}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}&cc=${EMAIL_CC}`;
  window.open(mailtoLink, '_blank');
}
const DELTA_LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAicAAADICAYAAAAz3UGjAAABCGlDQ1BJQ0MgUHJvZmlsZQAAeJxjYGA8wQAELAYMDLl5JUVB7k4KEZFRCuwPGBiBEAwSk4sLGHADoKpv1yBqL+viUYcLcKakFicD6Q9ArFIEtBxopAiQLZIOYWuA2EkQtg2IXV5SUAJkB4DYRSFBzkB2CpCtkY7ETkJiJxcUgdT3ANk2uTmlyQh3M/Ck5oUGA2kOIJZhKGYIYnBncAL5H6IkfxEDg8VXBgbmCQixpJkMDNtbGRgkbiHEVBYwMPC3MDBsO48QQ4RJQWJRIliIBYiZ0tIYGD4tZ2DgjWRgEL7AwMAVDQsIHG5TALvNnSEfCNMZchhSgSKeDHkMyQx6QJYRgwGDIYMZAKbWPz9HbOBQAAC6FUlEQVR4nOydd5xcR5W233OqbqfJQSONcrYlOSLD2mDcEsEJg8F2yzbJRJPzsonQasMuu7AsfGRMXsDgaZPBa1jWUpNsgwWOcpIly1YOo8kdblWd74/bPbF7lG2F++hXmpkO99ZNVaeqznkPEBISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhLyNEHPdAVCJqVyfeQZrUXIoUBIJtVR30tuhRv5IyN4Zu8VAtLBPZtcyxPe7egQZJcK0gAy1b6eAarX/3CO6cCvQ0eHIJu1h7Gv6iST+ohv82iQy1kcgfsnDegVSALIVX1/bY3vLQNkFXDkz3/IcUlonBwfEEIDJeRASAsn167mXG69AFmHo37fpDmZBOdWwCGTcfv9+EFDQPqjDABprMbatauHjZ5cDg44GvsMeQYJ27oQAKFxcqxCwfNJDCAK0BAg4UN7fEAAZObMc1tdtOXFRVJKWRM8ZwrBuHD0T2BkrFjt/Wo/Kx8mJ431TQ+5Yq8Z2Ld7cNeuuzdjzMiTkEpdpbLZo2GkpDmYARkxDqZORV2sKTkrHu2o6x7sPQXsEWABRwJhUiqyq719+g6RAvnGil8qoVTah5K/D34JSEh037Rpp3Rv2bKJeOcDsh3bAcABKBxCBQmAzF784nk+qeeWfBIlQtXPJQClwK6Y37Hxtz8HYA75tIxj4cKF0SGZe7mhqAc7aoej53IO5F7AuM9Mdo9Mtp3x27MKUL4oeCTo/c2ODX/YjcMzEGIfamm/fKGuj9xX7DvNQbzRbxLIzY/GHvA0+yVr4cOCAElA0cZiaduneveuEYAobOtOekLj5BgkmUzqXC5npix5yddUJPasHff+6JxUKsVHp5MJObKkFJC1U+auuKhpxrNuMxQFO0DoyF22MWt94iBiAFsqAfQEbOlxZwfuKPbv+8POx2/9HYa7oqBeR6QCqZSqLH+0Lrp0SX1dU4qpMUledAlIpkFFCewBMu6YRUAIiogrv135XUDEQ8y6zzgfEANYHyLW115ko7VGnCkh4iXWG2Py5PoH4O/56eb1/3tv2ZAfs7NkMq1zuYyZf9orP67aFn7INwUQJq40Vc4ksQfJ7x5qeOqnHfft3DmIwx/BEwA544wXdwzFT93pvMbgOh1jTa6QgATwyEPEPL7igTt/kBt9fQ+UFKCygHtBXeuLPtPW8ps5EOSFwKNPYfmMEoKhVrAGSXAAGojwB+sPXdO3eVZ/H7olnEE56Tk+1kJPJlIplctmzbQFyYujLYvfRJFGzFhS+M9sNvuB5cuv99atu9F/pqsYMhlLBQAa2qZsM05Zx+QEjiZ01EcMVuAoEUcjRHoxES1W1HEJJ/KY0zL7fvTt/dbmR7NfA7IDqVSXymZXHZ6BUu642uYsP7Wu/bSPkNee0pGEJ0JlI8NCRARObJW+hYPZQAIFP4IxMqjSZSccUYKVV36FQMH7szQo+ChkhRaC0jMxuPVvzQDem0yu1rlc9dkOF4n1wCnjhAxBqrd3BCEREl3XvZtnCrDzsE5RgAAgMM8Uy/F9TmwDQAKRY8o6EQEY7HwSJmo/5Lbl7ckkZXM5ubax4cKFQnbIFH0irnq+K3cFlQuD4IvYMzwv8Xo99WX/Dzu/nQZU5gjOYIUcf9QaSoQ8I6QZt9xiW1oWzPJaFn1PVJ2zvu/rtiXvn7bgRa9Zt+5G/7hxrjvJcdYwQRSJ0wTRBBylIkRiAbEituisKVjrF42QchTvON3rOOW/Zi9/27oZiy56STa7yqbTacahDt/Lhsm0JS99W8O08/+i6ha9klXEM37RWFOw4koCsUIQqnHMXOmQhhEBgvoDYgXOCJwRcb6ILYkzRedM0TqTt8bPW+PnjTHFgvFLBqwGD6DWRLCaZJJrUHlP5Og4MIsdu59jrZTvUTl0w4lW5HJ2OtC2RNRrSiiqPEeijkjbAyrQeYZuFYdnxSJXA8BqpMJZk5Oc0Dg5dqBkEgwR1M+54GtcP7PNWd+RGG057iLti788fd75i5HLmWCKPiSkQnkKgoiJSIGgyTHDFFzJFQ0npi6OTln2y9nLUp/IZDIO6fQEG2F/pCqGySmX/32i9bQvwWusd36fcWJARJqIVDANQofQwVWqU/l+uVBwTCAoECkKStChEjREwvbrGGANoAiQ69varlkUwdSCVUbBHuSNQFxwInMJLzw1EllMyNp02D+d1IQX/1ghmVa5XMZMW/LST+jGWRe5Ut5okGYwkSlAYlPquHnBra1AI6TLIbx2ITUhgCxAYCVaw887QxEbbV36T/POeO2NyGRcKtV1EDMoKZXNdrkZi1b8Xbxlzqcc2MCWHBH0seZDEfL0syJwWo4ujSSuT4iIhTDj4BxGCCBfxC5VnveSuqZXB9tNhm3cSUx48Y8FUimFXMY0zzvvsnjT4n/ypWSJRFVcxhSIxfet1zhrQfzMq74PIlq+fLlC2DOE1CSYjRByADGzs6rgCiXdNP/Ns5et+nQ2u8qWDZT9k14qAEk0sfC/yGuFkwIF3qU04i0SclLSFcyauGsTjStO0+qMvHNCBD7YNRkC4JNQg3O4INb0XABYgY5waeckJjROnnHSjK4uF21cuKC+5bTv20jMkZWKu2AZgYJRvi8m0nTKZdOWXPEv69at85cvvz70PzlRCLxJD76MbKD2tskB0FDivKIUfK9l7vs7F174ymx2lUVqP0uEqZRCJuOmLXxRUuqbnutM0SnRB7GsKCg7lhy5QpCJoUDHJp6XcADZ4HrhUK7vwR3nId1HQb2IDj6kLJVKAQBW1Ne9fg6xGBE3mbk6+Q5Y9cHJLLYXXFzfujRc2jm5CS/8M0vgZ0IkHfPP+4JumNUotigM4rFPcTA+ZfKVsWSiLXPTbQsueNm6dTf6CBwcQ45TWAQQBmmPSceZdHSkeON+lgtrj0l7LFozgeHgjAgJ1XTBkMBAEU1kRRmOSLxhwacbG2e2Irs0CCupQXLXUgIA5bW9HjoexP3W/HjldQfAQUSsg7IETULeESzQwh6BD8W/5ekiqNrewUfqiKWJvAST9tSYa+uNu8ajfmcdZdYxZiiiA7XDiMAqwqRjte+h8feSF2V4MU06ymwP2iGYOJu1nfX17Ut0/OKSteSIqmyjHDdMFh4xpIaJwhBYp+xcpbxLEg2vIIRLOycz4cj7maTiZ7L0yo/oxoUX+6bPKFGaML6/GP6dSAoKKoFY62k/nCr+c3ZmMg8AaQ6VMo9PHAmEAFPY9QRbGiSMXP1aP4MVeg2ldJ1jmqu9Rg0ROFscLcM1ivL9Qw4sxFIqGmmcMq1p1vPe3fdgZvVkIca5FXDIgaKJhtnimAAioVq3mgv2JRoAidaecpKHmKJlQan6d0YHlo7utMYe8ejPCZRhGC2uUGObxw7F3j4Xie39qy3moxAzEhCNWtd21GvkA6puLkXq6sg5qe1sLEKkSPyhvDWFjWPe2e9+BELshMDA4AAAYOnSA7KG1gBqJWDe7dW9/lSPmoq+GCaa0KeQAGBgQDS2O4NTFMNIdRPXANwoBvM0rhXgEyuw1oar1ycnoXHyTJFKKWQzZvq8i17kNc+7oehKxnNaUVkUCShrwo6DCLBCVmkdZVAseHV9+PQer4h2HgxT//bXPfHwL3M4CPGpOUAMiy49FbGmpB9JfFDXdc4Q40/uLE2B8rB11nmxKe+q71z8hWz26j3l74y3OqisAKsF3lyIQMjQZGJmEAYxQZCnYt+WX4jp/o5nBh+IQPUHnxk6kEObFCIlErdUtGYAAHK5zLGohyEAsHXrn7dg65/POYTvEwCZ95x3fYsp9jorQxZUo70WOFKesqb/gSf/+s3nHEadAw4wDcEKpB2QiZ0ejbw65gx6SLGecAsBhuBaCPyIpQd/Xyr99qxE/XsGxLfAxFkWIsdFw24R09JV9c3n0wD9rizwFubcOckIjZNnBkZXl2tZcE6TN2XejVB1otwgE6lgVDXO1BAICAwSB0ueVex0seeRt+3Y+Ke7D0XNMeTYwZGFYYZEOwI3o9TNjOzVB3A9BZuBAh679R4A9wCN35135kv/lRtnv9UZsQRR1YxbgUCImI1vON7S2ty+/OUD2x/9OpJpRq56p5RMAk8VoyRwGD2zM3HbBAKckC/F3kfftv3+X33tIE7FCcwhjB2StyvkXmCcF/HBBzopWg7AEkegg/ZJxcG4twSOsBn71vbOZy/29BlFQ06T5WqHqkUckeIH3OD//HKg8MVVibr3NEOzDwMlgJQnhIIJFkGBxM1QWicTiVTXQM/vygJvB384Icc14Xre0w+lUl0EIqlvWnYTxabNc3bIMVTNaxF0CAILWK2j2u/ZcMuOB379lWQyqUPD5PiGhUBCZSlMAZBFJUpr8gIgyIrHyWRag/q7N937/beVerf8ytOecjVHmjSsIu6YREeiVwNAesXqSXtAIoKUl21qdbUiZFl77AZ779h+/6++lkqJCkQD0xyY3JWfo0tF5GT076P/rvW54deOAw7keo4vawEIyDlioYMwG2TUz4MtB04KgSPsufDeO0uslMhVVZ1xgHgk6gmHwj1Kfe2uYu+Tj9rSk/VB+hyRUStVlSVLR44hBot05DIA3gtzuWNP9z/kqBMaJ083ybTKZlfZjiWXf0I1zL3U+nnDYDWZnzwJw8E49mJKBp5Yv+2+m69DKqVyQYrzkJMXATIul8sYyAUa6TT3bLz/H0qFXYPEmmp6HiLwnXTWEKhuRdPUM+dmMuQC4+HQoSCSBh7cGiDNu3atpkA0MOOC9aTKz9Gl0jPSuJ6SRv2s9jk6+B415IiQBpiQtefGW2csidBF/QwIhKs57hLExVnTo9b84evbtj0KwD1u6TdWCZRjW+0CEogLztr5Ss19R8uUFzgAXWFfddIRXvCnlUDPZMqM86+KNS/+JyPGKDhNACYzTgRWRHkihR47tHfzKwEMIVt+a4RwZHFSkzPJteCBgXvW2+LAjZo1C2QS45VIxFmKNeu6ljnnAgBSh+e7VBnfl0p5Fzpon7hUImhekfDePN/jOucrqwAau4woICEoYfQB+HOx+EOU26iNJfOd7QJ4NfofAmCFpIMZz4k2pICRmZqQk4fQOHnaSDOky8VbF86s61zyRfJiQtbnSi6y8f4Bw06xACyzZVLK73vinbufWHNvMFU+ZjmnPFN/bCUVC3l6yeXWCwAy/Xt/YEw/iHjy0FBxQqyg4s3nACNhw4dOsNLiwlblRIZWIGcBxJZGYq+NWcCwZaGx1okjgk+QKEM9ZOzeL3Xv/FFlLe5z+7ave8LYbVqDq2WHBAAHVmJ8zGG5HGhr4KC9C9u3k4iwGXl6oFRqGYFI2mae80PUzeywtuCUMNeama6kFHcQo3VUu77NX93x0M+/kkymdTBVPgwDkGnT6qdUQjGehuMJOSbJOgCyY9Nt9zt/4ElWmsYKtU2ASABG9GwAyO3H7yQkpCtI3ihva2t78VLtzSs4Ywk0oR8hYUScWM2ERyx19QI9tyOpXZAXLP+k5f9T5ImWGrN7RJSHtYsZ7f88JfZiAShdNUw+5EQlNE6eDsp+JtOXpj6iWxY/z5h+o4UVQYIcKDVwcJa9uPaHdv516j3fe1cq1aVyuczIF4IMxa751EteG533qnvap79wMQAJEwOetEgq1aUAFMiW/gxSkEBVteqHiYREHIi9hQCiyHBZqCQkpDqV5ZWkil0/DVaKqBqgA8DBI+ENTuF/h3q/DwBfQk5WI0sA8IDtu2Wfs6Rq+FcTLMSx1LPGMvLeCEDCTMUnF6FxcrQp581pn7/iJZHmWTdYa6yWIL4/8FQfuQSj9U0crDgdg5T2DZb2/O3160B+NpsFhnuaNCP3O9Mx+5z5Dc3zPo3ErOl1nXO/ByCKQFI67GROQnbtejC47ix3luO8ahonAJMTB2GZ1tr6nCnlzx2p+ya8/04wKo6w5zR1zJ/nRV+cFwui6rMZArIRrXij8e/68cC+OwRCWcBmAEsAvrtX1m5ydleUWbmqNyjBMpS1Fgu1vuC0jrqp5aWdsM86SQh1To4uLF1dLjZt7txE6+Jvi65z4vIEaKr2PA4HWAKwiq3nnLZ9W964a9Nd9yGZ1hgRm6JUahllsxKLtC39sYp2tPuFvpLXMOfZM8+49qtbsqtel0ym9TEqThVyFMlhLQDAlMxmFS/CEU+ccx+NiJCKqkRzW0t3N7YAaQCZw6oDEQmIZGu8WyGVEoxyZhzt1jhsSO2XtQCAXEeHhKHzzxwrkOQMcu7lynv/IqWjRVMyRGpCHyIAPLHopygeNMUbAbjVWKEBGADikFKEbN+WUsPvzk6oq1h8i3HKsoGZzOS7kpnnRepfUWq+9gEMfnYNkrwSuXD58SQgNE6OHoRkmonIdC57zc1U39FuSyWrwWpY5nscw34mAhPhuDa9G7741IM/vnmCoREsE5nO01d9STfOO9OWCoaZIr7N+17Tgus6Tr303lwu8xkkk+P9U0JOdMpaVYX+naVYwzSAvCCtzrBo+hgIIAsVU44xB8D9SK2nciTYIWON8SDCG277fDF4ZWSDh7npkGcOKjvC1p8dUVcqycMhcLie0JIJSZxY3eWXej/tD/6EAGQwIntQWdp51PrZfvBVCjQhIQJD4ERQIkUtTrBI4Q0APhfK2Z88hMbJ0SKZVshlzKxlV3xItc19jimVjCLRkwfUCETIKi+m/cEn795yz/ffj1SXyo3Oe5JMauQyZtrii18da5p3vW9LhtlpEgJZo40iG29c+J/tC/7ud3tyuXWB/0k42jx5WOGAHBqiiUfEWpCn1aSK+GJA7CHaNruIDYe3ZyHSzhYRibe8a+5Zb7oyEm/YYq2FiBOyJVhxEOdgxAex6vPiLY+zMzDWh4ODKxWgxYrxDQEoNTa1PgAi8QtFEXZU9Hfu2HL/rb/DQUj8hxwZ0oAiwLyrfeqlyyLetIItWVQkrcsEOtYCErLiKb2hOPij3t7efZJKKRo145UpCwR+ww789mJf956ivKZB8SW4UWl4W0E4MlTJOrfI8067INF0Jg3R30I5+5OD0Dg5GpTz5kxZ+PwLuXHRx6yzlkkU7SfSlxyLjRBJfpctdK9/JUAlZLMKY/xMbjCts5+z1GtZ/FUHz7HLK4IHgoBEk3NFklgrx5tO/1Fb24bT975z6SAyVfOmhJzA9PXuUA2NswGJYfJ+nISIURrqmwMAOIxw4mByRkDxlkYi3VgCnUo6eKMSRkYAYpU/yj8VymEYiaCeSgBAUKJghlG0BekGxAreHwA8H6kUh8s7Ty+rkZIMslgRjbxmChx6hCekISQBHAisfd5iIvjdYPHrALAqO2G+TARppr7Mvo3xhrvO1HxhP8QpGRv6TuX/CnDuFI7oy+L1L//dUO/f3o4kZStThCEnLKFz0ZGH0dXl6js72xNNy26ykQjIGmIhGta6rIrAMmzU+lzqe+Stezbe9RhSV42e9SDgBgcIJ9pO+xHFWhNWCsKIUGCYAICDkgg7k7eqYcac+KxLvo5MxiWTh6f8GXI8kREA8KSwh5h6g9xqVaQ7hyFAFJyfnwEAycPaNwHCEOfEmYKDyVtn8tb5eSt+wUqpYMUvWGPz1jdD1jdDJih545u8MX7BOL9gnCkYZ4rG+MZY3zfWmpK1BcMU6Tus6oUcEmVHWHdpfeuSuYRLCtaKVHOEJYFA2UYwP2rtXT/o33dXxRF2/EfXYi0DkHt8d2sPMaJOiavROFowaxjMi6irAXjl5aVwbecEJ+y0jiyUTKYZRNIy86KvUP3UNvKLjjg4z8NZQoaRQGFcGBZiyItq07f1i7sevv3rSKbH5s1JpwkQNf1Z131JN3WeCn/IKtGq8txLWWaWBNBwyvp5E2mYt2r6kks/mMtlDJLpcJbsJOLymefuYxXpVQI4mlx/GOSgvLh/+HsVgACGIyKwECkMFygwFAiKhZQSVgqslbDW5aJAGjRSiKBB0ARWRKJdjciQkKNLWRFWrqxruXohxVQRsLU6DgWHfta4l+zXALi1WFH1mq0tO7X+qr83t8EaiZIoqqHeRxAuWecWa++Ulza0LidAUmHfdcITXuAjSTKtcrmMmXna5R/R8dlXWr9gGKRq+5kQCAzDvmMvoW3v5gefuu8HH0CqS2G0nglAyNzgGmfObGKKvdq4iBPyg1nVMdm2CCAHgMGA8mFMrHHJJzoXr3gechmDVKh/crLwyJ5HlAPUgblmHMkQYin7C9DoLH5jP0Hji5TL/uoYDpafAWgFcrYO6Jil7NvI+mJRXXnYgMXTTm0olfZ9c6j/xwRgJarn/8oATtJpXu8P3bvD4I9KKaqVboFA8J1y8+HkhfG6VxOArlDO/oQnNE6OFGU9k+a5z7+cGhfdYKxvGKImT51KELEiKioY2p0v9jx4BUBFZB8cn9RMkLpK9W3Z0o3SU5d6poeF4iLkS62tE0Cwlk2kQammhdkpU5ZOQ1fXYSd3Czk+OKX9FAuQDd1GQw6HsiOsvLm98+XLtOrIw1qqIZymxdqIaDxk+RdP9vbuc8FgqOYduDYTLO08afmWkjC8GsuPBEJJCVsCnapxmQCeCuXsT3jCjurIwLjlFtvSsmBWY8uS7zov7lgMU9llbPykepCHoryoo8gqcaqw54l37dn0l0eR/KgenTStC1BpIHAATKXUlvtv/V1hz8avKBVRFmQrCrPVJu4Zip3rszoxuzM6a/mNIJJkEozwoT6RIQD48e517TClFgAg2V/OJYZz5rDNmEooPImUUwgLBCJBoaAIjbwUFAeBg4gTEScoFxGHSoGzcGxFJkSchhxlViPtANB5OnpdPVjEMXEVG0IAaCJ+CoLbh/JfA4DsREfYMVSWdu4a7LvlKWcGNYuurhgo8MRx0cIu0GrOWxsaXuQACjMVn9iEF/fwCfxMRCL1c57zHdXY2UAmLyTe8Lmd0DWUU/RZiGGd0H7Pxq/u3HTrN5JjhdaQBnhVoKoYhC1ksy6ZTOvtj/7sva5v452kG7WhwOlkYvdDIDgoeMqYfqMb5rx06qlXfqzsfxIu75ywpAEASriVxDXI/pdsCBB49W0PAECuY/0hGykkAAtDACcEC7AFEYGYUPnHRESaiDwi9ggqwkGJMqsoKy4XHWXSUSYdY9KRCHn1iiANh1q3kIMnBShCxr2sqf2spZrPtaYoVpFy48N0AmycmR81pft+MLD7DgFoFWDTANcqALAGSZ3Nd2/fKvhrlBWq5YIKDF2GWCtTwTgr0fgaAJJKhUs7JzKhk+ThUvYzmb7kpZ/QjYtWlkzBeEKa4GrOZxIAC2eVl9BuYMsftt9/87vG65l0AWoVYN/dMeut8M0Dn9u3/Q8pQGVzcCAyg5vvf0PdosSdHG2rt8YXJprg9lj5W4F1yVkTa13w4anzL7pzZy7zq1Cg7cSmpWWGX9AeQA7kGFLTJ5YAlCDAYTvECjlYErAoVq4UbNs5gKgkzgHD8ygmmCgBEStvJ5EacgKIGEAcxAoAA7iSQISIuIeiu0pkem4HACxdGi5WPQ10IQVCFpdFYm+ZzcT9IkYJ2FWxTVgEQ0R4pGS+AsCuDfoWk9mPhMEN5dmTh333y+fqyPMVSlUzVRIAy6RgBfNJXdYOdHI2ux2h5s0JS2icHA4VPZO5Ky/0mk/5B9+VjCe2rLVWKw2EBKMDHWMp7NvTu+uR1wLkI/sgo/yQpQB1NWAvqqtb8ZZE/MtPmvyTn9uH07vS6QFkMkJXpVR3NvtQdPfU10U7639sWRsR0cDIEHl8X6Scz6JjLtqx4CszS+eeueV3v+sO/E8y4VT5iURZ4bXX8rwoRyAijqh29msAcM5JIb+zeLi7JqdsVClV6H3sx6WB7V8Vier6upYnoom6fhnaQ0XqlXwhD+TzyKOAfB5oryvu2bplS/6gepdMeM8+DRAja2cCrfM9XCtWQE4rx2Mz4ZAAliD1DHWPsYOfKw12BY6wwYzugmjjwqkRT5VQqroTTWTjRchtZt8DL7RTMJNIVXMmIQDCoEFYe2pEN7y1dcp5H+/e/eM0oDKBLH7ICUZonBw6TLfcYptbls2Kty28SbwYKVNkQFEwSh1rmFB5KccRxLF22vma809d3fvk7zeVjRwLBEs5q0UcEbW8qWnKD2eLb6dF47O/3Dn7W5TJXLkmmdTIZk1Z0v4nnYn6z0Tblr3PmLzRojTIjUkgOLx/KHamZHW0faadsvBn2HLnhanUslI2G448TijKImrsNU1l9uCMX/YAqYYIiBWMs00Y2LQTALKHMyvhxHEEwt5ftj/x+98cyDe27Kv2Ko35AVceq69eTaFh8vSwBlArAXN9R+cVy3SssWh8SzwxlNsyAeKsZq03Fos/3dbfv/fWhQujl27YUHxlQ/sl76pP/MJTAh9xxVVcn7TAR53mCLl8HUowUFUXjQJfpmC9sIUJSyKxVwP48WqkXeYwc0GFHJuExsmhQclkmnO5jBefffr3VN3MtpLttxqqpi+HK49dHWC1imju3ZjeeN9Pbk8m0zqXHUnotyKZZCIy35gx90uXRPTUfdaYWNGYV0SjV2xt73zPylzu/61BUq/MZWzZQPmHWWc1nOs1zjnPyIBl0hPCR8sSKCCQ8m3RV40Lz59+6pX/kc2uevfy5dd769bdeAQ0LkKOBZII0usQ/DOJFAQlCdb7aridEIOk2N+3a9NA8MIRaOiFEkBKLVw4TW/Y0Frl3hqzj/GRaSN/Vl4dWbAMjeiniRUiFkTeYvI+UC+CXghxtXxgECQc+EnSkjP5L49+76yE9/IzokoVSsYAXiUKYOS7BGhxnq8cAK63sn8ZayFw0fmYzuqyRfH4DMpntgKhAvaJSOgQewgsX369zuUyZtriV3ws2rT4At8N+lo8RTWej+GWVcQqHdNu4Infb7znu/+KwLgY9jNZg6RamcuZDzRP/dQl0cg1A9Y3IK0LLCrmjHlFXew/r6xrWvEC5EwK4Fwu40BkStv/9EpX2NELnWAH64L9jW1IqBx0rMV5YorGa1vwrmkLX3zVunU3+qH+yYlDbkXgPE0UOVekkqykVl4dCJGCiGzfsWPD7ooA/eHXQhyQtTNmtNpg2XB8wegSGhzHGClAEZG8uqXh2WdpPjVvxaFGcmtycFGteL0tPvSdfdvvFAhdsmFDCYA+AzpprMIAg/MkGBpX8iToVyS+EymKiD2A7ogBMo7MqVp5r2qouxQA1oT92AlJeFEPllRKrVt3oz9jweUrYu3z3u87Y1igA8OklsIhwYk4UjFGYXf3QO9fXwmQRW6kcU4B6gXImZcnWi+8trHp72PWNz5YsVgwgQYEvEAp/Ybmtm8I0NSFtAgguOoqtXPnI0/k9z3xemWHRCjqAJHxeXwqf5JwWTUg6mIt87/TOu3sJbjlFhvqn5wQEDIZ17pwYQN5saUiBiBwrftSAMfEEFd6DAClUjdPqksRcnLQVY6C+Tuv/j0zlIIR57jGXUEEyTNhhy1+jgCbXbrMI0Aua4yfPU3HFhfFl6gjZgiUjORRUghyKCkBCRExhGoN7sYjAmoQwakcfR0ArKgh3hZyfBN2SAcHp5culZaWZbOobcZNTjcxS4lZeFKBcAiJVcpBhsjfs/lt3Rvu3xLkzQnWz9MAd4k4QWPrG5obv7NIGRl0xDw88LUAEfcZZ5JRnv/1qbO+Sci4tcmkQjZrkUzrXY/d9pNC76bPRRRrS8pU9E8m1oXB4pGVQXGJzkRi+pnfhQgjtWxyvbiQY59kUgFC8fjpF3lec7Oz1mJCerbREEBWyB/4KwDZtevB8PqHMGez9tQEOk/nustK4gRlMcnxOEASBH7QyND/6+/9JQA8WH7v3EjLVbO0JSPWQhRqhB8DOPhGx1fEJSuygKPnXBydsoBAkg77shOO8IIeOLR8+fUqk8m4hjnnfF3Fp3Y62+/Y6UkjIQDAkrFRimi37/H/2vb4rV3JsXlzKn4m8pXO5m+tjEWm9VlxzJVEE4FzrRDBE6sHjDEvSdRd8Y9Tpn5wZS5n1iSTGrmMRTKtdzzwo382/U/eobTnmVqjCQo8X7QoZU3BqMaZy2csu/aLyK6yof7J8U2q4x0CkJBuepuoCPa7DE9EzhbJH+j7MwDkcoeucXKCcLIfPyq5SS+Ltr1zSQSJkrWWSKha+LASsR5r2uD7tz6Wz291SKnV61MGAE7z1PmeABaaDI8W5qtdRupAkEm6JiWgPDk7X1PkJU2xywFQOf9PyAlEeEEPlGRarVt3oz/9jCv/nhtnXuj8vGGwqoTGTHRED3TTLJzlSFzb/if+sOXBn/zLeD+Tr2K5XpnLmX9s7/yXl8bjLxvyS4bG5eMhEEgcHBGskPKkZF5e1/TJVa2t574gF/ifBEtEVOjd+9ArXX7vgHianLAjoXFhxYFzJAnDE6etMSbSMvutMxZf9hrkMiaZTIZO0scjy5d72ewqO/WUC1ZGox0rrR10VDNRngBiHbFSUhrane/Z9cfg9exhORWSCBwxtE4Ax+EsnDjnlUoDJ7mBLg4APzdSd0VCLCwRC41tQ4LwYQGT4u3OubuKQ18FgLcgy4SMO7utbfpM1qeXrJUg+ZcTAcqSwBj3+8hPV1YUZgkyL9SCy8KCUXGYpflVAGRFjRw+IccvoXFyIJTz5kyZ+/wLvbo5n7IOluCqhsYNIxqGfEc6QpTv3jqw+55rQFQc72fyFqzzXzVt5rNfVR//cMKUbJFI0bgB3EisBUEYNCCOT4PIq+uabxKguSudFkFGkLpK9W6+64nC3vVvV9awVeys8lE7KIvAzihLntPNs7/eNPvcZ+VyOQOEDrLHEbR8+fUe1q3zm5rQHK1f+k3rRURZoLZ9IHDwnKaIsBu4rbv7z32pVNdh+5sIEbEIxOXPAiC7dx83qRJIxAkpmVJSTcsCB/HlJ52R3gUoAuH6po6Vp0X04oKzlqr0EUKAcnAxZfkRI+u/1tv9fwKhayvtmvOuma9UgwASBVNkuKgqv4/5CQ9MxFrY1b4VK9qSBefcYvJOf11Lx+kEhEs7Jxgn3QN4CDC6ulxL68JZkfYlN4lXL2zyRAj8TGrZJ0Iijj3RpqT87oev795y79ZAlTUIG04DvBrimqM09xrt/XweEO+Gcxo8aWNOAkRFcw/5dqWn532+c+ZNlMlcWtY/qYQXf3d6pPn5sY5lby4YZYiMrpUeUIkm35aE4x2RhvYlN/U+eeezke4aRIZC/ZOnE62RSnWpLB5UqVTXfj+eBYBsygEk69bd6Dc1nT6/ZdFzvqfiU+caM+QcqdrLjcIQIoIboKHenT8DgOyuLx62ESEkLMZ3lGi6sHnKWWeuX5+5FyAgdbM6kkLjWQApANnsg7I/EUHFkBp56kZBgHOOoo2qsX3Oe/uz2WsAskinGeuX0eHUfbiuSx+UY12jJZVKAdmsnJeIXD+DhHuFzERXEYElgEWJOMJ653+DAFmLFXpFKiXIZtGYiK7shrMDIJ9I1Ojvjgi6TvxpxXksZCOOVaNmYVf7whGAkoibqY13ViT2BgDvW40UZTB5Pp+Q44fQOJmcQM+EyDSc/sqvU/20NlvKW11OGT7eMBFCWSocsLBWKa2LezZ9evtjv70VY/PmBH4mOTKfbZn938mIN63XLxlNSh+IPeDIgcCq4PvmFYnYJds7Zrx3ZS732Yr+SSrVpbLZVe+cFa17tte46Cxr+60SpSp6JyP1DhoFDbD188ZrmHPK1DOv+urODL1yXH1DjgoCQAnDwAxsQDZ7owVgD6Z5nT17eackZl3HDdPeT/GpU4yft0ysHFVPBhnslhx7iopDOx/dsWHzryFCoNrz6LkcMO9cQdBcVFf6BAACkRMjpFvirfPP+3Zdw/QPb9146++RXdV3pLuMA91eYWhQReOY3C8YAEiU853EmmZfNWPpy7/otj/6H9szmScPZl+1OE66S0I2685sxYxFHHlJ0Yg4gpo4FUEgEYkR832QoZsH9t4MACuRs8gGjdcdMG/7/ZCfqNPuoFSHewuuqd+LDKninud8vKH9+3MA5MtTN9XuZRdM1GER7BUA/kEhG+o1nUCExslklPPmzD79in9QLfMu9P0ho6DL56zK0yJBcI0Ta1UkoUv7Nt2x/aGb/x6pLoVReXMqeiYfnjL9g1fH488fNHkD4oO4FgICMERK1RvYq6Pepza0tt75gu7cnSlAZbOrBESlvu77rmj0mu5DvC0hJu8IXGUlquyDQqKtP2hijUuunbbkst/tyGW+EubfOdoQQIadaKhI5xenn/7KTYbBJIEn68TxJYEgUDCkVQJK1zWKUqcp3dhkSWDNoGNSKlDTrJ1Lx7JzESe6UOr/V2D9AFas1qgpAR7s2fl5R7pxv8dDBIYpiXjtZ0Wm1f9yTnPnFlGx+8UUykdyJGbjnNMqxsV9W7+z7fFfdKVSKZUdcTAHMJLAUKG0Ec5HYJ1MtmsCwaeS0irSdtrbpW7Ga+fRivuslV4xPjDZOsN+KqtUhKXYs37z/T/8YNkQPOZmJNcgqQg5cwNNffspGnV+yRlF0NUqKiAbY6sfL5pb1w0NbRekFGHk/H9/69Yth1mdDa+KtfzLqZHIsqI1DqqGxgrAxli72PNmv7px2gu/17fj113lZKmHuf+QY4DQOKlFOW/O1AUvXMGNcz/mO7ZKlGJBzSRqLIAl6zii2OV3dOd33nct0mlG5sFhh/QuQK1EzrylpeV510QTn2AUrRVWgQ+s1B7tVkFDKG8dzYko9aZE4qZfd3c/qwvoAyB01VWqN5vdFI12Xl8Xjd9kyDMONkgPW3UfhEB2wFrdvPhzMxatvGNrbs29gf9JNnzYjx7kAESb5y0heEsIbniUX5HsLtu8kGHzJLidAldCA2uNZQETaa6d4K+MiNVeVJd6Nz229b6uHwX3Z6bW9RWkblbIrjIMPCFM82FIghpPFqFM5GzRgRQ4MXMmQc1E/MjZuCICrWMoDux8DEDXrrJk/xjK0xWusPdhMQMOuo5R02ArV1sUPCNwVLSINtQ7jjxXobIodIj2hDiwroNhPR1AIMF/DC6XrsBaC1BsueddG3EifSysMJzuaxgBEHPEO0jhb4WhGwEgO25uSABafYi+RsuWLtWp9ev9tDE3D8YjN2gLZ2uE7hCAIkPalcY5Mffm7/XhtlQ6LciEcvYnAqFxUp3Az2TBgqZEy6nfNrouovwhxxKhES/ysovqqGUSIStEnjhT4KG9m17fs+Nvm7F+4XDnngY4hbTMQmb6yxuafziHHfcYEiIiRwI9SRaUWhCDB3xnz40k5n18+vQf0LZtl4zLv/ODmdGmZ6v2xe+zJTEKooPgZARBG8PibACICNYnidR5uvnU7zQ2PvaCvotSvchmj8kG9URAwCA4OOs7EV/GO0NXg4b/JxDAQk5ZQuXvKrjArBERYiVcGMTg4I7XAhjE+vUKk8QcJ3c9SDkARX9wY4TsSsL+uvhyHYkYEFiXdwQRMjy68pWDn8wFYbQn+JjXBMpYyWuABmvXIOsAoS0b6eHZLUue0JH6eWLESble1fpOxwIIwEJKrAhswY2EuY6beKlVT0z424rklYP0TXK6nlHKjrDuHW3NF57qReaVrLNMUFKeoR2NAC6qmdcb98jn+natkcCUHmPc0sTo4AMmvX69WQXISwb3fX9j3PvwAtYRKzaYbqpyc1soRVZwmlIrADRwJtOPkasSchwTejdPhFKpLgIR6urP+4mtb5tDfsESNAu58uM68pSMGCaAIWWhPSV9Wz6y9/Ff/3ycnglWJJNMyLgbOud89fnKm9lrYZnABIE6BMOkvGeAoIZMyayKNF78yWmz3rIylzNrkAxClpNpveWBrn8o9e+4gyIJLYGi24R9VfxRQMzkFy3XtZ9ZP/uCm5BdZZOh/slRg4Z/KmaCIqL9FhApEBRIVCAFTOV/1RBANEhIwGyYlR7a+9gN3Rt+e2cwOzj5rFhF+6QwtK1L+SVyTDSZBsV4GMQEVmAEhUYVPsCfY14TBXLB71J9ur9y4MnkagXAd6Wem0EeWYirZZgAGE7xIBSc0pFzTSN14P3Uc/zfCOpMwsfsM5RKpwWAnKka3ztdFIpkQYG08AS0iPMZuNsMdAEwa5E8oseVAZwgzb8qFjc+aeWuBAt8Jic1fIaUCOXF2IU60fqe1hkvFoDSqBVCH3I8ERon40mmVTa7yk475SX/ppvnrfRNyTCo5s0eZBomOBHr6Zgu9T1x+5b7uz5eJW+OXpnLmX/vnPHeS+KRywZN0RChRhTNwUEAfJCKuKK9KKr/36tbpjz3BciZrhH9E+P23P9Kye/ugdIkZIIRIU3cDgvABFXyrfHa5l40bekr3pfLZQyS6XCW7biEAFgHIqcR8Qp7Hv6v7Y//Io1xhnNtsg7pNHdvuP12f2DbX5TnKTg5LvyQcrmMA4RsccN/ufyOHlZREhEHCZu9CilAcSbjzozFnnem1s/Pi+98Vkpo4mDJARJhVo/6Nv/rAftVAnA09EXWYi0DwANGfpSHIOpqr1USAENOOoTxLC1vACCrkT6mo6JCDozwKR1NWc+kffb5l0Val/6Tdb6JWtGTypkAAHwH7bEd2r21uPmv1yGdZuQyw3omFT+Tq+Ntl18aiXxGO98USSuQq+m/UpmiF4gTiFQMh2C9fyIMUA+IFpBEr0zU/VTq0JGCuDQyQOoqtXPzXU+UBh9+A4lhQcTJ8HZGib1VqiIELb6ylmy0cfZ/tsx+/kuQy5gwQeCxz9hlCHGWrGEdYRZf5Qcffs/Wh370AaS6FHI1/UwmbjIDAGR7hx5/iwz1DGkd0XAwAofgPnq6Z9DlQD0aHFKrePuj6/aU+jZ/QDlRUFoEYgVSViE9uZvAtyNJAuD1dS2XLPag82Rd3JTbmnEInPOYcL9xt9+Z797qkFL78TI+JNYi5wDgZy5/y2OOByME7WqsJgoB7EgV4WOhp887vamphYPw8uNBXydkEk7uJ3MsjKVLpX7awimJjqXfghcTcsJCQNXFzgoi4igqyhSo2PfYa7q779+C9esJ5XX8NMApEXcK4tNf19b0lTnMLu/AGo4gVFMoRcjBipJ6JvaIqcQCw4xawm8CIApwtxO7MhKf8pXGWd8ikKxIJhnZrEsm03rXA//7k1LPE19m7Wkn2gx/cXifwc+yNwORs4RIAzdMWfStxsalrejqqp3dMOSZR0jIkYPACPlOPI8jnNCS3/NQYff9L916T/ZzqVSqEjl2EJ1KxiH9Ue7dcMffSns3vdSZ3iGKRjREWTi2gYfu0TZQRomLkjgROFe1Cx1HNmuRTvO2R277ZnHf/f+gXEkpHVUAHDljIOZkzoxM5ZmP+NJI9FptBSLMjsd6m0iw1gWPgD0C+mNx8FsAsBrZo2IAZAAn6TTf29299VHf/2uEGTKJXxQRUck5M197ralI3eUC0JojvNwU8vQTdjQVkmlGJuNaZj33y6ib0y6m4AjELLX1IsqRE1YprUrdW/9t5yO/WTM+b85qBHlz/mV6540XRDCt11lR4P22quTgGhTo5sHiXY8J9rY5LRZOLKmaQwJHFlq0GnJ584pY5NKPt896b9n/ROXK+ifbH+h6n+3beI+nI9rCuknEMMBwbIyz1DBrSsPCs78NIiST6eNF9fMZhYhFBEYAIyJHscBI4KXtoIjIU6x1VCuJMRUHHnD7HvjApru/8uxtG37zSySTenzI7QGTyTikUmrrxl/cXth91wVuYMc6Uqw87SlGlESUFXFBfUQsJikysUw8JoEFUNExd4HPpiIiTQwvopXHihE94Lqn07zloZ9/qm/PfZea4ra/aRCrSL0mFQ3cYkBWBLZc/yNXKtcfdEhLYUJsRWjy+2j4vUk036uQBhQB8p6W9pctiuj5Q2JstRTWJICDc3Hy+F5LT3ynt/s3AqHMUQzZXZ3JMABsFvfNAbCLiPUhYmoVB5hG68zSiLoSgKzAinBp5zgn9CMAUBEcm3XWFe/xYvOvLJoe46GW7kjFEVxgIZYjCe16Nt227eEffqgsfjZGz4SQMx/tmJa+KKZe0muMYYKu5N2phRNxTdqj35vihrfs3vb8j3Z0vG5uXeuNddb4BXJerVpBFEAWVqAiAnNZIvap+5va7nlBb25tF6BWZR8UEBX9vY9cob3GuxFrbRKTFxJdJb44iCLxYJQpOeM1LHxp57KXZ3K5zEdDgbb9Y9npiI5oIQ9Hd2AehBOLs3C+3yum8JS4/O+K+fytWx/+4f9iWDUtpZDLHt41y2YtkFLbH8+uA+569qyzXv4yx83vVbrh2cqrr4OKlg32YO5t9Ph79BkYa91WHMwrky8yXEQEgIM4B5KCddaKdQbM0SdL+R4xZmATAHR0LNv/CS4bV3uy2f8B8D9zTr/kEvJmpJyuP5fILVI6pok9gCq1O0IBHyKadQy+7J2CQzDqtSs2qVirhkQ01fL/FafZi8PCtRzMtlcj7TLI4Lxo7M1TnZW9oqBqDFYUyDkivcn3vwKgfy1WTKKNc/hkAEcAbhmytz4vanmFjsQGUHs07QCtQViMyGUXNjY+h/oyf04DnNlv9suQY5VwBFyOWJix5MV/p1uW/cFRHQglRcI1/MMZgIWDONEJksK27fs233X24FtfsaccX++AwM9kFWDfOWXK895S17y20xnKA8w1zrkAAAEWThrB7jER9S8Dfeet2bfvTiuCL0yb0fXaRCLVb0oGNQ2nYDsMwIe4JuVxznc73rJl5xnb0x/YuzqTQSaZZORypmPexa+KzTjzew7K11a8YB2/9iyKYc+wDGja88DKzY/839oDifQ4SSEA0jHvBVNjdW1vARLiYKqHPhwqDmBADBwJ7L54NL4x37urFHc9927ceMeuMZ8NhPQOchlnf6QZuMFVNtk09cy5jR0LzxSKnQExp3G0Lqp1AkxxQNxwP+8AWOugpABxFtZaODGIRKIbmVWPMUVyxnclM0iRaP1G7cX2FQoD5Bd7/WkN0cd6S7uld+dOTGl4dNuGDfBxSB1PSgG32FGng6csOHd+hFtPiTfPpkJ+31yAW8uTm4fdPjo40RwhyffsfOqRn30NBxxmm2Yg4+ad8fLLhJueVRLfca3oJBLHFGVX6t6wZf3PbsIBWFaVjvvq+mlL/qE5dt8cgSoKqJo+nEDgMcsTFsUP7t1++tpi8fHVAB3tjr8cpowPtU555znx6FRfUKg2s1NhyJn4Xqc67ygUvtjVt/fu9NNQx5Cjx8lunDBEpKV1wayGhRf+EfGpM2GGHIEnTXAjsGI5bj3br4d2/fUFOx//3ZrRnXU6yJsjc1A37Ruzpvz5XNYz9okTtZ9lNIEgKtYMefX6c717/unTe3f/x1eXL/euv/tuQ0SNP5s56y8v9LxF3cY5VXMYFeAIgDjboqLqZr/04zdueeLKspKjS5aVb6cvvfJrkSmnv8m3/UY7T7MQpIrDLQGwsAKdEBR27h7Y+n/ndG97fAtEGOHDf4xBSCY/qnMd6wXZ7NH0pyCkUoyuLncsKp7ul1RKJXctpdxJOgO4JhlED35u6oxPvyYWfX/R940lpavq7IiYRu2pnxnzo1dt25warwgbEnI0OJmNE0IyrZDLmOlnvfrXqumUC6nUb4moSg6a0QgMKV9r9uyuez/81EO//NfxeXMklWLKZvkLnbP++Lpo3bP3upF8PFW3SIF3vBOxjV5EfX2o+PP379h8eaUBSQHqFsC+rKXl9A82tq47DUJ9IkpNcv1YAJ81IlI0imP6q0P97/vwru2f7UJKrULWpdNCmQzpWc96zV3cMO8s65eshqu+SWGADJywpUi9sn0b/rTlb9+5IJXqQja76mR2KJwMejr0YXIA0LFeypkAn6lrwUilKLlrKXV0LJMDzSVTSai3a9eDE266HNYCHR0jx5JdWv49A4wc45E4VgLShNR6AoBkNbXZI0AOa3FIqSDKRtQB7SMwSA/EaCACJIG6jls62x9+ruLmXhh4TlG16EEtZIe0Up8c2Jf6Unf3j9KAyhzFJZ3xpAG9Ipks3+z7IQmszeVcOGNy/HPyGiflvDGzlr3sQ17b6R8vupLxXPXEeyPzuw6GxHi6UZe6N9y29f7/vqTsZzLcKaxBUq9Eznyos/Pj7401fci3RSPCuloI8PDcKzGcGNegIvy7kr/pZVufOEeQ7lmNDDLDUT9JnUHOXN/UdsOH2lo+EjPGFElpLbaKjiMgJGBh+AQ0ipjHtdbpvd0rf9W7d20KUFmkANxiW+ectaRh2vPucJHWenKDzBJIr4w1zggkAiGBgTLai+jS3ns/s+2Bn75/+fLrvXXrbgwTboWEHCekAZ0B7Pvapr3t7+savqhN0RiiCZpLJASfyDUT+I/W33zJ9i2nCzBQ0Z182iseclJxckbrpFIKuZyZc+qLzlWN8z9WEmeVg6oV1ssIct44UY50nfaHtj/Rs+sP1yGd5mx21fAackXP5Lq2qSuuidR9iF3BODhVS/PJkYBhYZ2SeoI8bm3hZ/nCSwjoXoXMmPXSDHJ2TTKpb+zd+9HbSvYr9Yq1tmJdDTFE5TjIXiy+U4p5S9F/asAWdwhASwEBshbJC3T35r89VOzZ8CZ2vnKI2MrIaeypKL8GApPR1pRMpGnJ+6YtuuiKdetu9EP9k5CQ44eySJk8PxK5qhk+DCbmbBYKHJoVjPMV40mnvwSgv6wIGxomIUedk9E4YXR1ufppC6egYUHWeY1gY0mJGpU3ZywCgSURKCXs7/PzvZtWDe7cuGuCngnSMrMRrW+Mx78zkyEDIPacotozjAQnGloV7SDH1A8KA//8je4dD92OpM5ODNOTFbmclXSa37Jl07tvNXikUTOLuKobD+T0RZrg4S+O+HM9PZflBgYeXj3aSSyXM8lkWu945LZbir2PfU1rra3AuLEK/eNqzGBnlFHKRVsWfr1t+umn4JZbbODAFxISciyTAhQhIy9rbDxnEevz89Y50EQFbIHAkZMYWG3w4X+72HMzMCKQFhJytDnZOhRKJtMMImmf9vyvoG76TDGDjkETtM1GL706IoCUYQVV6NmU3vvobX/BeD2TVIoIGfevDXN+cHZEzR7yrfMcc0lVV1sM9kGwBNvAWv80P/Dz/9y167NrksGyUNXPA7IqkyEC/Bv7+q/5m7NSzyIWJI54TMYcC6DOst2pNf9ksOf62wd77itP545pXHK5jEWqS+144JZ3moHtd1A0piHOWtCYpICVzLiBgwwRmaIg3tYSn/qsmyCikFo2iUkTEhJyLPD2ZJIAyAtjibfPZu0VJfCdHw+LgAQuoiL0kHO339HT86QgHYbmhjxtnFzGSSVK5ZSXfkKaZ1xh/UGjocuqZmMjB0cn9BMhI17MK/U++ZOd63/xibID7Fg9k2zWfrJzzj+91ItdOOA74xQpIQeeJKGfE3GNmtT/5f2n3rlj6+tFhNbmJh+ZZAH7UST1//buvuc7ff0f6VWeisO3EMCWJ2cFgIIz2lP6VwN9X/jCnj1fW5NM6hpObIJsFgCVevb87Q2S7+2FioLEVtWLpvJ5ImLl/ILRjbOfNeXMa7+A7CqLMEFgSMixDK3I5WwTmprP0pGXOBQhNfKGOTCIgX3O4jFX/E8AkkUmHHyEPG2cPMbJcN6cF17mtS34J2NgGKInWzx1BDhxTmlPuYHtm7Y99oe31cqb8/qW9ksuiXqfEFe0Fkrp6qstw1hA6ojkYcP2q/3d1xLQvYpo3MgkzYEuw1gyyBlBSn29Z8+//XigmFVeQmtxRpXHQCJi63VU/0+xcMf7du34QDnqZxIv/sD/ZGDzuodN3yNvIjgFIlurJWIJCoG0b41NNM5564ylL0shlzFIJkNhv5CQY5A1ZUXYD7ZHr1qsdceQEwuqLudEIq4eSj3u8NC/7tqWE4BWHUVF2JCQ8ZwsxgljaZfEWubPjnUs/pboBqdtgUmq+3YFHq4MwAg4Is7vJ9f98GswuGnneD+Tawl2diLReW284aY5sG4QTAwhW0vMsVziYu2Q9lR2sOef/2dg4I+3Jyf4mRCQcQj0BCY0IISsk3Sa37/ryevW5P2H6xVrR86KkGtSoHUlf9snuodWKVCpPBszuRNbxf9k/W23FHof/rpSddoKTBBlNG735S0RAZ61DNGOmmZ9u23xeacG4ZKh/0lIyLHGisARVp2q+R31AoEocPV8eiCCs6xxb8n8HIC/NsxVE/I0c1J0IslkmpEh1z7reV/TdR3tYooCVkzjlnIqfiaBf4WBRcQqFlXat+n92zeu/WM1PxMr0Jmmth+eF/Wa+yyJgrCQq5kskOFAIlZFo/p/Bvt/9um9uz81YWYjiH6R6UvOf9HURee9BIAgPaHDr/if5L+2b89r7xUaiiqSODm3SSL89aH+19+f797yYcgEP5Na5HIZi7Twzvt+/L7SwMaHVCShrcCNF2Yb7YtCIHLOFxVpTsSblt0MtDaG/ichIccWZUdYd139lHNP1YmzhpwRkFPVmikHIAKojWLyvyx0fwcIHWFDnn5OfOMkmda5XMbMOiv1Hm5ZcKHxfcMUpJCondAPsBDj6Yg2vU/csuPhn3+mlp/JR6ZO/+TLY9EL+mzRUBWv9/H4YNeklPpjwX/0zTu3vVqQ5hVj5cUZXV2udebMGV7jaT+MNJ3947a2U6Zj9eqKMv0wFf+T2/J9f/lJ38AHrPW000rfPNjz0e937/7NmsABdr9iSQJQCgimkTKrAdBAfu/DV1J+Vx+pKBxczVkXR4CCKOdbo+pmn9F51iX/L/Q/CQk5tuhKBZJ3yUT8TXOIYQE37OQ+DhLYBDM9XPL/+NuBgYcEKRU6woY83ZzYxknZz2TqkhV/p+JzP+WsbzjIm1P144GYmYOIdfDqtR3Ytmnwyf95U9nPZNiASAN6JXLmbVNnrLwmHnufWGsMPEX7WZK1gDQw5GEg/8P+fdcSMLAKGaIRw4QQRBNRvG3FDyXW0cZ1rZHE3PNvBJFUywicQc6sSSb1p/ft+MrN1r/5h0X723/bs+tjkkqplQe4RkyAZAGbBhjIuED/5K6HTN+W61gMO/Ys4AKl2PGrQ6JAAjBEW3/IeE0zX9dx6hXXh/4nISHHDIRs1s2vq+tY4PErjPiwIFUt47oA0CTYTYx1vr0RAK1GNpwFDXnaOZFvOoaIzF/Q2minXPNXibbPhyk4IubamUAIAl8cJxzsPlfasf78nZtu/3PglDo2b855jdTyqab595yueGa/MxL4tlfHEUBw0ES+wPP+o2/vhz7b3f1vFTXZyueS5Vmeacuu+vdE++J/LPnWAELaiyp/38P/vPW+7L/XyAhMBIgEWaaFACsHllaVBMA59fVtcyLx5I+7d/+okhCsUpepp1317Xjb0utsyTdMZfnYGpt1gBitnFccgN999znbHvvTPaPPXciklJ/F9CTPZKbyywEmjwt5hjmQ9vWoX8dKO/OJqTPf8YZY7AsolYxlmjBwCHJAQ5qh6I9Otly8XS0UPFaikXDGZxIa+2ysJ6SAIG3D0lF1yxzJ1AYnIuUl93SNt494eohD5kQd2VIymeYckS2c8aqfRGLT5jt/0Cqwmvx0WxiOmCgZr3/PYx/Zven2P4/Pm7MimWTKkftBw/QfPkvTrG5rLNcIx6vAAihxJubVed8qDP3ss93d/1bJmzP8oVRK5bIZ03nqK16sWuf9ozHOUHn5yVhjdP38T0ybf/F9O3KZWyvS+6N2IWXvGQMM31H7vbG+uny5pnXr/O82Tfnkskjk9aY49IIbBgfXpACVLeuf7MyueuusZ73hTG6YcZa1g07bGAdOshM3zyBiWwRiTcprPvPbaHpwBd67tA+ZI5V//oSCkEpxctdSWrFitctkuJzlN3MA54mAtOPU+ixV8tLkRvLrVAyXI3W+DylvDlA7d85wPqAKYzqYzOR1T6cZ65cdtUFVCkF9cwCQWy+Hkq+IEExJy36+RwA+XB4MHGJ1D6g6K7DWAhRbTOpdcTHo5eqJvgQELc4apfWDpVIXsKG4Fis0IBap7P6XaZc+KMhkjtCxpBnJtZzECuRWwAXbHfdsTHYzilBqVZaDa7kWyHUc0rWsQmAkVerWseyAt5ca9fuBPxP7eR4OoK7JJLijY5lku1KVJJ0yaqAzybcJuOpmNfJMrA3yXWUPu14HWvkTkLJBMX3Jyz+sOs78GEzJZ7EegSZN6OcAQ5GEtvvW37Ll3q5UZfag8onKCOQjHe1feE996zuKxjeoYeARAEuAEsAKXKNW/L++feqqLZvOEpF9FITwlR/kNINucJG2Mxd1zDt3nYq11TtXAiNIjizinHgxoLBv657Hfn9efu8920Cry9E8E3YbHMx+qOTqeVd7x/vf11j36RmOzc+Lpi+1ffMyQXpXkNcnDeAG1zrnOUsaOs++0+mpdeQGOahXtZPoAChYGMuRemX2PvqLrfff9LLx5/HkJs2p1DLKZleNn03ihobpLdy6qKG5uRmx2DQAQAFAodAD9PSgp2cHuPcpP4/u7dhfh5ZOMzKH0YCkUgpLuwSZKkmhTjKC+xeuyvNWi0q27gNxDD+q57csvGhe2dx8ebqx9adtxtgCB0s647FgJOBkE1Nx9b7+s385sPfh9NE3nsaSSiksXVrNyKlvmvp37bG5cxG3OjrQvXUhAHgq2tfYOvepQqGAnp4dAO7s6d3c24eadSakUjer7K4vEsb6+u2PIAt39hZ7HIyzGMk0I3eDGV/X5YD34LSzpzdNnU2x2DTEYjGgUEBPoQAUetDT8wTqzZa9e/fuHcT+rrsI1eiHjggnnnGSSilks3bqggtWJqY86/98L2qVharRmwIASAQ+O0c6QdS/Y8OTm7LPxrvf3T+6ce8C1CrAvnla+yXvi7XdOsWVbBHEDFA1mTWCgyMNiJU4k3tKVDHdvfPFP+/v/9NVgBoVNkxIdTGyq7yZZ7zq96pl/jkjGYIrK0UMn0rWU03K9j5861P33vSScod/MA/XyCmqZDluajrrn5o67lgG5/XAdy065n2nWMi+c+uTq4ZndsqzNFMWXPjOxPSzP++EfXbOI0yeudky+R4pr7Tv/ndveeAXn6+xHHUyUbnOFgBaW9GoZl5+XowansfkPQcqOp+J2xxRI6moAIpAAhFAxEFgAVsCi18iRLcp5iecXxwgZTcYm9+pVf1D+e6tfZLf9uSOHX/bDqB0iPVkpNOodA6d85fPRvOpy2Mu9iyBO82LNsCoiYNoAQBrAOdgRQBjQLYE50wp0dD0oLNDYkxRSn6RNEV3ROOt24rFIRSH9sBDYXcdt+za0bOJendu3gXsHMTYZUkCIIsXX9buGqZ828ZafciRbQ8FAFkDKQ6ASa8v+kNP5s3ee7sfvu1ulGckU6mUymZrj74FaSZk3KenzfjGuZrO7XHCEOgxYYBA5cGxdczqkZL9r7fs3vblcrbwI778KamUomzWfnXqrJ9cE1OXD5VgrRJdzTgRiG3iiPqVzf/m6m1bL7p7+XLvnHXr/MVnXvkOVz//EuNMkQA1Roo6+CKJYkeFvqb+XX/94J4n1/01kBM4mE4rGKChHNo8dc5Fc3XD1PO1pvPZSywC3KmO9BRRMTBIE5UHbhBAxIgYOOfAUPtI/F5ypV2CoZ1E9KBfKjxh/b5HbWHro7s2PbDz4M/imGPhjsXnnxZJtD2HXevZ8BLTVTRS85vWDy6pckWINbDWBznxE3XND5TEF+cPwpgCRGxfoq55Q7HYj6GhQcAfGqiLyuah7t2F3bvX7zjgqpb7v0pdZ5960Vku2vxCVvVnM+lFpGNtVvwZRIqZogAxBBbOWYBExFrShN3izKA4GWJSG/1Cn2HFDyiOPFjIb+/XdmhDz4a7e/rRv/fgz+WBc6IZJ4x0GvO/+90Gab/wXhvrmC12ULSL8Phw2OEviIOFFqe1E79HFXb/afmex9f9dbyfycdBbmG8dfqX25ofPEdLU48zouCVw4YnbpdgIBIFszUg1t/I51//4Z3bvl2ZsRj+4PLrPay70e88I/WxWMuSD/u+MQpOszhIRR9JGI59WLCJqKgu7b73Y1sf+vlHqyzvHAgkqRRTNhv7yczZf71QeYv3inPCzHFLxvecvrE7/65Mz/YvVOpamfmYfsbVN0ZalrzZ+HmjCLq27w4gwuJrsZ4tuNL2v75o+6bf/X7cg3MSMdK4LViycpmNzXsHRbzLxGueRSoShEsJQ5yDoGyIQEbC0SlIocDCIBCECUxU7iN0sKjnSnCuBGcLJRJsgctvLPU99MFtj/3p3mALBzL6Haln5+KXXx5rnHYdtH6xeE31TFxeKyJUzWQpUq6nlK2KyqSBC7LKSWUywUGkIhZoAbEgZwDnCoDofPeDmR2P/e/Hk8mkzg3f20G95i65Yo5qXvCEePUg56qkqzsMBBAKMm8rEJw4ODMET4bWm6K9tX/vvT/c8+Rd68qfrhzMGCozq5+fMvsf35qI/Hve+iBw1UbWAmhkxm9898hF2zctE6SFjvwIlATA2fX17V9u7nj0FPKbBx2LqtLuCwAPzuR1TH+6v+9Nn+ve+c3r5iSj39mcK8w75/obvYb5b7b+EGq71hHIFbFv++9fuHfj728/KF+zUe3CzFMvfkWkYe51VsVexF6iLgiAJFgnIHEIjNLAFB7ecWUURwSgPKYjDs69BN9zrgiy+V7xi1vElf5SMt2/t0NP/HLnxvt2jzoF1SpXOY7ojKXXvFbFmt+pvPgZ7MUhrAEhsGCkrR6uVGXIGvzvKs9reUQXfNohcI3k8jNfeR4cICVYga+MLZiBR1c++fBv1u3H4KPyxtHUNGdu47znXUte3WuUTiyB1xrYxWIB8UGuEoLhRg6aKptAUCdigKh8coMVB4iFuBKcKRlxpX0atMkf2vONJ9ff/DUgxUfat/CE8jlJJtOcy2SMf/ZrfsCJqXOklLdKIiq4j6s3ZJYAS2Q9Kup89+Pv3/P4ur8GDWN2jJ9JJpfj1S11PzhPc/MOMTYqnjLKQbvqd7UgAke+rdMR/e3B4s8+vHPbt6v5mSB7oz914WUvjTbM+ZBvS0bBaoDG3OxCFuw8gJzynTO6ZcFH2ue84I49udv/52A7/K8uX64pm/W/MW3mZ14YiS3utgUD9nTEWRRYVJ3T9pLG6Gf+7Nru/Fhf7u6K/0k6LZzJ0Dtnn/P601TdzPOcX7RE1aeHAYDIkbaOoZu1nnLq9xr9jWf3LV3agxoN+wlLKqWQzdjW1kUzGuecl3Gx1tew1xQRawHrrBgTdIvlf0AlFxNBhkfcADsHIQuBgAzEgcpjzGLZ95kIpJm8xogwz9eqdb5nh6YDf7onmI7en7dI0PA1NS2e1zz3OZ9T9dMvg4pDjAF8Zx0ZGVEAGj2hUUHGz6LJsJ1SOYjy58vGCxEIjgGwZiLylJdQiCQSwedXoLwSP0wdWzfkSnlr8hESN7LBYca7NlVb5axl0AgIBAjBACJEAEWUrxNLOcpL6yOR90UTM7+99eEffQBAL6rcxxUtkBt7tt96ju5cvVCxNySuancuAIrW2RmaF12aaLiYhjK/So2dUT1s1iCpCDnzmXj8dYsZzUXDhlg0OZow4ykCiZHW9/uFrZ/r3tklAM5pP8Vicw6O7JAxQ9bYoiHIqD5j1PkmdnA+W7d/6YIxJJMa2axp61x+asPUM77MiSkrRMdBtgjxxQp8ATkiEAc9ZNChY9jPTxBMXnNgH5MPMYGdGRjTIiCGECnohiaONDUReFmC576uAL4ZuO+aVKpLVVlmHTaapiw477mJltO+rOJTz3DEgCnCWmvE+gBANlB8olH1CfY8avTGTpXr4ipvDn9l5FNEQgwSBYYmKOWJLnhxie9vFrR8IUTPPP3y93O888NedGqDE8A5H1QaMsMjIHCwcxr1NRCCB7H8dIgFwYiQg4DEAkLBeSeBIvHqNFFsCkcaphDJ/QBuTCaXUi5XvXKHyokTSlwe3c9edsU/6Pq5l1g/bxSgqjSawzMdjgALMp6O6ELP5lt2PHrrZ5DqUrlRBsSaJNTKXM58fOr0T14Yi17Q7Uom4kg5cuBJulgD5xqVUrmh4lPv3fHkGwVpHps3J83o6nLTpy+bFWmb+U3LCShnmBD8G1PfYLwcOJy6PItqlPrOU78058wzm5HtqiLhWp10Mqnfsm6d/6GpM1//okT8zUVTMuy01tbBAdDCNOgESxXrdza1fNUB9RV9hEygf1Iq7t74Sin09kN55GCdQ9DQTQxJFBCYnRkyHJ8+u7F95beQybjly68/ifRPgsatefp5lzXNveBe1TD/jZbrI9bPG3FFAfkKbDXYKSFhAhGBScAkQcs1XIS43JoxgRSDWBGxIiJNBA0SRQIi54Ss8V2pZB2Uf4AVZeAG1zz37DltC15wu25ecJl1yjg/bwUlARsFggaRAkERUblgVCGlQEoJBwWky6/roLCu/I6gzgokigWKBRRMGflCVtfsnAuIwZFSTDy8z7Fl/GuY5LXxJTg2sCiwaJDVIENiC86Whgx0I8emnPXGuWe/5vdNHYvmI/AKH9N+ZgAnSPP9vn//447+EifFSkQUiIOC4aIBtiI0g5kvaWhbSRhOynekoMARFolFOvGmqBMYArOMM0wkyMnFYCuK8GCp+HMA/WsBVV/fKQDAwkzEiiC1zzfK5xDqwI+hPPM7c/ELL26ade4dunHOCguyzh+y5BDcd2w1CCpoFJkAPdKrB4cZ/EeOiIQERMHhQAWFNEg0CRE5K84WnTWFgnNkIIl47coFz+60xS++pK7jnN/qeOcZ1pYM/LyTwEYv39PDz+Co81F5HirPApfvK+jgViAd/B4UGi6iCFYRGSXkGGKFrEiEOicxTtIMkMTjp0yfffqr/xRtOe0/ONLWYE3RwA45ggFYyvsjLpdRbUv5dxICCTmyJOxIWBikuHJ8IK1BpIgMs5SErPjiF6wjO3jA1/sgOTGMk0renHnnXYamef9RJN9oBzU80zWu7xYqF3GOvbguDGx7rHDfbwI9k+yqYQOiC1ArczBvb5926ZXxuvc5WzIOSoFGJq2rTRw4QBqI5CEnNruv/xoC9q5ChkY5llEqtYxAJGra2TdzbGq72LxjKK5lZ1SmnB0xQI5ccSgG9Bz4KQLUDbmcubRpylkviUW/0uSKtiCsyoNFoLxIoCCqz4g936Nnfbpj5rcom7VrkklV0T/ZuTn3RGnf5ncELYV2VGO5rGJgEZE2dtDopnkvm73s2g+uW3ejj2T6hJqxq06agaydtWDlspaZz7qZ6ma0Gb/kK1eU4GFnKo8AUTE/A8pTv+OsPRq1UDISjDNqzAUEA8hg9oWJSCmp7hE0DkI6DUDiTU1Lf0b10+eWzFCJQYExgko9949g5D6VkVodIG7E+Nr/Xg5iu4dG4DzPIDAzsSZnqOj6fNWw6PSG6c/736amxubgvI09yNXIMADcZwa+PwAhD06kRkthiVhbi0XElwlQEWM8IqTLTkvp5pnnLFPe4n6Y0U5sY45UOwG0UZus+L+y/hcBYO2oWSF3NLqJVEohlzPTllxySaRl+c9ctLm5ZPpNYOSwCu5jxsgzAuz/2ssEd5hhKnLWIA7ubaul5ixVmoFbbPuMv1sUbTolS6o1bv0hQ2AdfP3A7r/geahW45EneeI7o55yCqZXRKomjg4+ngaWLxev45QVv/BaFz7bGOPD+gISLYFLJMaWarOew7UdtX/C2PNd+ckYMWhIBes/R4cTwDgJZiBiLctmxdpO/xZ03ClTXpyvgVB55Zs94UJ3vrBv45X7sK8XmfXDVy8NcArinh9tmpeK1980HcblRTFDqOYDUMYTsUPsqZsHhv75e4V9f7odY/PmJJNplc2usjNPv/bfuGHhec4vGQ0oqWWYoJyEECJMMeFCt+nf8VBq872be4BVVZTRJsBd6bQI0Pr6xrqu0xQi/ZZJlFBVXxyCKpiSWVUXu+pdbVPesTKXM2lAD+ffefRn33W9G77m6ah2EFOzPUDQJiiB8p011DTzE50LX/Bi5DKmLNF/okIAUF+/uF03LfoVYlMTxhQtw3hukvvy0DmMDjuZVshk3PTTXv423TT/TN8M+EooIjTZ7PwxH61wRKk8f1qs55tBP9o0d37L3Jd8GpmMS6VS42dPLAG4eW/+Zw851x0lrWzg1jxhuwRwXpybp7HgNc3Tnk+AlJWaD5vVqZQAwNKoevcUtjIhB8VwJQgOYltchB627s5f79v3oKTTnDmqS69pRvYWO3X+eafFGhb9FF4k4kzRMSJP96Cl+rOYWkaAqGj7gs9xor1OTN6APX3M3fepFCOTcXvsqz+vmjufZUoFnwCvVjLH443j3TihZBIMImqddcb3VN3Mdpi8KNAEVwiSSiPDILEQkCUSZfY98a59G397f6BmOjZvDoHkHW0t//1sjaYeEYkIsSOBq2lEECDW1nkR/ZP8wM8+s3dnkDcHY/Pm5HIZM3XxC69WTbP+2RljFEw1H7WRuoMCxy6IVWRUae/m9+7bftcfgg5+//4ma5JJpkzG/ce0qd+8WEcX9fnOMClWruLfMH5/QBFK1TtxV9fV/2eyre3UjwEmDXCurH+y5b6b31kceOp+8uq0g7Nu4iz38LZYmNiVWHSUdeup32uffWonurrciZogMJlMKyDjmuae+V5V1znHmQE/MAUxwaFQSAJnUSEATuBg4chAYETEYlQZ9XfwvoMRISPCVgKHlKBAHIl1B5C5gJBbbdHZmYjEO99pBU6JqMCtoPb9KFCVMaqU/7nDLQQOfj+sHoDKTsSCwIsCdv9FbOCJ7KoaECMokEShRDxbMobrpr1uytKLz89ms3acoS0OKbUZQzs2l8zvlWJiIVst1xYBMI5dpxJ9TlSuOVJLO2mAKZt1L4w2zZ+j+GWDgXdS1Y6fHcBE2MuMv1r/WwCwOrP2aD6XlEqtJ0B0tGnZ13WkLWJt3ipEePL71QFCEDgnIkYERlC5hlQuKD8nsBAyQRSPGCfOOIEVgRU4J0Fe9Rr7STOyq2z77AvP0omOi8UMOTDpWrZaJQUAOyrXT0SCm+nwnwlHTsg6RIoTd1z2h2mf8+JLvPjUt5iSbxjiTX7qHSBOym2JqRSMaWdQbl/EQJwZ9Tkr4oICsQJxEOdYamSOPAIc351DMq1yuYzpPP3KD0abF19gzYAh0mpkemo8BMDAijbKi2rTu/E7Wx79xTeSyfSYqJdK3pxPTp3xnxfG1fn9xhktpCw5sNQe+pIYF/diak1x6Il37dj6hlF+JuULmGZku1zz3CVzYs1LvgT2nJIiY1g3pNZ1FvgEQ169Lu3b/O1tj//yi8uXX+8diCNsF1JqZS5n3t7c+uFr4y2XF2zJB2H4Yas1W6PIUo8QzmIVe0us/kcOSKwOprGB7IMCUGlg+0PXSXHPIFQCjkQmG2wxmMUvORWf0hFve04WRCp1YiYIpFwuY5tmz26JxJte7yyEhPTw8s24S0xOw7Evlq0FR4kiMcWRmFY6qpWOKR5VlI4p9mKKvYhmL6J1JKY9HdWejiqtY4p1VEFHFVTUg0qwcGw/z3eKAZLZraefxV7dPLElEmIGTX5bkRhHIjZY3VcE1gxVLlwuatRPtZ+/WTOII1CaRdn9NLCT4RBEzzGYNJEXVfstOq5IxxjkEYQtUL2xpfK2hRiCIkg1cSLW/vfVPluWe6e7ioUf7BEWTYZqTcxbBivrsIwTKwXQR2JpZwWSDEAub2y97lRPPLHO1mq1SgypI6cetMXdn9y97UcEIIMjt7w0nmDWOGs7F13+Nq++/e98mzdEWglZ1O6OBAJnQQTmBLOX0OzFNKuoIqUVKS4XpVhrpbSnlPY067jmSFxzJKG1jiqlY4o4weX2r+q0cTIZVKKuqeVirRtE3H50foQgwrBkrVXGgXXwPLCaeI9Xez6qPSvsMRQzlGKmCIsrTLh4qbKkW0PrjNdB1ws5N8YBdzzKEchpK6wJXlSxF9fsxbXSMT22jYkqpWPB615cay+uta7TWseV1gmldUIpFVfM0QipOhb2DuN5nZzjd+0/iIIwc069+Fw0zruh5JzRImp/QmsQWES1Nv1bH956381vRVo4lxlpjdPlvDnXd3S+/GWJxAecKRlDWvN+BnQWkDrlySbfL35rwF5JQPcqZMbomQTiWyT1za+9RRLtrSgWLBOp/ZmeTmB1JKJN35MPbn3gB+8oe5fvd1icBvgaZO0LYw3nvaqp+SNN1rf7CDoiUtMoqUDC8MjyXnH20qi39ONTp99Imcyrg4ijIG9Oby73t/qmlrdG2uq/WyJtlFhdq4EhARSRsn7eqMZ5z5u6bNUns9lV71++/Hpv3bobD9Rx89gnmVTI5Uxdw7Ofh+iU6c6WLCadqjcCilBESCHfu8e50l8tBh621n8yHu/cZAGAWCCOFLFYm48X891LlYqQ9iLiW3+GsTJVa09YxYl0jExxaL5SFGXTM6mzWsXDXqjtAtEJIb9gQRNlzcciDjrO7HxIaUiYaDeY85jcut4vArKeb6OeLweu6TB+G8EslDAxWb9nL5XozxCi4cCmKjsljoiToZnE3jzlNddbOMAaqT017kAE7awR9ppePHPmuTO2ZLNbMer4y0s78uW+Pb+8LFG/7/lKtfZBqufZI+EBgZulcMrVra0voO7u31Q0lQ7xNNCKwLhoXOjZ15Fj+Ayu1sgIAE+cJfb0er/0EwB9t4+PKDyyUC632gKfbdb1U/4RogVUqulnN1JLZUnXK/h74Ar77idn/+yXBrZHY3jQOq9oxCMKlE+hmElFY2KKAy22ZBdEIwnnm8FFUPFGZq+BCLNAuoW0ahR2ifF766govqrEc4J7oFZ6xACGhSMtStUrzwzCmAGftd4OckLucMb+AoGG4iFAFcc7xFI2u8pOnX9Gh0TqL7bWgckqV3NQLvCVOM1RheK+EgrmbnG4x9i+Hma9Scfa9kIcgVgsil6+f9tpTB4rroPWEUR0BEPF/iUIrD0oz4NfzM+hSKJObN+uwzjISTlejRNGV5drWbCgCU1zbwLXR9j1OZLIxKEpAAGXneudgOOQwr5C/857rgOogMwqhfKQPw3wxwBzdnPznKsT8W9MF+O6JaI8+JjsBnUEREXsELP+6dDgO3/Su+OvVfLmqGx2lZl+xtWf0U1zzzH+kFEMLU6V6za+0gwEoaNOPI9oqKdfdtx7JUBD2eyDB+JnQquRRgaZuje2tPx4mVKRHmNcROiA3LkcGEoMHClV8p29NhF/1Y5pU368Mpf7cRrQmdyw/sn3pp/RkPRalrzJurzVEFXNXbhiMCpAG+f70ZZ57+ucd/G6detu/P4h6rUckySxAjnk4EUbz4eKidgBGXGOH4tAhFSEvNJgr1/c8kH/8T/8ZPvA9j1HoBoKgZUYnNP9zLBRrLWpnCmh1idAcLCAaPZYBp66p1Qc+JQb2rrO27d150UL2wf35fPUEo8f1hTvfVt26ke2bCkBwKEpCjPgyJGnlN/f85dt99906YF+c+aiF8xAw6xLhZv/k6ONjUE0VQ0DRRQcilZ5zQnXOPdFwJ3fQTKtRokMikNKEbKD693QmvMjjVeS8R1oopGqRCAObloU/GIv+vKbgd9MQZLGh1EfKIEjLMx7OjpfcJri2QVLVtXIli4ANIEfF9hf583XAeBLudxRdKxIKoDM9LkXXuQlWmYY5wdOplWbsmCVTUhbzUa5gcdvHujd+Lndj//+DhyGEbwUiPTNPHMKWpfM1IWhEgBkRwVBZJemBACTF+8IpHsmM04EjlTQ4A1t+P5Q754f+r27Hlre1LtldlPTEfDZCWR1blxXWe8qa5wE0gBWReY8h3RDo5OSZRIF4nFnhsqrXsp5Ttj0P36j3/fof2174u5H9rPjrgOoHCNoZxxwqM/r5ByPxkklb46pX/66b1Bs6jzrD1qmiKoYJtVmTRw5CCJWka9N31Nv7Nuy7s/jNEIqeibevzQ0/PdzyGvtMUUbIcM1HVUJKHuy2LiO6ZsG+37zsV07vlJRZRz+YDlvTtuyK14aaZzzXmtKZjgfzySzhgKBo6hjKeih7gffs3vb3Y8EHfn+b4Q1yaSiXMZ8debMz1zmxacN+EWjiXQ1NdtqEBwcGFoEBQK3O9hXR5q/ck9D4YGP9Q88moZwJpexSKXUtuzN75y1/Lrncf3cJcYvumCdaux+hq+JKLA12mnPxdrnf66tePrde3O/e+TgFSWPTXIr4JADxNFzSWw5AqWGZz6xkBlygzvvu2bH5v+7DSAgnebk2pHpp9FdVLLGPiujvUDJJIuyxPaBj7y9mCMJ7ozq4y4BBM5TMTL5p36/+W/fugTA8KzMjes2H/Cu9sPhzaAJgRGIFxKxh1SXWgqo9fubhchebbc8dvtWAF9r6Uw+1DTrtF/Da4zBWUw0UGjYgY1YQ8XqlgP4ThJjr9Wq8tVY7/uf3RY1V7QTqISJ59cF7vWKDDBde5cB+PsVyB3yTNRqpCSDLJ6r4m9sJZI++FKzcxW4hCK+3y/+7ba+HXeXFW6P2pJOKvUOyWZz8Fo7LiOuE+sGoKVaFyQg0RByltmowR0bPrdjw4/fE7wXyM8P53qpyooxz0qQEyoLdHW59UQlbLl3K7bcu3XMDisbD9I1aOfMdK75RJS/JGSVViq/d+M3tz/4gzdWXr9td82vHBGSu5ZSDoAXbVyo2IMzRREaG0QkCPwJHbHTzGx6Ntyw+cGuYF1+kjZmeB/j/q7RxhzV9vr4M07KfiYdS172b6puzpXWLxom1rVmboGgozVg42nWfvfD39i2/qffSSbTOpcd6eS/CuiVuZz/71Omfv5FkcgFfX7BMLGerHUgAUTENasI/6rknnrfzh3XCtK8Ojs6p0makb0hCEurn/59wxHHpqRoeCKyxrbJwidlopp0ac+Gz+3esOZby5cv99blcvttwNMIpmb/qW3aW1/iRd+ct3njSOlDce4QAIoc9ThFp2uZ8qb65p/+ob//vNWp1EAmmy0ngaKi2fPoFVGv/i+INMedsaKHNbgmbpGgCLboXHxqa6LjrK692+4/N5VaVspmD29p4FhCR+sCzaVahq2I1Tqq/MHtP96x+f9uW5pKR9ZnMz4yGZer4bxzEGPp0bGX+0UpnnxmJZhiduR87Q889Z8ABhcufFd0w4ZW/8ASFR4UR2h7IsiusstSXVhfTWBrIrTw4ndFNtz2+T/E6pu/Ep961vstCoZqt5EkEGjSi4ERo7RCtpwZnPbtu+OqWMOjM7U6peiso3Ee0WX5Lipa505Ratab6ptfTAM9P0uXc+IczBGnASZk3RVNTfNPZfviggUcka61uKAh0k+MTSKfBCCrkRkeCR8FKJtdZTs7OxNONb7QiJBySlUPyyU4GKtVXJX6HvvRjg0/fk8yuUbncl8SIGurCqaNIVf9WQnszGAaM5WicgK7qsdLgJl8ICdCrNkV+od6d/3pQ0ilFDa2MNbdeEgpRfZD1e0J8WxHlSZzbDsTtDtGmBPs8jt3bH6w69NIdSlks0AmY2u1MRUOoK05qDbmUDi+HGLLeiYz5rxgZaxl4T8ZZ42C01VkIcoENoKDc0ondKl/44at9//oA4HQWmaMn8lbAP8d7S3XvKKh8a0l44wD10zoJxRM9jkhiSsl94vgB717ryn7mYzRMymHpUUi05bcpGOtDWSKUjFMJgqXjfxmIVbrhC71PnHnlgd/+p5UqkutW7fugPxMbkDOXDql6azL6+s+W+ecLYJrKiMJKPAvn8RyEWF4JNxtnXlpPLHkQ1M6v0DZrF2DEf2T7ZvveHhg1yMf8aSkhNnWfLDLSTG1sLJmwHDTgjNmn7HqE9nsKrt8+fXHn7E8FirnpEn4pjS/rFFZ9RkLHCEEvi38DhBav+twI1XGMMo43j/GH2qZ/BOBJI9xg64wUNgJgMqGSaXOR7I8U8iG2z7vA2keKm7/gvV7isRK1XaQBYkIwLEOAAqZ1RM+txZJRYDd6PwunwlK4CpRgxUYwaxikeHalcjyePwqYPzY/8BYjRQBkPO9+vfN0SpaEmdrNfAWkKhidZ9v+z411P+/gSPskVOnnUgQci3RM58dUXWd5PKOa+YfEAF77Ird/bJ343sAoVxurTtC8ugCwAUz5pPN1O4nHFcgxExOStuHdm/ejWzWYt2NBsDT9kyYkj97UvMJ5IgBawYfAtCHpSk5ghLzR/15PZ6ME0ZXl6ubOr/DmzL/+6TjIFfgiq/hxM61EuNI4nRMUNwzkN/1+BUA9QbRJsGJTQP8MSJzXnNsTqqu7fPTjXN5clw9IwbKWxSQY3js2wJ56rahgXf9rH/fnxxSaryeCbKr7Iwzrv6vaP2Mc6xfMgoji/sTlGsR9N0O4qwXJQzt3NO3df2rIULZUXWeBFqdSpEA9W+Ittx8puhonzhiqi5sFcyKiIuzdiK1fTZHpjNEO1Oyr66vf/X1bR0vX4mc6QJURf9kz8bffrbUu/1rWittwGZ0nrOx2wssfQ3SYoqGG+e9Z9rSi1OBQFvyeDdQAIBFJLrfJ1cE1s8HuSNrTlEfPSpTtaVCz6Ly7V67swCIRLnmps7tOEFmt6rggBtc75N/3kzibyJSIylSJkIQgXWlWQASqKL2+CXkRAD8T2Hox08ZwCOlgtxDIx8b9SWGAy3xYucBiJedWg9mspMYWdsItJ4S0dfAOThwTV8TBbFMEWxw/g/7+/v33o6kxlG8rsnk0uBYEnUXIBKFCLla0SUicEppKuV7/rhly51bU6ns07/ke0D6hQC5YaW4px1i5dfW3Aqk5wGCpxo2AKDU+uxxFRl5vBgnlEymGUQyZeb5X0bdrE5rS06J5hoDG7AEj6AjbT1XUIWeR6/ft+XO+5G8QI+60WlFMslOJPaeROfNz2Zp38slidmJOikVhAAlgGGYeo7qW4uD371h984vrkkmNY22SpNJnctlzNQll1ytmua+w7cwWqhqNtCROrvA9OGIU36eB3sefF3f7nWPY9WqA3o41ySDEOgvTZvxlRdH9OJ9UjBgzdVk9gVABHCDDrzOCcfJidvPjC4DKAq4E8ZdmYh/9+/QNPcaIpsu65+kUl1qy33fe5fp3faI8qLaidiKGm+tLbIzymftIvULvtc0+/TlgWPsCaF/cqAN/THQYOwndngUxh86EYzH2gRXwznjlyYdO1cM78BprOq1DpZ20nxrb+/6DYbuiTKTBblqS9AEcMFZN4d5wbumTj2XAEkdRPucDpolvKul86Izldc+JMZSjTVFS0AExJsd3P8W/K8CgSF1oPs6FCqGsOdFlwgUJn88WMgV4fyenwCg7K4vHgPPyKQ8U8b6AZwXAVHwfO/a9eCxfh7HcHx0AmU/k5lLrvqw1M++wphBo51WQZbH6h2qJYYFGe1B57sfze56+Nc/QBU9k5W5nPnklOmfvyim/m6fdcZzngoy3NTqqBVKINesnf61b55887Yt75VAS2TUF1IKud+Zlpnnnh6vX/gNR9qSKyqChZ1E7dcyYAlWKadL+zb8+57H1v4KB6hnUvEzuaFj2qtfFk+8qmCNsay05wTgsatBQWZZMVHP45/65huf3bvrsl2kKQG2rqLzXHNZBtTrnDzPU/Xvmt78306EV6dSBADZbBYAFYe23v86Lnb3QEUg4iYRURcIMXklA4q1Rxraz7kJaG0MRJqOhU776CEAQAQvEjVAmpNY8UxW58DPdW27/USC4Nx+QlyHPzrp+VgbyNmX1ruhHxgIIsKu2vNAAEpgN4WcrCB1BQB04cAF2VYj7QDQmVHvbc2wcE7XbNy1IxtjzY/aobt+0rvnr4I0H8mEg9XILn1QAJDS8bnlBNY1V5qJSVmT95W/+3YAgjFta8gw+01PESRSMqXBJQAkt2L1cXUej33jpOxnMnXBC1bq5lk3WCtGi2iQG84JU2FUEldYEqs9rf3BnX/Zsf7Pr0uluhTG+ZmsRM68uW3Ka15RX/+mkjUGQoFjrYzd7mhEROq0uMdKZG/q7b028DPJAmP8TFIAJNY49ZRvu7q2OvZ9KCiSKkOZ0Us8FrDai+hi71Nrdjz0s39OpbpUeR1z8lMEqI8hZ1KJKWddnKj/cp0z1nektJSXtkYt2QTKnmKbtNY/ypfu+/sdT7371qH+X/18aPDLrLXSYq2lURlxx9cXgBZWA74zL457z//Xjun/FvifIFCrTV6gu3f9+U6/76l3MFkFaCsShFuPPt7h+hDKATwFoxrmLJ55xos/l81mLZLp41HeXpBOM4ChiBd9vBxCXKNBCO4G5cWTQMbt3g0O0rPjhDfMjmnK65ekE/ZABsSOnEJb7eu1ttwu/LJ34CePulIhCihT49MEYieWWsi7HJhahwNc2kkBipBxL2tqP2uR5vMLFg7lpKfVDk8B0sfAfX7pW0EdM0e7H6j4YsUFkdllP98J+3QkIEdCpEgcnjjv8Ts3Vd46yvU7LlGEgtSY3iMwiCyLCFQ0sRhADKshWL7cw3HSxhzrU7SBn8m0aR2RlkXfL0UboEsVP5MqD155CcGJiGJNxWLPoNn+2CuB7WO0QYLOHOaCSP2S6+INn29H0Q46xcLB6npt51EgIrBDpHV2oOcfftS/709rAL1ylFd9MplWuewq03naFd/kujnPKpUKxqPa53mkzs4pHVGlwt7NxScffTlEKEurD8jPpAtpIWTqVrU2di0hW99nnRVWVFEWHnM8Dq5Jk/qd72//5LbBiwXI37h8ufeWdev+cVFk3nkvivJZAyVjhZWaLIeQA+mYb83lidg/PtbQ/MeV/T2/6ALUqlzOYPn13pZ1N940/fTIpZHW01/l/H6DGg7GLMHxM4m2pmhU0+LrZpz1ktu35jL/fRzrnzhnioYjtZ9/IlLWlhxFpl4xY+6LXrN+fea74z5Re+viCKuynKyEU+ZWuKdrTT7iKU6lutTGjfu4vn7/y285rAU6OibeSNnKL7UjJp4BCBBpbFzaCnYzRFwl7GEiAiEi0sRPYS/yqJqbeyRTMZUyjz1iWv5yWgTPV85ZVPEHYREeAtwc7c1KNxafT324LX0AUTtdSIGQxUWRyFvmM1HeGitKcbWBtQASZag/+67vK3t2/ZwArDzKsyYVli9fjn06xlakqrspCSOoSgS21F/KAhZEtXySjxEICxderM4++w2yv2WTkQiYtUh1dEh2/AeGX8gGTrv7wdP8MGosxgf9mEdGBh1ibZ2zll31xaeI3ogJ4fqTVDl1s0qWjymXWy9A9kg67e+XY9k4oVSqi7JE0nj6a25W9VM6UfQtmFStmzXIACkQUpbF1/6ex969Z0tuwzhtEHp7MknZXE6/u73922dEqKnXkCVmVmJQS9OEAEDExLyI/sHQ0M/+Y9/uIG/OaLnpQJTMTF186RsjrQtf61trPFgN8Wou67vyhsGeIzNgS3sfua67+899WLXqgPLmSCrFlM3Y/+qc/t8viqpF/SVjHGtNMBg/OHECqVdO7hfl/rt/8KUPY8/2LKB+u26dI6D/pr6+N89saf7jIhY1VFtucPhcD0J4FliubWr55v84f1lqcGB3GsSZdTcapIW3ZehNM55Tv0zHZp0lJu8AntCZjTTnBIZTBtZ5scU3Tlm0777dudw9wWzCEfMwP+qk1i+jLAARtxlEzxdI7YQHIsQckejU074zraHtIurZ9d/Fwafu7O7e0D9pixwEoduRxi4XBBdcdZVC9mg2IIL+PRv7y6Gcx801OWCSSYXcChdtvmMle3XtzllLqC5ghmAxH84v9gMwSK9mZKqf99VYywDk4ZL9Xn9UPV+BqgtEEGBAbhoZWpygq9GH21YgiczkgZ3EyNr6ekxZrPW1sJCSYuW5iRF4BECJWMWe2mzy2V3ATgnE4o7ytUwTkJHt22lWZIZMQZUxE4AgLxI5R8zskTwGAKmrblb7Dx1+piAAzm3YcFtxw4bbDuqbEwyTg6CjY70AgBXzuHKuemAROTgQtNMsUnKR5sVvmHPOW6a6/O6v6qFH/7xp0wO7ENiqk1RylR175xFSqatU9qi2MSMcu8ZJMhkoqi677MOR1rkrrF8yikSPHw1UlEddeYmHRIyORLXtfvz/7dlw2zeXL7/eW5cbkUf/Kpbrlbmc/8XO2f91Ycx7To8tGS1Ku8C7uWZ1DOBaNOv/LZaeeu+OLW8QpHl1LjPqIqUZuRvM9HnPXhxpnv95i6hVrqACDa6xTdFInQlBjieyHpMu9Gx6z54Nv80hmdbI7l9oLZ1MaspmzVumtP39qnjdFaZkfEvK47K+RqUNIFhYKMRI7B6l9fd7+t5/U++edaNVbNcgqVf25e4+Mxr76Pz6un8nlAyktpS5AGAQD1ix50Yi7Z9qav02DdJlawIhO4vMagAo5Petf2Wite4eRFsUmbwIqfLiVmX+vHxOylVl6zuJNEUTrad9e8qUx87f/fauIWRo5AvHOJXRk/PzdzP4VUIVYdCqh0AiJTidQF3L4lehbsarYnLG9nrx+5z1wePTMg4vY0qPZn5KSsWt1g3+Nd/71P27N//pnhHfpCNt0FEgDE9KRTrP/MHMzrP2WitM7O2LJRofF7FkrBV2BqqYh3WAMSU4FBGNN26sizb1FMwestaJNQawgzDGwhggGitt2/Jw7oFaJ+hgcQQEkXYKAHjjxt8egJpyGkiu5fSKtS6TI1fX8pq3EMcBU6g5sGRH4oJ4nbsBILkWnKsx2i3nqpH/3tf9qxfFpw6dzYgPSqABPfpzZXkB5TOonfnl9cAHX4DcHkxybtYAaiVg3qY6XrvM0415Y40C9OgtBxFBAjgGK+LNYun2/NA3ANCqw+omDw5qbY9Ckw7s2oknlsjBguAJwbcuDxzDTpwEgrMgFZk266w33cKu5KwtEsebH9devEesJVUqioOFbwzgCjAmSOCXiNdtjEUbewoFn4jyUjS9MBYwhWK5Rx58fPeGPz2OGtc9W75kfm/3IxSfLsQeQxwcj24xaFj2guDYF+NUYtpLVLTpJa5+Zu+cKS/aYewQmCBjk1KWlw6cGE/FHxXz/9s78zg5jvLu/56q6p5r75VWWh3WYcvHyhcIMGDwyMTcBnN41uY05kwIgUASwpsAo4FAgBBIAibGYDAYfOwYiMEJEIOtMWeABduyZEu2Zes+Vrurveborqrn/aN7VnvMrFbS6jD015/WeHdneqqrq6qfeuqp31Pcq73yE5Xy4O/2Pf7fP8/n88FzabKA6XHh1DROggvXHede8hzVeNbHjNWamFV9H2sIawOnSemRx36388GeD07NQZMF1LvQ679v/uLXvDzmvL+sjRasVPAAqQeB2XCjkHaThf/9/nE9k0l5c5BdB+RyCdH8tO9yoiUhvIql8S28dff+AMxGuCmlDz72rT0Pff8/gqDdwxsmGUB+rFDQlzY0XHJNvPkzKcN6hIySobfkkKHFsFBQ8DW7jvrmwdJNXxrY//l7p+TQuBQFfS/S6tK+wqdXucsuu8JxL+tn34g6M8fqoqUWQpb9kn5ZPP7Sj8077R8vLRQ+Hix15TQyGTmQzz/snDPvLxLzUzdqcrWEp1Bn2zIxICCk1WNaxpdeEFv84huRo6tCmfzjIW405wTuT6Ay8OT/qdQCIhETM64VQoBYQ/vGELlCSNnpEHUGKRcw+YqrPwdB1c+muIWAQSqxCMn2s37LeugL2x/8bh7Il+d28GAQNBlKQDWe/oJA85bGiwQEeV5BDE4ZyCDgevyzJQBwGiGAMLu2gcMWJBzYct9YKvXIyrGxffsRuPrmaIknyFfx+96vzOJ8OaAAmysQlpzb/U+iYdkLrS5bIq6ZLTxIAuiSND6ZSvE+IFy+qg+HHopde4z+n2dL97Ulq6flMQqF0qlkrTlTJVquae140XWD+2/JArLe0s5aZC2Qw/MSqdc2gjEcRrZNbDaBwIiAkdo0khL3aPPgrSODv2dk6Xgqwk6luaVTl1jW78TBhnUQMWSi+eETVa6jg4jZAE5Dyom3v5aY4fCEyZYDmHhwpQpBu3eqV84WZXCwXRKAsgwFgNmAHAUa7ftJH375QmR6BGp6jfIWIOx68n8fWda+7AmR6FwB7VlprZgeg8JgCAhAsF8ywVpkQ7OAaFZuI4BAs2v8pox/nGAJ5xJaIZkRsyNY1rpiC/wDt/XvW//F0Xy+73gbKKeicSLQ1cWtK1ubk8lzv6XdFIRfFAIS9fRBgl9aSypGprJncLT/0SsB8mrFmVycal19ZSJxYxsbexAkFdkZn3gMhhTSFIVQ/zM8+lc3lUdqx5nkSC8576rrVUvnat8raxc0o7osADBbI1Vc8siuh7YfuPmdyLJAblbbOkW4ztz57tZ5XzlPCQwYKxRq65kQG92g4uo7o5UffPzArmunLUeFrEfBMpjSfY3vXbSw4zcXkEgMM9ceoRF0LMkGGkIJq/Wrkk7u4abW31w6PPjjHkB25/MmNCy+tkylnqvaz3mb9rRWddpdVSlCQCitR7RqWtndcc4rHigUcp+crdF28skbZLNify732xULz/o/kVzyLKtLhupoTgQQiCApyELOzAhCmesGJQumUH8WBIKMS4otfabkxd9c9vS2vxnt3/L+/nz+3kwmI/NzMngQAAFQBcYUTbhrNYBDM5WqqgoT7Kngh2mB4EFsAbGAJEsJy3y47MlHAZtk2+JnLXGdlPT8sZp1wGwJSCCREu2U7DjXcRquVbHFL/DgWxJaUE1p9SAonhUJrgweMDt/9nMAwGGyCYeZirHR8E3Pg7gyDpDG5I7FQNU84/mwfIGSbwBwS1WSfirVQNjuhtaLz1D2opKBRa3JBANaMGIWXJIOPVIZ/QqAynrkFE5gsKlXLsUoNjX/y3QYBgRbPDGlOkashbHF8XGJqyp7FCxThf8LTHjlCVK1QR8ODX2SBnAkRCy8J3W9WpxOf1QVCrmKXzl4RyrZ8cEKCS2AmSs3zLHErINtHxahjM/UGdB4L7aADI2bhBDx1JlItny0Pdn+1tb52z+yI5+/CdmsQC439SRzwim3WyedzgrkcjbVevmNiC9cSX7REgWxCtM1MwiWgsZshWNhfVEc3PzOg0/+ahsyV8oJgXaiJ5tlC7Rc29x414WSWw5aggqjVOoRzGRYN0ih7iyXb8/1773+3nR6kmFSjTNZfM4r3qhaVrxZ+yUtiVW9FOnVwdzCMmSMTOWgLg32vh47qYRc96xc2/em04KQN59dsPi6Fyv3zEGrjctTvcQEhoAG22al1F1+eftb9m67hpkp3PZcM3hvHUje540+/J3Rkf83Ikm6EBp1HpTjnU0IlA2JZQLobm749gKkOjLZLGdD/RNkeuS2DT/6oD+0Y7twEophLdUQRJ24xCPYSs2eTjSf+Yl5y59/CQqBJ+ZwdXNKsH69AGBGhvf9G7FPLJQlDvOFzPCxQHmYiAUEBAkiWfNgIskCCoJV8DDSIK9sjdZGpJZc0Lrg3HsWrnzhu/L5vJm7OrOBHcSulCyUhFDBKykJKMmkBJECkSKQIiJFgCKCFIAk0PgBYgmygomlclTf3/3dtmpm02Ma4CjQdJBsKnBS857bsOiZj8Xmr97cuOiZj9U6mhY/+9GmxRc8Gmu74A+xplU3I3naC3zWVrAV4NgMNcFGSEV+eejW3SO7+9Pp7GEFzHKBvAg+eWDXz7ZqsysmSVqevGxHYQ1YIulbpnPc2IXoRDIMRJw2ovRkMgDAL2xseeNyKOHD1Bx2mAjCMgvpyg3WG7q5sqfnRAbCIr1eAMDw0L6zg5hjMcMkI3igG+Odcs+mmhAAIgUBBYKa2DeISIlqX6Dg76CgTxAFDkYilgQjCUbCshQMqeXhb0uhkLMA08i2zTfqUv8IFEnwbHPdEAEkQCyIao0zQhBJARIKxEqQViAjrPGt9TwN1brEbV799dNWZ65HLmczmYzAjJG1R8ep1QDCB/2S8674oEotf63Ro1qQlPVVvBggCwOllVKqMvToFwc233NHELNxaMZ4bzotKJezn+vo+Pxr47Hlw9pqScHIMFNSP2ZtU9KRP614O969Z+dfczYr1k/TM8nplhUXnS+aV/4nszTEkDTT8hMFGtaWXCNJi+Lglr/ev7U3FIc7/Cy3J9BU0R9atODaq5KJV5e11oIpNIYmTGgBMDS3CsW9jIGbBvtfJoDBbqIZXec5QN+LtPqPgb7/vNvjb6UUO2AYqq3CHl4SQxCLUavtpU6yfV1n602Uy9lQ/4SDRdLhgdL+zVfBG/CsSFhNkjHNaj+EYJdgfcFuo03OO+fW9vazFqGnxz4lBNoKBY1MRh549L9v08M7b1Iq4WghPEslDgS4DtePacb30MT3UBD9w4KEICuNXzbaaTPJhWdf33HWZa/EnBkowfcx8bhJX50sjB+TCzjlOhiT73d1xZNUPj/HHlxmQMaFdJtjwm2KCbe5ztEUI7cpxioFq42BXzIEFkHUSu2uyGysko2Si337/dENnwCyYmIqjJlKFaqwDj9p7V2SFIimWxPVu+pba5ZLWvTeyvwMIRBZw9S35vN2SdOSttVEr/XhA6zqKMISCDCusPSI9u/cOob9NmgTJ3SZ1HA1i8bh5mCnZphJPQiBl4TCJZJJk+hpfaHWtVX7VvCTnV13sMh0i5GRB7fo0uA7JJNgCQu2R+AJq2VTHOqnh0o7ftsEBClo3/rs+PG2c961+JzXXBdOguZ8XD51BvpQz6R1+fNfTI1nftpa1gJQVVdxPSyzEU5c2YOP/27vhu/9TTpw/0/WMykU9NubWz/w2mTTW3zt+zzD1t6JJ26CtBuNsF8qjlxNwN7u3JS8OYEkc6Jp3oVfQ6y1wVoNcZiEfgBgwNpVUumBx2/q3/Lj69JTxOHqVhEgr0beXNHcfOGrVfL6BqtNmWzNvDmaGCkivQ2O/NLQ4F/9eGxs40cANRuxpbUoGAbbf9y5//29nt3ZKBXZWVjlliArfkW/OhF/6d8t6Px7yudNNp0OjK50Wg3s+sWv/YNPvtuhsmIShmdsfgaSHWF1iUVqyaLEsouuBxHWrNlTjS49tcnnLbJZsf3Bm9+uBx69Oy4d14oEwEoT7HF5KFgQBEGy8UmrNk40rbxp3ryzOwOj7hTq6xMhsvPnH4elBebAfX2YA6wZbACCrLq9ZzinIRkjoYfIG9z6tv1PPLQPgWDgrO5nX6DCSoXSyHf2Gkbcsqg1VhAADeYWEJ7hOK8GwOuQmfTOe4O8PXyt47/9TCnmj4J1PUVYwCLGQuywjHs9/ysAqDt/4gJhx2EjZ5sV/anFSbqmfDCu7th4++2V/sc+ogBFKi6YWc/ei3LkEJEAj6myhRdrO/3d8894wZVzNwk6xCkyYGUFuro4tWBlR9O8rq+xk7BkKmI86G76JgcQGMzWQiUJ5f5dw3u3XgmQVygcWi+oxpk8uzn59Nc3t32iCVaXIepm6SQEKq0AIEmYEcdVd44Nfeh/Bwd/eQ/Skx/s6axEIac7L7z6OpFasIa8shbE43lzppc5mDEbGCPchNIjO3t3PpT/y8yUJIQzQN8hMhZIvaG5/fZzpHKHGZAsKBBWC9yhloJCJi1rTzrOzeXBj94+2H/Ll9esceoF1dWoB86DxB6MHrjDt9fsIRIuMVsOwmiqdvXUV7CEZpKuYf+18eSn0smml+QKBZ0Zz7+TVnse/sGNxcGtdynpKAsy9ZxiTAxiggJLY0Z8p2H5KxZ1veYjvb03+E+RBIEcrMWy3b7h5ld4gw9/XPkHtYg5CsIhsDBkoRnWMKxlULB/Y6orYqKzgekweqRBv5DEgvySUYnFrYlFz/gwiDiT6Tl2g44JDMNgtmAywYHgsDDMMMxcPTQzNDOFrxOtAmhG8HvDVm7Z0ukec9lqQjTLo9Znw9kwIwgEIg0nIaGHzfCBR/9i92M/vOtIAwK7EVilNw0P/OJhLj+plBDByv90LEH6lnG6Uhc1N6N1ytIOrcV6AyBxvqve5sIyWSXqensA6ypBD/j2kfxg328YjOOtCDuJUOcm1dCwlZgBsnXC2DiMgSCI2rJIpxxhnjUGWwtmM/FgthMO6OoBhobl4Jj4ewSvgmefTqLqpd398G3/NLJvw5u4PLBDqYRiFRMMWGZoWBgGW0YdfYJJ48zEvIW1CXy1LpGtKCvjHG888+MAXHR1zamVdkoYJ+k0BHI527bwom/I1IJF0GNMOGRD1HqAGUi2wrXSjAlv4OH3Htz7q21T8+b0ZDKwgPzr1MKbLiIZL1pNYobxnclAGQVA65Qj1f+OlW/9TP/ezwZxJoVJcSYo5PSC817zlnjjadcav6KJguzINcvMQSZyQ9palSSU+/rKB7Z0A1ScZUI/9CAjLLO6qXPFdVcI90xfe9oVJB0BOAQoAlwixJgQB2zMcdUdY8VbPrN378c5k5HvmkVG44l0A4aRkV/ct/2eW0dGfhBXSsaFZxUJSEHhd05+dQmQkqjMVp4vhf1gW9ONXUks7Ak6BhUKBYMsi719P7vaH9uzCU5cWKY6ct6EYMMFQVpS2vo61rz8I51nvOiFvb03+E+R+JPQ70eVbRvu+OjI9vuebUa2fpm8kV1SGEluSknZIAXFBQkiCFv1EYe2SfDsDAw/AoitBet6rlsCj29RJ0Bq67GKNb5u5cqVzaFWxNEbKByURVCKoGICjiPhOJKUK4WKSeHGpFJxqVSyeijlJJRScaVUXEknPFRcScdRUilXOo6SKDe5rnuqiLBNgGGIYeEAKinIIcVjezZ4ffen9z921/VIp9VR7FTg9UhLAMUdGrcxCQTzjekIgIxhc5qMLfyb2JI0AVxd2skGMTzc3dp66XmOe2bZmPAJWXs4V8y2KAw9yt51ALz19bVbjg/54KHVGG8ZCHZr1Z6SHIo5E4BwTlz5jgErJOC4RComSMUkqbgklQgONynJSUpyk1I6caXCQzgJJdykEk5SCScW9AfHUUI5MeG4SnKp+YgKEXot9j/2P9868PB1a7zhxz8gisObBFhIx1VwE1JIRxBJAilUH/vBQ4cmjDMSzE5giLOtq5A8Ph0lCGjPuon2sxeffdkLkcvZuRyXT7p5mg4T5C2/MPM+alr1kor2tMNS1U8HymAQDMG4Diu//8lP7X30J9+dqmcSJsHT/9552vUvjjvnHdQlw0JIaRi1osYYgLKECoxtEzFV8PzH3rp3+zs4mxWUm+DZyGQk8jk9f9WlFzgNy6/XcK3gsqTqjoYaEBiBJLywjimqsb4tf9O3/edbp4jD1aUHkN3Im7ctXPHGc2PONY+ZUVMUSrkmaCTVrWCWCMzgpBTigdLYr96zb9e1YfmPSjSHkA/ULQ/krl4dO/3X57ryPM/XzIIm71WsOrYPvYp9nm9XuYlFr2la9m9UpNf3IENA3iDXLYB9YwdbN1/VKuMbpNPAljXPvBxGBPaFlS3ktJ3+reaO854z1NPzBGjdic9WeuQEGwwzGXEgn//9gT0b/nz+fDTEOy+/lGj+Wgj5PJLOIqJYC5NoEOGGK1HNwcSHTsMEIVRKMDPYeAaoNwMFWBCRsYbiDa0l55zLga3fDkTGjlJxlwCGBzt2oF8Q9Sk3tZMZYC6zhYbVDMBAWw0IOeTEm7cKAFprgA2UNwZrAWMMW64QCXmwqXXR4+wNFB/ftq1yqK7mDAazqXdSAqq7F+r57sAkGKZsURnaWBnr+/LeR+78CgC/KnVwNIWqJti7Z6Tynec7sQ8uIiEqNZaumQg+ETeR5bNJvQnAf1V37VRfXxmPdy9h8DDYEmon7bIAJwTJhw36vjE62sOBq+ikiJqVSgOSk/MRPCBrBNgzQYTek0p5uOvEl/AIIQJrD763e5+00pfx5OPE5DFbssayRRnWWDBbuMnmTUyyAgDWL0FYDU9bCOuDTYktE0np7Im3N+wuje4aAYBQUHF2hAbKaD7fN/rAtz4P4AsdZ7zi0kSi5WLhJJ9mhVgtpNPMjHkQMhhfgk6AsHMDMACxgHIEIwmry0wwdTyLYRVYZnYVy9jCDID/Tu/vosLR1ucUTq5xksnIQj6vF6962UWcPO1fNPtasZVkZRjQXau/ESyscVRM+QNbHty54Tvrgi2TN0zQMwk0PD7Qtuitr4ol3qV1WVtSyjEMU9VLn3ZWwIPDzcKzD7PiL4+OvYWAsXwuF7g9xt+WAfCrhNty+i3CTcXYrxgCCWKJYI/51PZEYPJhIbQjE6rS94f/6Hv8JzeHW2xnNcB1hyeVbuynXx3pO3tnBZSCQy48ePBQcYGYB1TcwDseA3D7wMATBHiUy816TbwGTMgBQPEvdj3+4mc3tS9xHYxoroiEB4YLwAOqrxU3+G54QAVAMxo5+AW4G9WOFnSisXz+oaZzmt6u5nV9lVlpsK8sJETNolpI6wgthrVMLOhoWvzMrw0RXZpOZ0WhcBgf5KkBB7PsrMhkVlM+3z2Kvrt+AOAH4d/j7UvPanPiS5sb3QbABVy3EUBD8GEOzOnRgwc6HafhQu0m36QSrRdYLS2RL2oFdTMYgpmNSLJKtF8E4NtprEVhZrXROlgGKRJa64O7f33p4P4NGzEHW1B3HesJZoBIEClHTQrIpeqLDILSTRmwtmb4OjOxFIpMee/Y9vtvegGA/uAEHxXIH702SDVTMZVyvddw6nfLhXpWibWVNYwLC0jWPi0W4gVLgDaB/EAWEAJ5c2FDw/xV5L6qwkyWSE79MBMCRxzBKKHkQxXv7q1jY/vXI62Ak5MSYqD/gGiJnwFIArjWBqRDWwkc6bQAOKrWekJgtiRdQX7fzp1/+MZ5AMrhMaffckTvDjx5VA052P/YD+4GcHf4V7Vs2QUNIxCdjQ3LIN1GuK6LYPA+NMYM9z+5FInGM1V83iXKSV1pRBKwlTCmuqaRIgyD4DRfCEAVCusMgmfGMXMyjRPBPT12wYKVC1TrkjyrpCN0yRIksZgev1dVVTVgJhUjM7Z39ODOh64GUSWf75qiZ1LQL3aan/7qhtQXmuHrMSulFBzs5asT5MAAHDKmJBz1g+Gxv/vBYN8vJiqoAsCaNe9Uvfluf8UFV13PqUVd2itrBVLVXQwT2xKN20AMDTJSJpUeeaKwe9Od7wvF4Y5kgGMAuGH7I3sA7DmCDx2LYTLxu+kAsOeu4f5Zf3fAKDBa49eH9E9uXHphy8Wq5YxrbZk1pFUMVJUyJ9wqAZCFZKmMLmrVtDi96Jwr/7VQyH1gzZp3Or29N/g1vuUUJGfDOERCJiPS+7uosH6dAVG5f8fm3cDm3XtnPsEmAD8F8B+Lz7/qS/Gm09+ubSiKOgUR7goSzATlrACAQpi2/sipzqwEWuedPTS4/yGLNe9wcHmnwaZN4V3KTPpEepbKnoWOTTxnQk5MsGRYiRj5xQPbAH27kNW4DgcAQ5AkRymumGIjOPY2xBodWB+YogFORMSmYpzGRU2Lz3n1G3Z1n//F9HqI2U4oZmJ9IGevN1QqP7w4pZ6lGJZp8j0kBogsVUBmpSNb3jh/0RWf6tv99eXLlrm8bVv5TbG2t5wunWbfVLSgGgEaTLBk4YDEdmb6YfHg7QCo6rk5GYhScQDMo0zUUM9LakGC2IKMvxIAcN/HTmFtIwbI9QAMgcC4cuKSRmbCv0emdHuMfYJDbzwBGZFOd1GhYzUj3623bXvgIICDA/jDTJ/fBODHAL7QuepF73Dbz/kSiZQId8JP/zIiElbDCLWktXVNanCQhjA3z52TZpxQOp0VRKSXXvi6mzi5ZKnxR43LStYTngr0TJhZKCtNWZYOPvn60YGND4fLLNUbKXqyWaZcbv4b5zd/5wKlk8MeWyslydqhQIcKxKxTKqZuLo3e+fFqnMlEF3g6rXoLN/iLVr/8L6hp5Zt932gJVnWsyQnxjNbCcYUe3TPsP/77tx5BQr+axczOMm4gd7iopiODGaBuQHQdxTlzNWbZhULOIJ1VxYe++L6EfNVamVq6gvWoxfRJIACMC7RJhvKN0ar99Pd3nPaS3/f23vCtp2CCQEY+H+StoBww7lvNzvypzCZas7VV9P7+q/6uB29/x2nPeOvFIrH0HOiiBU3NW0QAWAAWVtvTAQB3XHXMRoD2iwpgQm+nQe/EJbXJuz9Oyow3aCSWSEqjRzbtfvDbfz/T25ee97oxJ9Hyt9ZoA5q8VZdhQQAZKMiGeR+c/6Uvfa3w7ncXUTj2gXc9AjmCn4wUb/2zeOrDZ4JkiYO7NSVhATQYzUw4k+Q1AG56y7Oe5V+7bZt7vsJbpdAoGzE9YRUAAYZlNnEpxKO+ffB7IyP/HSyIH0Gw5ZyRYwAYGNhwoGnlxUMCsoFZT8vdxQCILMAMcpKNAGJgrmCOHnbHByYACgw9Oa9VfsK/JwUG8qZwqCOGdZ09zPNjEyG9n7o61opN+dxXFsWTF8Vbz3ub9a1GLVVCChKwCOnYVavO5t/8pnfOLuDkGCfprCwUcrrjrFd/Ujaf8RLrF31llWNJ13axAgABNsxBowef/PC+x+7+QTqdVYUJOWjuRVpQLqc/M7/zC6+Iu8tHtaetjCkJHzM90y1b26Rc9RO/vOMv9+5664Q4jYBwjXnB4uddJBtXfMGDYyQXJY3vE5/eb5gAG/QyKL+I0YFH3nBgaMNWrF17LG5Vzp2kThraWnM5sDEKsP3oH2lreOT1DbHU3RDNCdgyA4Lq1StBQLAvIGM20bnyP1rEpT87WFi/LdA/OeXjT+oRGpKHcYfmgV7ABN6ir/i2PPYjN8Hn+BA1vCcT66+2wXdUkKgavUcfXHvc4PGSEVk3nc6qRKJNlkoDk9ptX98mMX9+l/3tE7d/bkGy7e2kWpqZ9aRrYgIEpGBdNk68c7Fc+OJ39OVynz+S5dh65AAbjjFbdtnG+1Y78UvLvjFUQ4yZQcJjH6sUPb0rmVxA+fzed7R0vHx5zD3b97URNE3/BECo3gzFHog2cekrAMz6INjjZBjxHCqJesR2J0Es5moRJ0KhD5otWKrFK7vWLNi6qXc7TmnjBMChieAp2CfGCesvd/h6LACbMh0S2ayo5H9/i6srbyOIqXZz9aTExMxWtz26e/NpAB6qJno81gKf+N06oZ7JgpXPf0Gi/bQPaWM12DgsJm8mmChVz0SwrA3chPJHd/1kx4b8JzBlkHjnmjXOpSjo98zrfMeVjY1XGd/3DaSSrEF1lnIAhmVwQpF93Bhz+9Dw1QQM5IM4jfE4k2xXD3d2dibjC8/6JrltUuoyCHLaA7S6HBGeGpaEVZKEP/Lk/zvwROEuzFLP5I8fwrgxkc6qgW2/+LUe3v4+Iay0cAyTgZ2SI+LQLWQICMG6AsTntTa0Lv0uwA2ZzOrQ+/DHT0NDJwNMWnt+nZ2oYQS+Ddv+n0aTYwgE0n4MsOBCIacbGzt1oZCbdGzalPcAoLj9kT2mOPQ1RS6ZKYa34CAkn4iFZcsca/hoct5pncGa+rGPm+tzOQGAH/b1LaMArAxSFkxFAORZmDOU03h1Q/PlAJCOu2/vZA0fguuF/lgwxwjyEWuGvjo6fGIVYWuQ2bSaAFgD+2R9PUcGIAlsjFBJZ0wsfzYAQjp9Suwq/ZMiDyCXs2ZkyIe1mJ6zJ4AYTEwkyRlpj8/bF/z22A0T4MQbJ4SuLl65srXZmXfu11m1gLgsQEE2xTqXD7BvSSUEj+3vK+7rvRbMhMKhXpkFxFd6e/2XzF96+puSyX+Z73s8Sq6qBlfWqykLgkvWeIip742NfOj2kUDPpHuKnkkuR1bOv+wbtmnpmdaUDNFMeVJCFwNZq4Qry/u2/GbXhu99mgFCIaerT9A/7YMReDmYUMhprHmns/uh//paZeix26TjKA2paYZ4S2JAkBDWr2jRsuLpnWdd+Z/5fLdJp7NPhe3FcwWzkFMT29Z+4wkozFONQFuIyT/w8L/73mCRpJDS1lpTFmRsxcjk/Jb5Hc97P0CcTh+7SnHVULh+bOSHj/qmlCCWFk7NW2XB3EgGzxDxy4BUx5lCXV6CZkNWzbB92DhC0BYrvrd1bGy/xYlXhJ3IeMyFKW0SMOAZFHuYLYRwSCL2VgCcXbv+VPeI/tFOitiaWY6pzErF5/Q+ndBlnTVr3ql6cznfPv0tN8rkwtOMP2IkK0nAlADICbAFhGPJFFWlb+NbB3Zt2Inu7okp4cW6bBa5XG7Rmxxxd5fk5gFDVkEfduAmho6rmPpuqXjrx/v7asSZBHomnV2veI9qXnKl9kpaslD1+vhE7SwiCGs0qLFl9Yrnvn/jSiasOIyE1p8CTGyFdKQ38MRPdm6kQ8HB2azY87nPvWfxGe5aalqxwHplK6j29shqLQpiZX3fd+eveuN8eundhULum0/B+JOjJCuIHvJP9PMmHj+hX3c84UwmL/P53u3L5p39VSe26r0+FbUATRsTBSCNAYtU67s6Vpz7r4XCujCD8jEtI3K4a2fXo83mnjWIvdxjT3ON4NYw1w7mCfvsD7cnPnW6w1TyXatIU+2dWoALQbsZ+LlX/CYAyp/M6AccytrsVwYfcMxigATVa7tEEMb67CTmrW1f+txFuXXYg9ypuWxLQhyVTMNTBIo1NlSCZYR6iV4CmMikUs6cjrsnzjgJA0oXX3DlX6NhyWutV9IiSBIGVLU6JiHB0NAkfVc6zlj/ps8eeKJwF9a800F+kp6JoFxO//OCRf9+eTy2YtivaElSBe7OetVJ0GA7T0j1I6+099q9O97BYKLChGCxUM9kwfLnXeS2nP4Zw8II9uX0FBeHmJRfhAUAA5WYnzKsugB7aBWoWqzqmyf+furrtC+peTm1P3+4vx/Ja63vP8rzGHag2lZ2dZ552YZ8vvurSKcVcrDASP/Y4CNXNbmt97LbxGwqgfQY0aSluXGxJhYQXFFWxW2ycdUNzaft3DhUuK8XyMjZ5Cl6iiL6OiCAnI7Hrjkr6MIe1WosDGFBJFwn+RgA4KNWIEfjA3x1NhtLtD0MxktRf5AlMBlWcTkErEA2uw35TQqb4M351Z1A8vluCzCVx577iXhq3luEbGgE+wxM9WFLYusZGZ/flGy+4O8B+kAm0yOOVQF+HXICgO0tV25/geu+PAWuGR1HBPIN0C6w7NWJ+LVGAxJ22hbyYPs4wRCsK0k+5OutX+vf94uTFwg7gTBrc+PBx36hG08/yLFUC2kw07TKBkDEVhsn3hZLta34536ia9Lpe2WhsIlCpdzjbwzQYewgCiQRCdTR3Hxe49CLzh4O7L8/inGHznjJQvXYj1BJisbzhXJhrOba2REIIAOhWQwObp3TQpwY4yQMKO1YcfELVWr5Z4xlTbBS8PgO4OmQDgJgVcypHNzys/0Pff/DyPRI5Lun6Zm8t6X93a9Pxq8sa62ZhKK6T/ZqoKrhRgh+2JK5aWTgzQSMAZMS4hGQwZrOnyf3dJx7M6vmBHTREkmaqVtM9ItQ1VDRGiDf1k9e+KcFAQBX2KgEuy1nfLFl+fBvDxYKDwBrBdJpdbBQuC8WX/DeRMd5X9RwtYRRwpoZ1jxdYltkJFtjTfPW3DK0fcMF2WyPl8vRVBPtJBDaDFfeLmeztbZQ43fpiX9fC4tczm7K57zTVr3mMukueJm2FUtU27fPofy6MeVBAMhsylOt56lU7mHS0xMYBkrEyEH8b5HL3QPAG7++ucJaAq2jEzhD5nR6nSoUfrV/UWrFrYmW1ndp7WuqkXuLYKWPkiW37a86TnveF/P57ieONQg7F+7PvPlg3/+8OpEceKaUbR6HydAnlRLQBCSYkIBgw6DqrsaJb5RM0AKQDKvhiN96I3kA3nqsPVmBsBPhbDYrcrncgRULLnlQxtueb1GeHhQbQhDSs2Mm1nDam5d2XbW9ULj0I9W/IHOoP9XqM1XSNX5XAID160wQ2D3j8HCYsYMI1hhOtDSmFi1791A+/4nxhes57xMzedzDL8vcLrF/I9W65onUHmPWA1gb/D3Ydmwe+9EXKu3tSxeZZGsO7LBgv6YZCYBBksDFka1be2feeXKEnADjJCvQs86mGlYucNrPvZVVg0N6zAoIqruUA8CALSlXoLh71+CO374ORBXkN07TM3l5snnN1U2Nn29iNiNgKQ9TN8ICLrEpy5i6pTj8dz8YHrv7XqQV1dAz6XvGNf/pJBeuMl5JSxJquv7GZCYmKTxkHhHAtZcn/jQJ2rg1JcuJhaqh7exbDj75m4uQWV1CPhfuRLnhuiVO6lKnbdVrPZ+0U0vHAUB1/JCshNYlI5uWnbnovNd/OZeja+ZiV8WxE45/+W4z0yA6E4UpPyxYcP4K1X7Wn8uGxX+tlePCeuHupsmI8c2wDNLmUaC+1oJhFtPPMOkqQGSk1b51G1e8dOl5V39t+MDG64b2bLgfPIdBljRFLOgEUE09Pzr49M+6yfY3kmpMgPUU70n4o7Gs4m0q1XxGFvj5NZnMpmP1nrDNZCTl8/2btfnpRY6bEVob0OSlJUIgpSBtoOEJYkhMnycF2+mYU5BygzXlu8ZKNwDApSicEssh69dDALDWDt0mufMSkOX6YY8EYpaapY23rvjw8qe/6Rml0b3/sm/L3T9HvtubTX+q+55g+37d70UgWiGpRh1PfisLNrCJxpUfX3R+pqT3Pvzt/fsf2jenLfiwaWSrO5cD3ayjGWcKE/4FgLY2NMXmXd4db170/yjWsUDbCotpUgXj385EDoyt7AJQDHdlzUl7O+7GSToNUSDS8y94w022YWE7e0UjEQSUTn3IB+nkBRhgq4SVfkmWBh5/Y2ng0V2Bq35cz4RCPZPENe2tt54nHXfAeNaBpDoR7/CJoJhhCTqu4urm4uidn+vb/dkvr1njXNpbOCTilc6q3kLOX9iV+QBSS97MlYp2iBWHhZ3JARI5R2ZDYLYJQBi/qGXTyq6l577x8zvy3e8IDQqDbFbs/Mxt7118buMFKrHwDK2NlUSipnFIFmQlHDJS64p2W5a/eeGZl/9foZD70kmJPwk753nPzZw1ptu/42nPOE7TZjZFbUwFvinapkT7Q8Za31oftlIBYOH7GhYWNnzWCwCwFkLEkEymZEXzuTKWWsqCnum47SmffcB6LNihWnnCAoNCEJsyxkYOPAyE4k61KI1K29A4wyJotURWGFbWbVl1bWui7dqWRc/ZrI3Wc2BPMAFWOK7Ro3s/vfvhO28PVJ9PiIvcIpOXw/k/PNbYce7X4277e4yvNQtM8cASBAtptWcp0fb6xasu/lw+n3/wWL0n+dC6+V1l7MbLEk6mg0FFIsgpq/zVdk9EYFtrGTwwYBwL40ihnvSLP9hQGdrKyEg6RZYaAkMQGDu49b9S8YWfhduYIOvXNK7DvVdgqgjPSisbVr4kGW97ybLmlY8bq38vWfzBlAZ8rSuwwuXJG5EklCMghILjpKAoTsXy4LlCJWIylmKrK0uVG281w7t+um3jHe8LPTrBclHWCuTIkHS2A7QMMzZuIrBH2mlELNbwr7H4/I8sW3rxLm388IYdU3UxE0gy+21sL3/ggW/uCltA8JAEbCq1oGPemS/6IWQyRiq22RqusC7CmAoEvJFEbN4W35SJdZlhLYy10L4GBMJxRkLAh7CCVKIRLJ0OVrGzpaCnKdWyxJKCNT4LsnXdQYKZmQRrM9ILAOn1EIU5UI8GjrdxEubNWdz1qg+J5hUv0XpMS6jwO2vdOQkjfBiOGUdClQce/ci+x3+6vhqYWn3Xvem0pFxOf3nh4uteLuOrRvyKhpKqdpUQLGk41oEGbLOy6uee3vyXe3e+kZEV1Dthdh3GmbSuvOx5seYln2FjDQItfUSxrHNJ0L8koKxf0qql8+0Lzrji14VC7kZkMhI5MLB5d2VwRTecxl8KkXLYesH0dVofOdRfpTXSSKnjbSs/37L0uRsOFgo/O9LMsXOF5niSYvNWOzGAoM4XaIGkQM1fh7MzAkOmgqIFIoETU71YIBxAmARizGAWsOzDN54JlnJETcMEAJjBUkhhS6VBM7T5xwDq5urQ5b79qqH9MCFvFK43aKG1MeS0SBGTZ8XmyIvLbCHdJPzhgWcBuH3//q4TZ+rnNzLAxEOXfMbK+W838VjM8S1bMcWPTQzLzCLeoJzEyn8GfvGyY/WedANWgHDT8OB9r0o17Vro8GJotjwlGHzcROLQQGEGTXWzM0EIQ3thUPAqXwGAkx0IOwUbBsDvSbSs+pobW/AeH0Na1HkOBSOuCLZz+yUDSggRbzpdkDqdgIxIdcAFIeg3POGofp5AJGBBSCTmgRHkH5OOBTku/OED2wFgU7DNGcD40qe1fqlfJYjrBwgEEATAPliTgdvaIki0zFWfsERQVsP3DjQD2AWsm7RUPWaV26aanu4mF4CtXi0cAqEdFE7RDQsIqo4jDAnA5aBOq0tQxBYEBgsZntiCLUMbYwiVoALrXg+DSQrWRbL64O3ADBOgo+D4LTdkMhKFgl589mXPdlpOz3mWtLRCBkoutctvCTCAcVyp/IGt9+3d+N1PpgPDZHwE7kFGXloo6Pe3zHvvy+KJa4e5qMtKKGXreYQZxAIWzAkJ3qKVubHc/zoCRvOYlHdGoKfHtra2NifbTu9hp1nCGhJgsocLjoo4aoQ10heujbct+/f2Zc85G/k7gnudzqoDj/3oD5WB7f/gkJVMQld3Q9U9FyRB+8K6bW6q4+xvNzcva0FPz/RcCCcAIdiyrliry8boktZ6TGu/pH2/pI1f1MYvaeN72vhGG19ro402xtPGlMPD10azNtrX2ve0p31tTNGwNUw0yYqpVwJNikiX+24fGHhsOJPpmbaVtFAIBhKifT+FP8ZMmMV2UwIRJFgjuL7S3Bym4lm/aCF47Biq/SjJWWTyYvfjP9vhV/bdrIRDltjWqmIiK62pGJHsfFHnqkuen8/3HGsmVv4pLlEASjusvU1yDA6zrZWcdHI5AgNl0u9gbQMc+ZDWW28cGPgZg6l7jmaxc0U+380A01j/xk+jvGtICFdMu5BaEEnAEuuKZX9MG7+orTZaG18bUwr7jKeN1uOH1b42fklrv6h9XdZal7TVI9qaSoV1xQqypalfc2jL8+h6ZjPLuDUCCBLW5zntE+Ehbb1gZmKwLYbv00aXtG/GtKdL2vfL2ugxbfyyNr4fjDF+WDfj40xJa+Np32it/ZI2Xlkb3zNsPUtkJOrslqzCDEMqJkRlf++ejT/8P2SzYi4ngsdr0Cb09Nhly5a1OI2rbtFO0pW2KAQrCvpK7fvN8CyplLQju/sHdv72DSCyhcKhD2QAeRXy5uWtree+trHx3xrYGJ+ldA2DYFFTpgCAgYKCNT5B3lYufug7B4b+MEXPhJDOChBxYukV3xYNHZ2si0YgXGeLlmuOG0ySSPuMZHMq0X7OdwF2kVlNKORMOp1VBx75zuf9kR3fFk7cYWaNaixF7ZNBEITVJe00LFvauOL5XwYRr1nzzlk8zI8DRCLIQEdKkFSCSAmCAkGBSIFIEbEiQnAwFIHCA4pQ/ZtVgqwCseRp0+WJMJgYzNYoqRxT2r/3oH//R4CsCB4KU8kbZLNi18ZfbNBe8UFScYCtDeOkDndx4fWJuTkQnutkxWflNzIA8od2ftKWh3wIIQBbo84EYC3gpGQ8dcY6gDgz/U1HRDXfzd2l4m1brQAJIeRRDPFMbD1y8Dvf6wFQXo+1J1XbpA42k+kWA7s27KyM7Xi/hBUshZ6dYzpoc0xivO+Iap/hsM+QHT9ANuxnMuxHQgl2VRCyQ4JrtLXq0tPo2OD3TOVgRVCsTjuoWT6a0z4RHtWkfLVgIHwfSSJSAlIJkBLE4bUjrCscOnCozkCsIEzwHkGKQBJ1MlxPug9MDEFMdgSVsf0fAqAP5dmaG47LQJDJ9AgQsW17/i2cmr9CeBVDUIKpuuti8loqAFhi1jLB0h/1xg4+emVp4LGd4CvlhPVc6mG2DDS+M9V6x/kOYcwEWfeYGAxRVwlWWqPjrlJ3FSt3frZv92enJvTDmncqFHJ6yeorPhhrXfpyoytaspDV+Ij6CrMRcwERSeNVjNO4+JyO8173JeS7TZjiwCCbFeX7b/5zW9q7CSqlLJMF2eDOTBkymIIMs4KgjB7VbuOK7gWrX/HB3t4bfJxggbapA0qQCD50NYNCp+qUSe3UZkYT/ydwX88coidgGRrKlayLFf/gtjeMbtlyIEzZU3sGvX69AGC90R3/JO0YsXAN2DLoZG/uONHkbCbTI/ZtKzzpFfd+X8gYMddymRIIQmo7ZmRi/gs6Tr/slfkwXf3RfnOQqZjp+8P99z9hy/cnhBW+JHO4B/ZE74kFOE6Qm41Xumu4eDNwKIfPqUY+nzfpdFrt3HTX18sHN1/nUtyxQvhgf1blpXBJNPxh8ut4X6nVzxhM5nDTFJvJ9MjBrT/ZzsWBz5IDYQg+6svanmJUGw1NqIl6O2LDWmIRVglPGFTrVxJDWyOldkVClQ8++c+7H/7vnxyP5fO5r/F0WuXz3WZh1+UflU3LX+pprQXqK6paESznWCbjCJZe/+Of7n+8EMSZTAjk+vKaNYqI6N8XL78hHRNnjfq+ZUnicO5Pw2wblFI/rejt79gX5M2ZFL2eyUj03uDPX7n2YtV8Rta3xigLWXtPd8RcQwiSnQmC1Npot3XF2zrPuuL1KOQ00mmJHNAHjOLA5m72+g2ErD7np58r7FuCAWFJejDabTzrk20rLnkhCjl9jO73I8KJKZ8ZZlYu62OGmRnGkjaOTClZGSmWRja/cteWH94TxPDMELBZKGhkMnLv5h/dUTnw6PUukctI2DndhTNrTu4kPx94T6AHnvi49vqZRC2hsGBLHsNCO0nEm5d/BIBCV9cxFT70cujHLW4xUHAtc73t81PhoM0bVzj0oK9/db83uomzWZE7xZZ0JlIoFEwmk5G7Hvrue73hhz7uMBwhk4KZNcPa49cWmAFYZjb1Arby+W6LbFZsf+iWT1SGtv4qJptcBuvAq3jiIaqZ1qZKdYw5zp2HmdlaZhgl4iJmrVMZeuiTuzd+5x/S6aw6HnF9c2uchHEm8854XtptOSdnja9jmqWtW7dBnbIlo5y4soNP/nDP5v/66NQA2Cyg3tXb6//DovlvvtJ1r6742veFK4P5Ak/IAIww6Cl4emkQNwrYR1ibb4wNvY6m580RuOMOk0qd3xFrOyuvnXhSGI8Eq7qBhhHHBwIB7AtlpJGtp13fuPKSVeM7bdJptePxezeWhrZ8SApIJmFq9cVJPZQEwfok3KRonLf6y62tK5vD+JPja3WGrs3R/aMdjhOTkK5gIjDIMEMzWw1mTRYmyHDGHByWMe5dqUX1fcxgNmAYZtJgskQuSScuFUia0vYfj+z73cV7Nt71v0inZzdo5PMWmYzc+cidf1kZ3vgJSaOSnJQMxHpIk2UDtjZw/xAHepETj3G/0MQyHrouZgO2BsyGmU1gtEHDkgazZoZmEpohDYuZ3JRlUPj5eoclmMCwOppAsZxFpkf27frNAygf/LoULpElD1O/g8kIE4P1xzyRbH/G4tUvugK53DHFnlS9HN8rFu981FJFCUsaNqi0GQ5LxJYtSxjshcS95UARdl2Qu2dOEEyWGSZsw7UPULXeZ/uQ5Hw+b8HM2x6446Ol/ge7jT+0Ram4kiIpAImgfUCH7f1QM5t8mvF2GDwPbLXtBQZ2UD5t2WoGWyZFEK6rnIRk0s31yoZcjgEqFe//1UsrQ4/+j1RCkUoIgCyYNRiGLGwwL5j+37iMQI0/MnNYnzA8fithgr5gNTMH/QLQTGQ8HnZrl9IKKVSKVIyYSFhiZpDm8fOE9wt2ctHq3hEEyzVBKS2YDBiamQ1IklJJoZSS2ht6rNx//xu2P3jHPyKbFcdLsmEOd+tkBfIfM6kF53ck2s77BpyEhV8RVgYx/lMTuQU1IWHARriONKO7d+3Y96u3TN0nnQFkDtCZxtbnvE41f77ZGm8ERElrNSh0WPGEUxIAJmiwTDL8ooq5dw4N/N2dg4O/nLKcQ8hmgVxOtpzRdYts6Ow0XkmDHBUEwP4ppWk5FWCQEMIYbWSstbGpfeWtI1sfegGyGEWuYMIo/8/G3NbnxJq7XuObkmEyEhNjOKcspAgoaXVFy+SCFakVz795kOiVofvx+KlM5oMZ9MjB/lKju/Nnwmk8g4g6oRKSpItgudsEO28gwNAAh8XhiRlHxhszmAiBkqaAAIEFySBvlIW1HtgfGuZSuVAe2/PNvZt/dAeAceHDWZaakc8bMNN2og8vPvOl94imJf+oZOMl0k0pS9XiWYANwGqCN/1QpTMRHfJ+UygVYkEEKa2DqtvYUrAzUbABozqzMEpCg3jMRx1c6wuf3IRVMYA1atmZFiyVTKACapjltU8m3LkzdvDizzQk2t4q3fkuowJRSx+TXSlkEkgu+2z7WWf9b39X1xiqN+0IyQGWkRU0ktvS15C85xmx2EuFNlCHsaUtAUYQmoRUv634O24bGbh1rhVhCSaplCOZfVk/RpKkIIL01ZE8UxhEQCYjd+XzeaDtx0tX/9l7nMS815OTXC2cmGIhYRig0Da24CAP24R9NMGdCUKlrBAkQBAQZEmGu1UYsA7AJWgz6gmjn/DL3sMVf99tAKjqMZtWNjANYuvQ4ANbX77kad1XKzX/b8lJrSEnJqplIcsIBOzDBZSJtpkwGN9SxSJcRuEgcJ+qZaZwqZfDliNBsCBrg+UWGkHZ258KTjge08EA0JqID9vigR8SmwsJcoFUSQElFRADkwj7V1DO6hjDzOFEsMYVB04EAikQSWJBkMwga6B1qWgrB39n9NA3t99/Sx7A8FxqmtRi7oyTLIAcu80d5/TIRMsy640Gwb5hJRwaaif2XguHhDTlYVs8uOWN2Ld1P3KbJCYEqvYAdm1zc8sVqdT3OqVs2c0VOCQmK4bWOLllwLrC/f5o8XufqJU3J5MRyOXMorNe+inVvOzPjDfMipWy8MYH3Mllnf7/9a5r4uvUImLK7+qdd+r7JrXKCdR7/8S/T/15pvPW+rn2vav/95nKMeMrGwgSkisVdhOdaxZ2Pfere3O5q5DJiHy+m5mZqKXlbUtWxJ6rGjsWGmOCjjxhQjD1vAJQxh9mJ7XwFctWv/wftuXznzy+GhpBZ92/q/Dr/bsKl8zH/IbYyq7lPrWsTjS0N2k25zhCLGHhzIfjNlrDi5VyGWxTzNQEkhCBMXLomqwFrGelcPYb7VsCPa71aB/Y/0NFj94/PLTxD6Wdj+4CEOqsAMjnjvz6iDh8UNwD4J7Tul7SxbG2yy0aXkAOLRZQ8yzLdhA542MuG1QzbwiiohRq2IbOEmt9sLWQTmynJWdUGw/Gegy/TIrEXiOxx2rPSyVbNpTHiuwXh0bdhuJ9AKhQmFj+IMtppeKXyNt3t0ajE05XazV/48mK1Eb3AkBXV80HzwzkLLIQ/blfbk42LvhX0aDWwK8YLajmbEXaIUNSOo7teBpyufuOZe09Hzx86LeGvhKv2LPGbNm1NXL9TIRAsCRMEiR/bUc/D8DLZ7ol8se+LNcRbgu1dnCDX2lY72ttCFx71kaChR5Tigb3B784gmWuasxOPj+8Y2P+kwA+1Xn2i57GnMy4qdblQiaWgsUKKVWSmJshVBBvg6qfxgbtkC2UcPrYGqON9qQjH/fLIwS/siuebPzJWHFvv/b6N+5/9OfbMUkxt24W3WAoyWZpZy53G4DbFq++Yi3JpldK17kAiC+FkPMt2xYhqjH3dnwll5gghBoiEiVmH5YNG6uJhOoXMtZnWANaM7wyGfa8eLJho18pwxh/OBFv3OKPDZBXGRhZ2rKydxtAE8IcGAAGB7cODQ5ufRmAZPui5y5taVvWZmVipTFel4o3NJXYdDlOzDW+f7qjYkQsYsy2lUUgTyDoUDRK1dkkrC4R6SGG3WN9/4BF6UEF75eVytDv9mz6yfbxmgmWi4/r8sIcu7jTatn5necZVHxwM2GG1BvMlogMS38kNXagWDlw4L4/IBSXmfreyzs7k88Enj+ix4itcEasbbQzizLgbKd5227fa/ncwX0/JaDEdZ6rq1a/6pxycpHg8kHhYqYSR5xIjE+O4xzA9g0/vh+T0gqA25ZcsLhlweo2zxeMGSLZxyHNcAFU9tLODfdtOH6lnvytYMbhFR6RWrNmDQ8MVBoP+m0djrsAbsrBRD/uqDcGM7LVW97p7ujt7QWA6XLzWRbY1E1zs/abkeAeO7XsnZ1IjunVnbKxPek4QQn9MQ+eNwa4DmJsB1csNAP+Tp/6RB/v2bOn+tHDyOOfkhyVB2QOccLjSHgq1vNECJmMCOQEplV9cuXK5zSMghe4zlK47qGq8bwxjPke4B3k9rjZPja2Q+/Zs8cAqNT7osATm8esc+FkMrJGudTChRe2jtj4QrfBRbVPjI2NAp4PF0CsKbF3cXPL2M6dvyUh9nHYJebuPs3Oe5Hs7OwE0ZKEFnYR3A64TsOkOhz1fPhjo4DZNhTHpgN79tQoIzOhu1scV8/zBE6hqM9TM+tkxCnHyX5oHCkEZAnp9SKNtQCAjo7VnO/ayMh97OgC/7JZkdm0mvbv30iFjk2MfD5Y45lzsiKdhiisXWeRE8cQpMiE7LrxsSaLddi0KU8T5fQLWA90dPBhB75sdnaxFDngmMeT2X4XgLl0bzNA8igq2+BQSq+5ZfL9m5G5qQcCspROQ3R0rOZ8T2aaoTwrslkBrEMmbGtBX+ni0FNydPWUycj0/i4qhHmujuocICD70Qltax2yANavXzepvU3oE4czoIIxJrOJ0hPECwtrwzHhqMpJQNaK9Pp1YkK9ndDn83EwTo6gQwMI1tEOf+E9E4JANs6i3KvDxtc9k7BKgEC41zLiVGLGdnGU9ywHnHo7GCa05exh2vW4+/lkGGeHwkzq1n0OqF22p5IxeapwNGPzH3M9h/Ux6z4CHP/6mEWZZlwyOlEcyRgDTNlbEBERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERHxR8//Byw4d5VsYcm2AAAAAElFTkSuQmCC";

const TOUR_ANGLES = [
  { key: "av_droit", label: "3/4 Avant Droit" },
  { key: "av_gauche", label: "3/4 Avant Gauche" },
  { key: "ar_gauche", label: "3/4 Arrière Gauche" },
  { key: "ar_droit", label: "3/4 Arrière Droit" },
];

const DEFAULT_ZONES = [
  { id: "tour_complet", label: "Tour complet · 4 vues", icon: "📷" },
  { id: "carrosserie", label: "Carrosserie", icon: "◻" },
  { id: "moulures", label: "Moulures de protection", icon: "⟋" },
  { id: "retroviseurs", label: "Rétroviseurs extérieurs", icon: "↻" },
  { id: "pare_brise", label: "Pare-brises / Vitres latérales", icon: "▭" },
  { id: "optiques", label: "Optiques porteur", icon: "⚡" },
  { id: "roues", label: "Roues", icon: "○" },
  { id: "interieur", label: "État de l'intérieur", icon: "⊞" },
  { id: "nacelle", label: "État de la partie nacelle", icon: "⇕" },
  { id: "nettoyage", label: "Nettoyage", icon: "⛨" },
];

// Barème par défaut : désormais partagé avec les fonctions serveur
// (api/_tarifs-defaults.js) — voir ce fichier pour la liste des postes.

const VETUSTE = [
  {annee:1,taux:0},{annee:2,taux:0},{annee:3,taux:-20},{annee:4,taux:-25},
  {annee:5,taux:-30},{annee:6,taux:-35},{annee:7,taux:-40},{annee:8,taux:-45},
  {annee:9,taux:-50},{annee:10,taux:-55},
];

const TEST_NACELLE_ITEMS = [
  { key: "poste_haut", label: "Fonctionnement poste haut" },
  { key: "poste_bas", label: "Fonctionnement poste bas" },
  { key: "pompe_camion", label: "Pompe de camion" },
  { key: "pompe_secours", label: "Pompe de secours" },
];

const ETAT_OPTIONS = ["Bon état","Usure normale","Dégradé","Endommagé","Manquant"];
const ETAT_COLORS = {"Bon état":"#3a9a5a","Usure normale":"#9a8a2a","Dégradé":"#c07020","Endommagé":"#c03030","Manquant":"#7030b0"};
const ICONS = ["⟋","▭","⚙","○","◻","↻","⇕","⊥","⚡","⛨","🔧","🔩","⬡","◈","⌖","⎔","⊞","△","◉","⊗"];

const css = `
@import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#f0f2f5;--bg2:#ffffff;--bg3:#e8eaed;
  --border:#d0d4da;--border2:#b0b8c4;
  --primary:#1a2a6e;--accent:#c8102e;
  --text:#1a2030;--muted:#6a7488;
  --danger:#c03030;--ok:#30a050;
}
body{background:var(--bg);color:var(--text);font-family:'Rajdhani',sans-serif;}
::-webkit-scrollbar{width:4px;}::-webkit-scrollbar-thumb{background:var(--primary);}
.mono{font-family:'Share Tech Mono',monospace;}
.btn{cursor:pointer;border:none;font-family:'Rajdhani',sans-serif;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;transition:all .18s;font-size:13px;}
.btn-gold{background:var(--primary);color:#fff;padding:10px 26px;}
.btn-gold:hover{background:#2a3a8e;}
.btn-gold:disabled{opacity:.35;cursor:not-allowed;}
.btn-accent{background:var(--accent);color:#fff;padding:10px 26px;}
.btn-accent:hover{background:#e02040;}
.btn-blue{background:#0066cc;color:#fff;padding:10px 26px;}
.btn-blue:hover{background:#0052a3;}
.btn-outline{background:transparent;color:var(--primary);border:1px solid var(--border2);padding:9px 20px;}
.btn-outline:hover{border-color:var(--primary);background:rgba(26,42,110,.06);}
.btn-danger{background:var(--danger);color:#fff;padding:6px 12px;font-size:11px;}
.btn-danger:hover{background:#e04040;}
.btn-sm{padding:6px 14px;font-size:11px;}
.btn-icon{background:transparent;border:1px solid var(--border);cursor:pointer;padding:6px 10px;font-size:14px;transition:all .15s;color:var(--muted);}
.btn-icon:hover{border-color:var(--border2);color:var(--text);}
input,select,textarea{background:#fff;border:1px solid var(--border);color:var(--text);font-family:'Rajdhani',sans-serif;font-size:14px;font-weight:500;padding:9px 13px;width:100%;outline:none;transition:border .2s;}
input:focus,select:focus,textarea:focus{border-color:var(--primary);}
input::placeholder,textarea::placeholder{color:var(--muted);}
label{font-size:10px;letter-spacing:2.5px;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:5px;}
.card{background:var(--bg2);border:1px solid var(--border);padding:18px;box-shadow:0 1px 4px rgba(0,0,0,.06);}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;}
.section-title{font-size:11px;letter-spacing:4px;text-transform:uppercase;color:var(--primary);margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid var(--primary);}
.badge{font-family:'Share Tech Mono',monospace;font-size:11px;padding:3px 8px;}
.badge-ok{background:rgba(48,160,80,.12);color:#208040;border:1px solid rgba(48,160,80,.3);}
.badge-warn{background:rgba(26,42,110,.08);color:var(--primary);border:1px solid rgba(26,42,110,.2);}
.photo-thumb{width:88px;height:64px;object-fit:cover;border:1px solid var(--border2);cursor:zoom-in;}
.photo-add{width:88px;height:64px;border:2px dashed var(--border2);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted);font-size:24px;transition:all .2s;flex-shrink:0;background:#f8f9fb;}
.photo-add:hover{border-color:var(--primary);color:var(--primary);}
.zone-row{border:1px solid var(--border);margin-bottom:4px;overflow:hidden;background:#fff;}
.zone-header{display:flex;align-items:center;justify-content:space-between;padding:11px 14px;cursor:pointer;background:#f8f9fb;transition:background .15s;}
.zone-header:hover{background:#eef0f4;}
.zone-body{padding:14px;background:#fff;border-top:1px solid var(--border);}
.tarif-row{display:flex;justify-content:space-between;align-items:center;padding:9px 12px;border:1px solid var(--border);margin-bottom:3px;cursor:pointer;transition:all .15s;background:#fff;}
.tarif-row:hover{border-color:var(--border2);background:#f8f9fb;}
.tarif-row.active{border-color:var(--primary);background:rgba(26,42,110,.04);}
.total-strip{background:var(--primary);color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;}
.dossier-card{border:1px solid var(--border);padding:14px 16px;cursor:pointer;transition:all .2s;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.05);}
.dossier-card:hover{border-color:var(--primary);background:#f8f9fb;}
.etat-tag{font-size:11px;font-family:'Share Tech Mono',monospace;padding:2px 7px;border-radius:2px;}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(4px);}
.modal{background:#fff;border:1px solid var(--border2);padding:28px;min-width:340px;max-width:580px;width:90%;max-height:85vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,.15);}
.admin-row{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid var(--border);margin-bottom:4px;background:#f8f9fb;}
.icon-btn{width:36px;height:36px;display:flex;align-items:center;justify-content:center;border:1px solid var(--border);cursor:pointer;font-size:16px;transition:all .15s;}
.icon-btn:hover,.icon-btn.sel{border-color:var(--primary);background:rgba(26,42,110,.08);}
.tab{padding:8px 14px;cursor:pointer;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;border-bottom:2px solid transparent;transition:all .2s;color:var(--muted);white-space:nowrap;flex-shrink:0;}
.tab.active{color:var(--primary);border-bottom-color:var(--primary);}
.accent-bar{height:4px;background:linear-gradient(90deg,var(--primary),var(--accent));}
@keyframes spin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}
.header-bar{background:var(--primary);color:#fff;padding:0 24px;height:64px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 2px 8px rgba(0,0,0,.15);}
@media(max-width:768px){
  .header-bar{padding:0 12px;height:56px;}
  .header-bar img{height:28px!important;}
  .header-bar .header-title{font-size:11px!important;letter-spacing:1.5px!important;}
  .header-bar .header-subtitle{font-size:7px!important;letter-spacing:1px!important;}
  .header-bar .btn{font-size:10px;padding:6px 8px;}
  .header-bar > div:first-child{gap:10px!important;}
}
@keyframes aiPulse{0%,80%,100%{opacity:.2}40%{opacity:1}}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.fade-in{animation:fadeIn .3s ease;}
@media(max-width:600px){.g2,.g3{grid-template-columns:1fr;}.step-row{flex-wrap:wrap;gap:6px;}}
@media print{
  .no-print{display:none!important;}
  body{background:white!important;}
  .header-bar{background:var(--primary)!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .total-strip,.accent-bar{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
}
`;

const genId = () => Math.random().toString(36).slice(2,9).toUpperCase();
const todayISO = () => new Date().toISOString().slice(0,10);

function photoToBase64(file) {
  return new Promise((res,rej) => { const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=()=>rej(new Error("Lecture du fichier impossible")); r.readAsDataURL(file); });
}
// Référence globale pour empêcher le garbage collection de l'input file
// pendant que le sélecteur de photos est ouvert (bug iOS/Android : sans ça,
// onchange ne se déclenche parfois jamais quand on sélectionne plusieurs photos).
let _activeFileInput = null;
function pickFile(opts={}) {
  return new Promise(res => {
    const inp=document.createElement("input");
    inp.type="file"; inp.accept=opts.accept||"image/*"; inp.multiple=opts.multiple||false;
    inp.style.position="fixed"; inp.style.top="-1000px"; inp.style.left="-1000px"; inp.style.opacity="0";
    document.body.appendChild(inp);
    _activeFileInput = inp;
    const cleanup = () => { try { document.body.removeChild(inp); } catch(e){} if(_activeFileInput===inp) _activeFileInput=null; };
    inp.onchange=()=>{ const files=inp.files; cleanup(); res(files && files.length ? files : null); };
    // Annulation du sélecteur (l'événement "cancel" est supporté par les navigateurs récents)
    inp.addEventListener("cancel", ()=>{ cleanup(); res(null); });
    inp.click();
  });
}
// ─── Détection : createImageBitmap applique-t-il vraiment l'orientation EXIF ? ───
// ⚠ Sur certains navigateurs (Chrome/WebView Android selon versions), createImageBitmap
// IGNORE silencieusement l'option {imageOrientation:"from-image"} : la photo compressée
// ressort couchée (bug constaté sur le terrain le 31/07). On teste UNE FOIS avec une
// image 2×1 portant une étiquette EXIF "rotation 90°" : si le bitmap ressort en 1×2,
// l'orientation est bien appliquée ; sinon on passe par la voie <img>, qui applique
// l'EXIF nativement sur tous les navigateurs modernes.
const EXIF_TEST_IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlaKKK+dP2Y//Z";
let _bitmapExifOk = null;
async function bitmapHonorsExif() {
  if (_bitmapExifOk !== null) return _bitmapExifOk;
  try {
    const blob = await (await fetch(EXIF_TEST_IMG)).blob();
    const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
    _bitmapExifOk = (bmp.width === 1 && bmp.height === 2);
    if (bmp.close) bmp.close();
    console.log(_bitmapExifOk ? "✅ createImageBitmap applique l'EXIF" : "⚠ createImageBitmap ignore l'EXIF → voie <img>");
  } catch(e) {
    _bitmapExifOk = false;
    console.warn("createImageBitmap indisponible → voie <img>:", e);
  }
  return _bitmapExifOk;
}

async function compressBase64(base64,maxW=800,quality=0.7) {
  // ─── Redressement EXIF ───
  // Voie 1 : createImageBitmap, UNIQUEMENT si le test ci-dessus confirme que
  // l'orientation EXIF est réellement appliquée par ce navigateur.
  try {
    if (await bitmapHonorsExif()) {
      const blob = await (await fetch(base64)).blob();
      const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
      const c=document.createElement("canvas");
      const r=Math.min(maxW/bmp.width,maxW/bmp.height,1);
      c.width=Math.round(bmp.width*r); c.height=Math.round(bmp.height*r);
      c.getContext("2d").drawImage(bmp,0,0,c.width,c.height);
      if (bmp.close) bmp.close();
      return c.toDataURL("image/jpeg",quality);
    }
  } catch(e) {
    console.warn("createImageBitmap en échec, bascule sur la voie <img>:", e);
  }
  // Voie classique (navigateurs anciens) — les navigateurs récents appliquent
  // aussi l'orientation EXIF lors du drawImage depuis un élément <img>.
  return new Promise(res => {
    try {
      const img=new Image();
      img.onload=()=>{
        try {
          const c=document.createElement("canvas");
          const r=Math.min(maxW/img.width,maxW/img.height,1);
          c.width=img.width*r; c.height=img.height*r;
          c.getContext("2d").drawImage(img,0,0,c.width,c.height);
          res(c.toDataURL("image/jpeg",quality));
        } catch(e) {
          console.error("Compression échouée, image originale conservée:", e);
          res(base64); // fallback : on garde l'originale plutôt que de bloquer
        }
      };
      // CRUCIAL : sans onerror, une image non décodable (HEIC, fichier corrompu...)
      // laissait la promesse en attente pour toujours → file d'upload gelée,
      // bandeau "envoi en cours" permanent et ajout de photos bloqué partout.
      img.onerror=()=>{
        console.error("Image non décodable par le navigateur");
        res(null);
      };
      img.src=base64;
    } catch(e) { console.error("compressBase64:", e); res(null); }
  });
}
// Garde-fou : rejette si une étape d'upload dépasse le délai (réseau coupé, requête gelée...)
function withTimeout(promise, ms, label="opération") {
  return Promise.race([
    promise,
    new Promise((_,rej)=>setTimeout(()=>rej(new Error(`Délai dépassé (${label})`)), ms))
  ]);
}
async function removeBackground(base64) {
  try {
    const res = await fetch(base64);
    const blob = await res.blob();
    const form = new FormData();
    form.append("image_file", blob);
    // Pro+ : haute résolution 4K + détection véhicule + ombre portée
    form.append("size", "4k");          // qualité 4K (consomme plus de crédits que "auto")
    form.append("type", "car");         // détection orientée véhicule (nacelle/PEMP)
    form.append("shadow_type", "drop"); // ombre portée (options: drop, car, 3D, none)
    form.append("shadow_opacity", "55");
    const resp = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": REMOVE_BG_KEY },
      body: form
    });
    if (!resp.ok) throw new Error("Remove.bg erreur " + resp.status);
    const outBlob = await resp.blob();
    return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(outBlob); });
  } catch(e) { console.error("Remove.bg:", e); return null; }
}

// Variante Pro+ qui détoure depuis une URL déjà stockée. remove.bg va chercher l'image
// côté serveur (image_url) => aucune lecture cross-origin dans le navigateur, donc pas de CORS.
async function removeBackgroundFromUrl(imageUrl) {
  try {
    const form = new FormData();
    form.append("image_url", imageUrl);
    form.append("size", "4k");
    form.append("type", "car");
    form.append("shadow_type", "drop");
    form.append("shadow_opacity", "55");
    const resp = await fetch("https://api.remove.bg/v1.0/removebg", {
      method: "POST",
      headers: { "X-Api-Key": REMOVE_BG_KEY },
      body: form
    });
    if (!resp.ok) throw new Error("Remove.bg erreur " + resp.status);
    const outBlob = await resp.blob();
    return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(outBlob); });
  } catch(e) { console.error("Remove.bg (url):", e); return null; }
}

async function composeCommercialPhoto(subjectBase64, immat, logoB64) {
  return new Promise(res => {
    const W = 1080, H = 1080;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    const barH = 120;

    // Fond extérieur dégradé (ciel -> sol) au lieu du gris plat
    const horizon = Math.round((H - barH) * 0.62);
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, "#cfe0f2");
    sky.addColorStop(1, "#eef4fb");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, horizon);
    const ground = ctx.createLinearGradient(0, horizon, 0, H - barH);
    ground.addColorStop(0, "#e7e9ec");
    ground.addColorStop(1, "#cfd3d8");
    ctx.fillStyle = ground;
    ctx.fillRect(0, horizon, W, (H - barH) - horizon);

    // Bande bleue Delta en bas
    ctx.fillStyle = "#1a2a6e";
    ctx.fillRect(0, H - barH, W, barH);
    ctx.fillStyle = "#c8102e";
    ctx.fillRect(0, H - barH - 5, W, 5);

    const subject = new Image();
    subject.onload = () => {
      // Analyser pixels pour trouver le contenu réel (bounding box)
      const tmpC = document.createElement("canvas");
      tmpC.width = subject.naturalWidth;
      tmpC.height = subject.naturalHeight;
      const tmpCtx = tmpC.getContext("2d");
      tmpCtx.drawImage(subject, 0, 0);
      const pixels = tmpCtx.getImageData(0, 0, tmpC.width, tmpC.height).data;

      let minX = tmpC.width, maxX = 0, minY = tmpC.height, maxY = 0;
      for (let y = 0; y < tmpC.height; y++) {
        for (let x = 0; x < tmpC.width; x++) {
          const a = pixels[(y * tmpC.width + x) * 4 + 3];
          if (a > 20) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      const contentW = maxX - minX + 1;
      const contentH = maxY - minY + 1;

      // Zone disponible avec marge minimale de 16px
      const avail = H - barH - 5;
      const margin = 4;
      const maxW = W - margin * 2;
      const maxH = avail - margin * 2;
      const scale = Math.min(maxW / contentW, maxH / contentH);
      const sw = contentW * scale;
      const sh = contentH * scale;
      const sx = (W - sw) / 2;
      const sy = margin + (avail - margin * 2 - sh) / 2;

      // Dessiner uniquement le contenu recadré
      ctx.drawImage(subject,
        minX, minY, contentW, contentH,
        sx, sy, sw, sh
      );

      // Logo Delta blanc
      const logo = new Image();
      logo.onload = () => {
        const logoH = 62, logoW = (logo.naturalWidth / logo.naturalHeight) * logoH;
        const tmpLogo = document.createElement("canvas");
        tmpLogo.width = logoW; tmpLogo.height = logoH;
        const lCtx = tmpLogo.getContext("2d");
        lCtx.filter = "brightness(0) invert(1)";
        lCtx.drawImage(logo, 0, 0, logoW, logoH);
        ctx.drawImage(tmpLogo, 36, H - barH + (barH - logoH) / 2, logoW, logoH);

        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(logoW + 60, H - barH + 18);
        ctx.lineTo(logoW + 60, H - 18);
        ctx.stroke();

        if (immat) {
          ctx.fillStyle = "#ffffff";
          ctx.font = "700 32px monospace";
          ctx.textAlign = "right";
          ctx.fillText(immat, W - 36, H - barH + barH / 2 + 11);
        }

        res(canvas.toDataURL("image/jpeg", 0.96));
      };
      logo.onerror = () => res(canvas.toDataURL("image/jpeg", 0.95));
      logo.src = DELTA_LOGO;
    };
    subject.onerror = () => res(null);
    subject.src = subjectBase64;
  });
}

async function compressPhotos(photos) {
  if(!photos) return photos;
  const result={};
  for(const key of Object.keys(photos)) { const arr=photos[key]; if(!Array.isArray(arr)) continue; result[key]=await Promise.all(arr.map(async p=>({...p,url:p.url?.startsWith("data:")?await compressBase64(p.url):p.url}))); }
  return result;
}
async function fbSaveDossier(data) {
  try { const c={...data}; if(c.depart?.photos) c.depart={...c.depart,photos:await compressPhotos(c.depart.photos)}; if(c.retour?.photos) c.retour={...c.retour,photos:await compressPhotos(c.retour.photos)}; await setDoc(doc(db,"dossiers",c.immat),c); }
  catch(e) { console.error(e); alert("Erreur de sauvegarde : "+e.message); }
}
async function fbSaveConfig(id,data) { await setDoc(doc(db,"config",id),data); }
async function fbGetConfig(id) { const snap=await getDocs(collection(db,"config")); const found=snap.docs.find(d=>d.id===id); return found?found.data():null; }

async function generateDepartHTML(dossier) {
  const info = dossier.info;
  const dep = dossier.depart;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
    <div style="background:#1a2a6e;padding:28px 32px;">
      <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:2px;">ÉTAT DE DÉPART</div>
      <div style="color:rgba(255,255,255,.7);font-size:12px;margin-top:4px;">Delta Services · Constat de départ en location</div>
    </div>
    <div style="height:4px;background:linear-gradient(90deg,#1a2a6e,#c8102e);"></div>
    <div style="padding:32px;">
      <p style="color:#1a2a6e;font-size:16px;font-weight:700;margin:0 0 20px;">Bonjour,</p>
      <p style="color:#444;font-size:14px;line-height:1.6;margin:0 0 24px;">
        Veuillez trouver ci-dessous le constat d'état de votre nacelle élévatrice au départ en location.
      </p>
      <div style="background:#f8f9fb;border:1px solid #e0e4ea;border-radius:6px;padding:20px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Immatriculation</td><td style="padding:6px 0;font-weight:700;color:#1a2a6e;">${dossier.immat}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Modèle porteur</td><td style="padding:6px 0;font-weight:600;">${info?.modele||'—'}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Type nacelle</td><td style="padding:6px 0;font-weight:600;">${info?.type_nacelle||'—'}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Client</td><td style="padding:6px 0;font-weight:600;">${info?.client||'—'}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Date départ</td><td style="padding:6px 0;font-weight:600;">${dep?.date||'—'}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Heures nacelle</td><td style="padding:6px 0;font-weight:600;">${dep?.heures||'—'} h</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Km porteur</td><td style="padding:6px 0;font-weight:600;">${dep?.km_porteur||'—'} km</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Agent expert</td><td style="padding:6px 0;font-weight:600;">${dep?.agent||'—'}</td></tr>
        </table>
      </div>
      <p style="color:#888;font-size:12px;line-height:1.6;margin:0;">
        Ce document atteste de l'état du véhicule au moment de son départ en location.<br>
        Pour toute question : <a href="mailto:assistanat.commerce@delta-services.fr" style="color:#1a2a6e;">assistanat.commerce@delta-services.fr</a>
      </p>
    </div>
    <div style="background:#f8f9fb;border-top:1px solid #e0e4ea;padding:16px 32px;font-size:11px;color:#888;text-align:center;">
      DELTA SERVICES · 14 Avenue James de Rothschild · 77164 Ferrières-en-Brie · Tél. +33 (0)1 60 95 47 80<br>
      © ${new Date().getFullYear()} Delta Services · Tous droits réservés
    </div>
  </div>
</body></html>`;
}

async function generateReportHTML(dossier, tarifs, zones, vetusteTaux) {
  const ret = dossier.retour;
  const info = dossier.info;
  const mdReport = ret?.montants_devis || {};
  const tdReport = ret?.tranches_devis || {};
  const total = (ret?.degats||[]).reduce((s,id)=>{const t=tarifs.find(t=>t.id===id);return s+montantPoste(t,ret?.quantites?.[id]||1,vetusteTaux,mdReport);},0);
  const degatsHTML = (ret?.degats||[]).map(id=>{
    const t=tarifs.find(t=>t.id===id);
    if(!t) return '';
    const prix = t.surDevis
      ? (mdReport[id] ? Number(mdReport[id]).toLocaleString('fr-FR')+'&nbsp;€' : 'Sur devis')
      : Math.round(t.prix*(1+vetusteTaux/100))+'&nbsp;€';
    const tranche = tdReport[id] ? ` <span style="color:#889;font-size:11px;">(${tdReport[id]})</span>` : '';
    return `<tr><td style="padding:8px 12px;border-bottom:1px solid #e0e4ea;">${t.label}${tranche}</td><td style="padding:8px 12px;border-bottom:1px solid #e0e4ea;text-align:right;font-weight:700;color:#1a2a6e;">${prix}</td></tr>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">
    <div style="background:#1a2a6e;padding:28px 32px;display:flex;align-items:center;">
      <div>
        <div style="color:#fff;font-size:20px;font-weight:700;letter-spacing:2px;">EXPERTISE NACELLE</div>
        <div style="color:rgba(255,255,255,.7);font-size:12px;margin-top:4px;">Delta Services · Rapport de restitution</div>
      </div>
    </div>
    <div style="height:4px;background:linear-gradient(90deg,#1a2a6e,#c8102e);"></div>
    <div style="padding:32px;">
      <p style="color:#1a2a6e;font-size:16px;font-weight:700;margin:0 0 20px;">Bonjour,</p>
      <p style="color:#444;font-size:14px;line-height:1.6;margin:0 0 24px;">
        Veuillez trouver ci-joint le rapport d'expertise de restitution de votre nacelle élévatrice.
      </p>
      <div style="background:#f8f9fb;border:1px solid #e0e4ea;border-radius:6px;padding:20px;margin-bottom:24px;">
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Immatriculation</td><td style="padding:6px 0;font-weight:700;color:#1a2a6e;">${dossier.immat}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Modèle porteur</td><td style="padding:6px 0;font-weight:600;">${info?.modele||'—'}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Client</td><td style="padding:6px 0;font-weight:600;">${info?.client||'—'}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Date retour</td><td style="padding:6px 0;font-weight:600;">${ret?.date||'—'}</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Heures nacelle</td><td style="padding:6px 0;font-weight:600;">${ret?.heures||'—'} h</td></tr>
          <tr><td style="padding:6px 0;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;">Km porteur</td><td style="padding:6px 0;font-weight:600;">${ret?.km_porteur||'—'} km</td></tr>
        </table>
      </div>
      ${degatsHTML ? `
      <p style="color:#1a2a6e;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;margin:0 0 12px;">Dégâts constatés</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        ${degatsHTML}
      </table>
      <div style="background:#1a2a6e;color:#fff;padding:14px 20px;border-radius:6px;display:flex;justify-content:space-between;margin-bottom:24px;">
        <span style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;">TOTAL RETENUE HT</span>
        <span style="font-size:22px;font-weight:700;">${total.toLocaleString('fr-FR')} €</span>
      </div>` : `
      <div style="background:#eaf3de;border:1px solid rgba(48,160,80,.3);border-radius:6px;padding:14px 20px;color:#208040;font-weight:600;margin-bottom:24px;">
        ✓ Aucun dégât constaté — nacelle rendue conforme
      </div>`}
      <p style="color:#888;font-size:12px;line-height:1.6;margin:0;">
        Ce rapport a été établi par l'expert Delta Services lors de la restitution du véhicule.<br>
        Pour toute question, contactez-nous à <a href="mailto:assistanat.commerce@delta-services.fr" style="color:#1a2a6e;">assistanat.commerce@delta-services.fr</a>
      </p>
    </div>
    <div style="background:#f8f9fb;border-top:1px solid #e0e4ea;padding:16px 32px;font-size:11px;color:#888;text-align:center;">
      DELTA SERVICES · 14 Avenue James de Rothschild · 77164 Ferrières-en-Brie · Tél. +33 (0)1 60 95 47 80<br>
      © ${new Date().getFullYear()} Delta Services · Tous droits réservés
    </div>
  </div>
</body></html>`;
}

function getVetuste(annee_fab) {
  if(!annee_fab) return 0;
  // Supporte JJ/MM/AAAA ou AAAA
  let annee = annee_fab;
  if(String(annee_fab).includes('/')) {
    const parts = String(annee_fab).split('/');
    annee = parts[parts.length - 1]; // prend la dernière partie = année
  }
  const age=new Date().getFullYear()-parseInt(annee);
  if(age<=0) return 0;
  const v=VETUSTE.find(v=>v.annee===Math.min(age,10));
  return v?v.taux:(age>=10?-55:0);
}
function prixAvecVetuste(prix,taux) { return prix?Math.round(prix*(1+taux/100)):0; }
// Montant retenu pour un poste de dégât :
// - poste tarifé : prix catalogue avec vétusté × quantité
// - poste "sur devis" : montant saisi EN DIRECT par l'expert (tel quel, sans
//   vétusté — c'est le montant réel constaté), ou 0 si laissé "sur devis"
function montantPoste(t, qte, taux, montantsDevis) {
  if (!t) return 0;
  if (t.surDevis) return Number(montantsDevis?.[t.id]) || 0;
  if (!t.prix) return 0;
  return prixAvecVetuste(t.prix, taux) * (qte || 1);
}

// Résumé lecture seule des tests (affiché dans les récapitulatifs / rapports)
function TestNacelleSummary({ tests }) {
  const t = tests || {};
  const hasAny = TEST_NACELLE_ITEMS.some(it => t[it.key]);
  if(!hasAny && !t.commentaire) return null;
  return (
    <div className="card" style={{marginBottom:10}}>
      <div style={{fontSize:11,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",fontWeight:700,marginBottom:10}}>Test nacelle</div>
      <div className="g2">
        {TEST_NACELLE_ITEMS.map(it=>{
          const v=t[it.key];
          const color=v==="OK"?"var(--ok)":v==="KO"?"var(--danger)":"var(--muted)";
          return (
            <div key={it.key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0"}}>
              <span style={{fontSize:13}}>{it.label}</span>
              <span className="etat-tag" style={{background:color+"22",color,border:`1px solid ${color}44`,fontWeight:700}}>{v||"—"}</span>
            </div>
          );
        })}
      </div>
      {t.commentaire&&<div style={{marginTop:8,fontSize:12,color:"var(--danger)"}}><strong>Commentaire :</strong> {t.commentaire}</div>}
    </div>
  );
}

// Composant réutilisable : section "Test nacelle" (départ et retour)
function TestNacelle({ tests, onChange }) {
  const t = tests || {};
  const set = (k, v) => onChange({ ...t, [k]: v });
  const anyKO = TEST_NACELLE_ITEMS.some(it => t[it.key] === "KO");
  return (
    <div className="card" style={{marginBottom:14,border:"1px solid var(--border)"}}>
      <div className="section-title" style={{marginBottom:12}}>Test nacelle</div>
      {TEST_NACELLE_ITEMS.map(it => (
        <div key={it.key} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:"1px solid var(--border)"}}>
          <span style={{fontWeight:600,fontSize:14}}>{it.label}</span>
          <div style={{display:"flex",gap:6}}>
            <button type="button" className="btn btn-sm" style={{background:t[it.key]==="OK"?"var(--ok)":"var(--bg3)",color:t[it.key]==="OK"?"#fff":"var(--muted)",padding:"6px 16px"}} onClick={()=>set(it.key, t[it.key]==="OK"?"":"OK")}>OK</button>
            <button type="button" className="btn btn-sm" style={{background:t[it.key]==="KO"?"var(--danger)":"var(--bg3)",color:t[it.key]==="KO"?"#fff":"var(--muted)",padding:"6px 16px"}} onClick={()=>set(it.key, t[it.key]==="KO"?"":"KO")}>KO</button>
          </div>
        </div>
      ))}
      {anyKO && (
        <div style={{marginTop:12}}>
          <label>Commentaire (un test est KO)</label>
          <textarea rows={2} value={t.commentaire||""} onChange={e=>set("commentaire",e.target.value)} placeholder="Décrivez le dysfonctionnement..." style={{resize:"vertical"}}/>
        </div>
      )}
    </div>
  );
}

// Génère le bloc HTML des tests nacelle pour les rapports
function testNacelleHTML(tests) {
  if(!tests) return "";
  const rows = TEST_NACELLE_ITEMS.map(it=>{
    const v = tests[it.key];
    const color = v==="OK" ? "#208040" : v==="KO" ? "#c03030" : "#888";
    const txt = v || "—";
    return `<tr><td style="padding:6px 0;color:#444;font-size:13px;">${it.label}</td><td style="padding:6px 0;text-align:right;font-weight:700;color:${color};">${txt}</td></tr>`;
  }).join("");
  const comment = tests.commentaire ? `<div style="margin-top:8px;font-size:12px;color:#c03030;"><strong>Commentaire :</strong> ${tests.commentaire}</div>` : "";
  return `<p style="color:#1a2a6e;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;margin:18px 0 8px;">Test nacelle</p>
    <table style="width:100%;border-collapse:collapse;">${rows}</table>${comment}`;
}


// ─── Cadre de signature tactile (client) — dessin au doigt ou à la souris ───
function SignaturePad({ value, onChange }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  const hasInk = useRef(false);
  useEffect(()=>{
    const c = canvasRef.current; if(!c) return;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0,0,c.width,c.height);
    ctx.strokeStyle = "#1a2a6e"; ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round";
    // Reprise d'un brouillon : repeint la signature déjà tracée
    if(value){ const img=new Image(); img.onload=()=>{ ctx.drawImage(img,0,0,c.width,c.height); hasInk.current=true; }; img.src=value; }
  },[]);
  function pos(e){ const c=canvasRef.current; const r=c.getBoundingClientRect(); const p=e.touches?e.touches[0]:e; return { x:(p.clientX-r.left)*(c.width/r.width), y:(p.clientY-r.top)*(c.height/r.height) }; }
  function start(e){ drawing.current=true; const {x,y}=pos(e); const ctx=canvasRef.current.getContext("2d"); ctx.beginPath(); ctx.moveTo(x,y); }
  function move(e){ if(!drawing.current) return; const {x,y}=pos(e); const ctx=canvasRef.current.getContext("2d"); ctx.lineTo(x,y); ctx.stroke(); hasInk.current=true; }
  function end(){ if(!drawing.current) return; drawing.current=false; if(hasInk.current&&onChange) onChange(canvasRef.current.toDataURL("image/png")); }
  function clear(){ const c=canvasRef.current; const ctx=c.getContext("2d"); ctx.fillStyle="#fff"; ctx.fillRect(0,0,c.width,c.height); ctx.strokeStyle="#1a2a6e"; ctx.lineWidth=2.2; hasInk.current=false; if(onChange) onChange(null); }
  return (
    <div>
      <canvas ref={canvasRef} width={560} height={200}
        onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
        onTouchStart={start} onTouchMove={move} onTouchEnd={end}
        style={{width:"100%",maxWidth:560,height:200,border:"2px dashed var(--border2)",background:"#fff",touchAction:"none",cursor:"crosshair",display:"block"}}/>
      <div style={{marginTop:6}}>
        <button type="button" className="btn btn-outline btn-sm" onClick={clear}>✕ Effacer / recommencer</button>
      </div>
    </div>
  );
}

export default function App() {
  const [view,setView]=useState("home");
  const [uploadingCount, setUploadingCount] = useState(0);
  const [savingRetour, setSavingRetour] = useState(false);
  const [dossiers,setDossiers]=useState({});
  // ─── Pagination des dossiers (perf : on ne charge plus tout l'historique) ───
  const [dossiersCursor,setDossiersCursor]=useState(null);   // dernier doc de la page chargée
  const [hasMoreDossiers,setHasMoreDossiers]=useState(false);
  const [loadingMore,setLoadingMore]=useState(false);
  const [zones,setZones]=useState(DEFAULT_ZONES);
  const [tarifs,setTarifs]=useState(DEFAULT_TARIFS);
  const [typesNacelle,setTypesNacelle]=useState(DEFAULT_TYPES_NACELLE);
  const [typeNacForm,setTypeNacForm]=useState(""); // saisie admin d'un nouveau type
  const [loading,setLoading]=useState(true);
  const [searchQ,setSearchQ]=useState("");
  const [filterStatut,setFilterStatut]=useState("tous"); // tous | location | retour | sans_depart
  const [showStats,setShowStats]=useState(false);
  const [activeDossier,setActiveDossier]=useState(null);
  const [regenAngle,setRegenAngle]=useState(null);    // angle commercial en cours de régénération
  const [regenPreview,setRegenPreview]=useState({});  // { [angleKey]: base64 } aperçu avant remplacement
  const [venteBusy,setVenteBusy]=useState(null);      // slot photo de ventes en cours de traitement
  const [adminOpen,setAdminOpen]=useState(false);
  const [adminAuthed,setAdminAuthed]=useState(false);
  const [adminPwd,setAdminPwd]=useState("");
  const [adminPwdErr,setAdminPwdErr]=useState(false);
  const [adminTab,setAdminTab]=useState("zones");
  const [adminMsg,setAdminMsg]=useState("");
  const [zoneForm,setZoneForm]=useState({label:"",icon:"⟋"});
  const [zoneEdit,setZoneEdit]=useState(null);
  const [tarifForm,setTarifForm]=useState({zone:"",label:"",prix:"",surDevis:false,bareme:[]});
  // Admin → Emails : destinataires des envois automatiques (une adresse par ligne)
  const [emailsCfg,setEmailsCfg]=useState({retour_to:"",devis_to:"",cc_assistanat:"",compta_to:""});
  const [emailsCfgLoaded,setEmailsCfgLoaded]=useState(false);
  const [tarifEdit,setTarifEdit]=useState(null);

  const [depForm,setDepForm]=useState({immat:"",numero_cube:"",type_nacelle:"",modele:"",annee_fab:"",client:"",contrat:"",email:"",date:todayISO(),heures:"",km_porteur:"",agent:""});
  const [depTests,setDepTests]=useState({});
  const [depZones,setDepZones]=useState({});
  const [depPhotos,setDepPhotos]=useState({});
  const [depStep,setDepStep]=useState(0);
  const [openZone,setOpenZone]=useState(null);
  const [depEmailSending,setDepEmailSending]=useState(false);
  const [draftAvailable,setDraftAvailable]=useState(null); // {type:"depart"|"retour", data:{...}}

  // ═══════════════════════════════════════════════════════════
  // SYSTÈME DE BROUILLON — Sauvegarde automatique en continu
  // ═══════════════════════════════════════════════════════════
  function saveDraft(type, data) {
    const key = `nacelle_draft_${type}`;
    const stamp = () => new Date().toISOString();
    // Niveau 1 : brouillon complet
    try {
      localStorage.setItem(key, JSON.stringify({...data, savedAt: stamp()}));
      console.log(`💾 Brouillon ${type} sauvegardé`);
      return;
    } catch(e) { /* quota dépassé → niveau 2 */ }
    // Niveau 2 : on retire UNIQUEMENT le dossier départ embarqué (anciennes photos base64
    // très lourdes sur les dossiers pré-migration) — les photos d'expertise sont de simples
    // URLs Storage, légères : on les CONSERVE. À la reprise, le dossier départ complet est
    // rechargé depuis la mémoire (state "dossiers") à partir de l'immat.
    try {
      const mid = {...data};
      if(mid.foundDossier) mid.foundDossier = { immat: mid.foundDossier.immat };
      localStorage.setItem(key, JSON.stringify({...mid, savedAt: stamp()}));
      console.log(`💾 Brouillon ${type} sauvegardé (dossier départ allégé, photos conservées)`);
      return;
    } catch(e) { /* toujours trop gros → niveau 3 */ }
    // Niveau 3 (dernier recours) : sans les photos ni la signature
    try {
      const light = {...data};
      if(light.depPhotos) light.depPhotos = {};
      if(light.retPhotos) light.retPhotos = {};
      if(light.depSignature) light.depSignature = null;
      if(light.foundDossier) light.foundDossier = { immat: light.foundDossier.immat };
      localStorage.setItem(key, JSON.stringify({...light, savedAt: stamp(), photosLost: true}));
      console.log(`💾 Brouillon ${type} sauvegardé (sans photos)`);
    } catch(e2) { console.error("Impossible de sauvegarder le brouillon:", e2); }
  }
  function loadDraft(type) {
    try {
      const raw = localStorage.getItem(`nacelle_draft_${type}`);
      if(raw) return JSON.parse(raw);
    } catch(e) { console.error("Erreur lecture brouillon:", e); }
    return null;
  }
  function clearDraft(type) {
    try {
      localStorage.removeItem(`nacelle_draft_${type}`);
      console.log(`🗑 Brouillon ${type} supprimé`);
    } catch(e) {}
    setDraftAvailable(null);
  }
  function clearAllDrafts() { clearDraft("depart"); clearDraft("retour"); setDraftAvailable(null); }

  function resumeDraft(draft) {
    if(draft.type==="depart") {
      setDepForm(draft.data.depForm || {immat:"",numero_cube:"",type_nacelle:"",modele:"",annee_fab:"",client:"",contrat:"",email:"",date:todayISO(),heures:"",km_porteur:"",agent:""});
      setDepZones(draft.data.depZones || {});
      setDepTests(draft.data.depTests || {});
      setDepPhotos(draft.data.depPhotos || {});
      setDepStep(draft.data.depStep || 1);
      setDepSignature(draft.data.depSignature || null);
      setView("depart");
    } else if(draft.type==="retour") {
      setRetForm(draft.data.retForm || {date:todayISO(),heures:"",km_porteur:"",agent:"",immat:"",numero_cube:"",type_nacelle:"",modele:"",annee_fab:"",client:"",contrat:"",email:""});
      setRetZones(draft.data.retZones || {});
      setRetTests(draft.data.retTests || {});
      setRetPhotos(draft.data.retPhotos || {});
      setRetDegats(draft.data.retDegats || []);
      setRetMontantsDevis(draft.data.retMontantsDevis || {});
      setRetTranchesDevis(draft.data.retTranchesDevis || {});
      setRetQtes(draft.data.retQtes || {});
      setRetNote(draft.data.retNote || "");
      setRetStep(draft.data.retStep || 1);
      // Recharge le dossier complet depuis la mémoire (évite un brouillon tronqué + données à jour)
      const fdImmat = draft.data.foundDossier?.immat;
      setFoundDossier((fdImmat && dossiers[fdImmat]) || draft.data.foundDossier || null);
      setSearchImmat(draft.data.searchImmat || "");
      setEmailClient(draft.data.emailClient || "");
      setView("retour");
    }
    setDraftAvailable(null);
  }
  const [depEmailSent,setDepEmailSent]=useState(false);

  const [retForm,setRetForm]=useState({date:todayISO(),heures:"",km_porteur:"",agent:"",immat:"",numero_cube:"",type_nacelle:"",modele:"",annee_fab:"",client:"",contrat:"",email:""});
  const [retTests,setRetTests]=useState({});
  const [retZones,setRetZones]=useState({});
  const [retPhotos,setRetPhotos]=useState({});
  const [retDegats,setRetDegats]=useState([]);
  // Montants saisis en direct pour les postes "sur devis" : { tarifId: montant € HT }
  const [retMontantsDevis,setRetMontantsDevis]=useState({});
  // Tranche de barème choisie pour les postes "sur devis" : { tarifId: libellé }
  // ("__LIBRE__" = montant saisi manuellement hors barème)
  const [retTranchesDevis,setRetTranchesDevis]=useState({});
  const [retQtes,setRetQtes]=useState({}); // { tarifId: quantité } — 1 par défaut
  const [triPhoto,setTriPhoto]=useState(null);   // index de la photo "à trier" en cours d'affectation
  const [triFilter,setTriFilter]=useState("");   // recherche dans la liste d'affectation
  const [showInfoEdit,setShowInfoEdit]=useState(false); // panneau de correction des infos du dossier (immat, km...)
  const [retNote,setRetNote]=useState("");
  const [emailClient,setEmailClient]=useState("");
  const [emailSending,setEmailSending]=useState(false);
  const [emailSent,setEmailSent]=useState(false);

  // Auth states
  const [currentUser,setCurrentUser]=useState(null);
  const [userProfile,setUserProfile]=useState(null);
  const [accessPending,setAccessPending]=useState(false); // demande d'accès envoyée, en attente de validation
  const [authLoading,setAuthLoading]=useState(true);
  const [users,setUsers]=useState([]);
  const [showUserManagement,setShowUserManagement]=useState(false);
  const [userForm,setUserForm]=useState({email:"",nom:"",prenom:"",role:"expert"});
  const [pendingRole,setPendingRole]=useState({}); // rôle choisi pour chaque demande d'accès (uid → rôle)
  // 🏆 Super admin : identifié par le compte connecté (rôle « superadmin »).
  // Amorçage : jlaroche@klubb.com est toujours super admin (anti-verrouillage).
  const isSuperAdmin = userProfile?.role==="superadmin" || (currentUser?.email||"").toLowerCase()==="jlaroche@klubb.com";
  const [editingUser,setEditingUser]=useState(null);
  const [retStep,setRetStep]=useState(0);
  const [searchImmat,setSearchImmat]=useState("");
  const [foundDossier,setFoundDossier]=useState(null);
  const [searchDone,setSearchDone]=useState(false);
  const [venteImmat,setVenteImmat]=useState("");         // onglet Photos de ventes — immat recherchée
  const [venteSearchDone,setVenteSearchDone]=useState(false);
  // Photos de ventes "libres" (sans dossier d'expertise) — collection Firestore photos_ventes/{IMMAT}
  const [ventePhotosLibres,setVentePhotosLibres]=useState({});
  const [lightboxUrl,setLightboxUrl]=useState(null);     // photo affichée en grand (clic pour agrandir)
  const [rotatingKey,setRotatingKey]=useState(null);     // vignette en cours de rotation manuelle
  const [depTriPhoto,setDepTriPhoto]=useState(null);     // photo du bac départ en cours d'affectation
  const [depTriFilter,setDepTriFilter]=useState("");
  const [depSignature,setDepSignature]=useState(null);   // signature client (dataURL) — état de départ

  // Fermeture de la lightbox avec la touche Échap
  useEffect(()=>{
    if(!lightboxUrl) return;
    const onKey=(e)=>{ if(e.key==="Escape") setLightboxUrl(null); };
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  },[lightboxUrl]);

  // ═══════════════════════════════════════════════════════════
  // NAVIGATION ARRIÈRE (History API) — le bouton retour du
  // navigateur recule étape par étape (3→2→1→accueil) au lieu
  // de quitter l'application.
  // ═══════════════════════════════════════════════════════════
  const navFromPop = useRef(false);
  useEffect(()=>{
    // Au montage : marque l'entrée d'historique courante comme "accueil"
    window.history.replaceState({nav:true,view:"home",depStep:0,retStep:0}, "");
  },[]);
  useEffect(()=>{
    // À chaque avancée (vue ou étape), on empile une entrée d'historique
    if(navFromPop.current){ navFromPop.current=false; return; }
    const cur = window.history.state;
    if(cur?.nav && cur.view===view && cur.depStep===depStep && cur.retStep===retStep) return;
    window.history.pushState({nav:true,view,depStep,retStep}, "");
  },[view,depStep,retStep]);
  useEffect(()=>{
    // Retour navigateur : on restaure l'écran/étape précédent(e)
    const onPop = (e)=>{
      const s = (e.state && e.state.nav) ? e.state : {view:"home",depStep:0,retStep:0};
      navFromPop.current = true;
      setView(s.view||"home");
      setDepStep(s.depStep||0);
      setRetStep(s.retStep||0);
    };
    window.addEventListener("popstate", onPop);
    return ()=>window.removeEventListener("popstate", onPop);
  },[]);

  useEffect(()=>{ loadAll(); },[]);

  // Recherche accueil : si l'utilisateur tape une immatriculation complète qui
  // n'est pas dans les pages chargées, on va la chercher directement sur le serveur.
  useEffect(()=>{
    const im = normalizeImmat((searchQ||"").trim());
    if (/^[A-Z]{2}-[0-9]{3}-[A-Z]{2}$/.test(im) && !dossiers[im]) { fetchDossier(im); }
  },[searchQ]);
  
  // Avertir si fermeture de page pendant un upload de photo
  useEffect(()=>{
    if(uploadingCount === 0) return;
    const handler = (e) => { e.preventDefault(); e.returnValue = ""; return ""; };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  },[uploadingCount]);

  // Auto-save DÉPART (brouillon)
  useEffect(()=>{
    if(view==="depart" && depStep > 0) {
      saveDraft("depart", { depForm, depZones, depTests, depPhotos, depStep, depSignature });
    }
  },[view, depForm, depZones, depTests, depPhotos, depStep, depSignature]);

  // Auto-save RETOUR (brouillon)
  useEffect(()=>{
    if(view==="retour" && retStep >= 1) {
      saveDraft("retour", { retForm, retZones, retTests, retPhotos, retDegats, retQtes, retMontantsDevis, retTranchesDevis, retNote, retStep, foundDossier, searchImmat, emailClient });
    }
  },[view, retForm, retZones, retTests, retPhotos, retDegats, retQtes, retMontantsDevis, retTranchesDevis, retNote, retStep, foundDossier, emailClient]);

  // Reprise retour : ré-injecte le dossier départ complet depuis la mémoire
  // (la liste "dossiers" se charge en asynchrone, et un brouillon tronqué ne contient que l'immat).
  // Évite l'écran vide à la reprise ET protège les données de départ lors de la validation.
  useEffect(()=>{
    if(view!=="retour" || retStep < 1) return;
    const immat = foundDossier?.immat || retForm.immat || searchImmat;
    if(!immat) return;
    const full = dossiers[immat];
    if(full && (!foundDossier || !foundDossier.info)) {
      setFoundDossier(full);
    }
  },[view, retStep, dossiers, foundDossier, retForm.immat, searchImmat]);

  // Détection brouillon au démarrage
  useEffect(()=>{
    const depDraft = loadDraft("depart");
    const retDraft = loadDraft("retour");
    if(retDraft) setDraftAvailable({type:"retour", data:retDraft});
    else if(depDraft) setDraftAvailable({type:"depart", data:depDraft});
  },[]);
  
  // Auth listener
  useEffect(()=>{
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      console.log("🔐 Auth state changed:", user?.email, "UID:", user?.uid);
      setCurrentUser(user);
      if(user){
        // Load user profile from Firestore
        try {
          console.log("📄 Fetching user profile for UID:", user.uid);
          const userDoc = await getDoc(doc(db, "users", user.uid));
          console.log("📄 User doc exists?", userDoc.exists());
          
          if(userDoc.exists()){
            const profile = userDoc.data();
            console.log("✅ User profile loaded:", profile);
            setAccessPending(false);
            setUserProfile(profile);
          } else {
            // Check if user is in pending_users (first login)
            console.log("🔍 Checking pending_users for email:", user.email);
            const pendingId = user.email.replace(/[@.]/g, '_');
            let pendingData = null;
            let pendingLu = true; // false si les règles Firestore refusent la lecture
            try {
              const pendingDoc = await getDoc(doc(db, "pending_users", pendingId));
              pendingData = pendingDoc.exists() ? pendingDoc.data() : null;
            } catch(e) {
              console.warn("Lecture pending_users refusée, passage par l'API:", e);
              pendingLu = false;
            }
            if(pendingData && pendingData.role){
              // Migrate from pending_users to users (compte validé : rôle attribué)
              console.log("✨ Migrating user from pending to active");
              const newProfile = {
                email: pendingData.email,
                nom: pendingData.nom,
                prenom: pendingData.prenom,
                role: pendingData.role,
                activatedAt: new Date().toISOString(),
                createdAt: pendingData.createdAt
              };
              
              // Create in users collection with UID
              await setDoc(doc(db, "users", user.uid), newProfile);
              
              // Delete from pending_users
              await deleteDoc(doc(db, "pending_users", pendingId));
              
              console.log("✅ User activated successfully!");
              setUserProfile(newProfile);
            } else if(pendingData){
              // Demande déjà envoyée, en attente de validation par le super admin
              console.log("⏳ Demande d'accès en attente de validation");
              setAccessPending(true);
              setUserProfile(null);
            } else {
              // 🆕 Première connexion inconnue → le SERVEUR crée la
              // demande d'accès et notifie le super admin (les règles
              // Firestore interdisent cette écriture aux comptes sans profil)
              console.log("🆕 Nouvel utilisateur : demande d'accès via l'API");
              try {
                const tk = await user.getIdToken();
                const r = await fetch("/api/notify-new-user", {method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${tk}`},body:"{}"});
                const rj = await r.json().catch(()=>({}));
                console.log("📧 Demande d'accès:", r.status, rj);
                if (r.ok && rj.status === "approved" && !pendingLu) {
                  // Pré-création avec rôle que l'app n'a pas pu lire :
                  // on invite à recharger (la migration se fera alors)
                  setAccessPending(false);
                } else if (r.ok) {
                  setAccessPending(true); // demande créée / déjà en attente
                }
              } catch(e) { console.error("Demande d'accès impossible:", e); }
              setUserProfile(null);
            }
          }
        } catch(error) {
          console.error("❌ Error loading user profile:", error);
          setUserProfile(null);
        }
      } else {
        console.log("🚪 No user logged in");
        setAccessPending(false);
        setUserProfile(null);
      }
      setAuthLoading(false);
    });
    return () => unsubscribe();
  },[]);

  // Auto-fill agent field when user profile loads
  useEffect(()=>{
    if(userProfile){
      const fullName = `${userProfile.prenom} ${userProfile.nom}`;
      setDepForm(prev=>({...prev,agent:fullName}));
      setRetForm(prev=>({...prev,agent:fullName}));
    }
  },[userProfile]);

  // ─── Chargement PAGINÉ des dossiers ───
  // Avant : la collection ENTIÈRE était téléchargée à chaque ouverture (archives
  // comprises) → démarrage de plus en plus lent avec l'historique qui grossit.
  // Maintenant : les PAGE_DOSSIERS plus récents, puis « Voir plus » à la demande.
  // Les recherches par immatriculation vont chercher directement le dossier sur
  // le serveur s'il n'est pas chargé (fetchDossier) : rien n'est jamais introuvable.
  async function loadAll() {
    setLoading(true);
    try {
      let docsList = [];
      try {
        const qy = query(collection(db, "dossiers"), orderBy("createdAt", "desc"), limit(PAGE_DOSSIERS));
        const snap = await getDocs(qy);
        docsList = snap.docs;
        setDossiersCursor(docsList.length ? docsList[docsList.length - 1] : null);
        setHasMoreDossiers(docsList.length === PAGE_DOSSIERS);
      } catch (e) {
        // Sécurité : si la requête paginée échoue (index, données legacy...),
        // on retombe sur l'ancien chargement complet plutôt que de rien afficher.
        console.warn("Chargement paginé impossible, chargement complet:", e);
        const snap = await getDocs(collection(db, "dossiers"));
        docsList = snap.docs;
        setDossiersCursor(null);
        setHasMoreDossiers(false);
      }
      const result = {};
      docsList.forEach(d => { result[d.id] = d.data(); });
      setDossiers(result);
      const zC=await fbGetConfig("zones"); if(zC?.data) setZones(zC.data);
      // Destinataires des envois automatiques (Admin → Emails)
      try {
        const eC=await fbGetConfig("emails");
        if(eC) setEmailsCfg({
          retour_to:(eC.retour_to||[]).join("\n"),
          devis_to:(eC.devis_to||[]).join("\n"),
          cc_assistanat:(Array.isArray(eC.cc_assistanat)?eC.cc_assistanat:[eC.cc_assistanat].filter(Boolean)).join("\n"),
          compta_to:(eC.compta_to||[]).join("\n"),
        });
        setEmailsCfgLoaded(true);
      } catch(e){ console.warn("Config emails non chargée:", e); }
      const tnC=await fbGetConfig("types_nacelle"); if(tnC?.data?.length) setTypesNacelle(tnC.data);
      const tC=await fbGetConfig("tarifs");
      if(tC?.data){
        const loaded=tC.data;
        // Ajoute les postes par défaut manquants (ex: nouveaux feux dissociés) sans écraser les prix existants
        const missing=DEFAULT_TARIFS.filter(dt=>!loaded.some(t=>t.id===dt.id));
        // Enrichit les postes "sur devis" existants avec le barème par taille par défaut
        // (uniquement s'ils n'en ont pas déjà un personnalisé en admin)
        // (bareme === undefined : données d'avant la fonctionnalité ; bareme === null :
        //  barème volontairement retiré en admin → on ne le réinjecte pas)
        const enriched=loaded.map(t=>{ const dt=DEFAULT_TARIFS.find(d=>d.id===t.id); return (dt?.bareme&&t.surDevis&&t.bareme===undefined)?{...t,bareme:dt.bareme}:t; });
        setTarifs(missing.length?[...enriched,...missing]:enriched);
      } else {
        setTarifs(DEFAULT_TARIFS);
      }
    } catch(e){console.error(e);}
    setLoading(false);
  }

  // « Voir plus » : charge la page suivante de dossiers (plus anciens)
  async function loadMoreDossiers() {
    if (!dossiersCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const qy = query(collection(db, "dossiers"), orderBy("createdAt", "desc"), startAfter(dossiersCursor), limit(PAGE_DOSSIERS));
      const snap = await getDocs(qy);
      setDossiers(prev => { const n = { ...prev }; snap.docs.forEach(d => { if (!n[d.id]) n[d.id] = d.data(); }); return n; });
      setDossiersCursor(snap.docs.length ? snap.docs[snap.docs.length - 1] : null);
      setHasMoreDossiers(snap.docs.length === PAGE_DOSSIERS);
    } catch (e) { console.error("Voir plus de dossiers:", e); }
    finally { setLoadingMore(false); }
  }

  // Récupère UN dossier par immatriculation : dans l'état local s'il est chargé,
  // sinon directement sur le serveur (puis mémorisé). Garantit que les recherches
  // (retour, départ, photos de ventes) trouvent TOUJOURS un dossier, même ancien
  // et hors des pages chargées.
  async function fetchDossier(immatRaw) {
    const im = normalizeImmat((immatRaw || "").trim());
    if (!im) return null;
    if (dossiers[im]) return dossiers[im];
    try {
      const snap = await getDoc(doc(db, "dossiers", im));
      if (snap.exists()) {
        const d = snap.data();
        setDossiers(prev => prev[im] ? prev : { ...prev, [im]: d });
        return d;
      }
    } catch (e) { console.error("Chargement du dossier", im, e); }
    return null;
  }

  // Auth functions
  async function handleGoogleLogin() {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch(error) {
      console.error("Login error:", error);
      alert("Erreur de connexion : " + error.message);
    }
  }

  async function handleLogout() {
    try {
      await signOut(auth);
    } catch(error) {
      console.error("Logout error:", error);
    }
  }

  async function loadUsers() {
    try {
      // Load active users (with UID)
      const activeSnap = await getDocs(collection(db, "users"));
      const activeUsers = [];
      activeSnap.docs.forEach(d => activeUsers.push({uid: d.id, ...d.data(), status: "active"}));
      
      // Load pending users (waiting for first login)
      const pendingSnap = await getDocs(collection(db, "pending_users"));
      const pendingUsers = [];
      pendingSnap.docs.forEach(d => pendingUsers.push({uid: d.id, ...d.data()}));
      
      // Combine both lists
      setUsers([...activeUsers, ...pendingUsers]);
    } catch(error) {
      console.error("Error loading users:", error);
    }
  }

  async function createUser(userData) {
    try {
      // Save to pending_users collection (will be moved to users on first login)
      const userId = userData.email.replace(/[@.]/g, '_');
      await setDoc(doc(db, "pending_users", userId), {
        ...userData,
        createdAt: new Date().toISOString(),
        status: "pending" // Will become "active" on first login
      });
      setAdminMsg("Utilisateur créé ! L'expert peut maintenant se connecter avec son compte Google.");
      setTimeout(() => setAdminMsg(""), 4000);
      loadUsers();
      setUserForm({email:"",nom:"",prenom:"",role:"expert"});
    } catch(error) {
      console.error("Error creating user:", error);
      alert("Erreur : " + error.message);
    }
  }

  async function updateUser(uid, userData) {
    try {
      await updateDoc(doc(db, "users", uid), userData);
      setAdminMsg("Utilisateur modifié !");
      setTimeout(() => setAdminMsg(""), 3000);
      loadUsers();
      setEditingUser(null);
    } catch(error) {
      console.error("Error updating user:", error);
      alert("Erreur : " + error.message);
    }
  }

  // ✅ Validation d'une demande d'accès : on pose le rôle sur pending_users ;
  // la migration vers users se fait à la prochaine connexion de la personne.
  async function approveRequest(uid) {
    try {
      await updateDoc(doc(db, "pending_users", uid), { role: pendingRole[uid] || "expert" });
      setAdminMsg("Accès validé ! La personne peut se connecter (ou recharger la page).");
      setTimeout(() => setAdminMsg(""), 4000);
      loadUsers();
    } catch(error) {
      console.error("Error approving request:", error);
      alert("Erreur : " + error.message);
    }
  }

  async function deleteUser(uid) {
    if(!confirm("Supprimer cet utilisateur ?")) return;
    try {
      // Try to delete from users collection
      try {
        await deleteDoc(doc(db, "users", uid));
      } catch(e) {
        // If not found in users, try pending_users
        await deleteDoc(doc(db, "pending_users", uid));
      }
      setAdminMsg("Utilisateur supprimé !");
      setTimeout(() => setAdminMsg(""), 3000);
      loadUsers();
    } catch(error) {
      console.error("Error deleting user:", error);
      alert("Erreur : " + error.message);
    }
  }

  // Upload photo détourée to Firebase Storage
  async function uploadDetoureedPhotoToStorage(base64Data, immat, zoneId, photoIndex, type = "retour") {
    try {
      console.log("🔄 Uploading photo to Storage...", {immat, zoneId, photoIndex, type});
      
      // Create storage path
      const timestamp = Date.now();
      const filename = `photo_${photoIndex}_${timestamp}.png`;
      const storagePath = `photos-detourees/${immat}/${type}/${zoneId}/${filename}`;
      
      console.log("📂 Storage path:", storagePath);
      
      // Upload to Firebase Storage using uploadString with data_url format
      const storageRef = ref(storage, storagePath);
      const snapshot = await uploadString(storageRef, base64Data, 'data_url');
      
      console.log("📤 Upload complete:", snapshot.metadata.fullPath);
      
      // Get download URL
      const downloadURL = await getDownloadURL(storageRef);
      
      console.log(`✅ Photo uploaded successfully!`);
      console.log(`📍 Download URL:`, downloadURL);
      
      return downloadURL;
    } catch(error) {
      console.error("❌ Error uploading photo to Storage:", error);
      console.error("Error details:", error.message);
      alert(`Erreur upload Storage: ${error.message}`);
      return null;
    }
  }

  // Détermine le contexte d'upload (depart/retour + immat) selon la vue
  function uploadContext(zoneId) {
    const isRetour = view === "retour";
    const immat = isRetour ? (foundDossier?.immat || retForm.immat || searchImmat || "no-immat") : (depForm.immat || "no-immat");
    const type = isRetour ? "retour" : "depart";
    return { type, immat: immat.replace(/[^A-Z0-9-]/gi, "_") };
  }

  // Upload une photo (File) vers Firebase Storage et renvoie {name, url, path}
  async function uploadPhotoToStorage(file, zoneId) {
    const { type, immat } = uploadContext(zoneId);
    // Compresser avant upload (max 1600px, qualité 0.82) — garde une bonne qualité commerciale
    const base64Original = await photoToBase64(file);
    let compressed = await compressBase64(base64Original, 1600, 0.82);
    if (!compressed) {
      // Image non décodable par le navigateur (ex: HEIC) → on tente l'upload de l'originale
      // si c'est un format d'image standard, sinon on abandonne proprement CETTE photo
      // sans bloquer les suivantes.
      if (/^data:image\/(jpeg|jpg|png|webp|gif)/i.test(base64Original)) {
        compressed = base64Original;
      } else {
        throw new Error(`Format non pris en charge (${file.name}). Utilisez JPEG ou PNG.`);
      }
    }
    const timestamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const storagePath = `dossiers/${immat}/${type}/${zoneId}/${timestamp}_${rand}.jpg`;
    const storageRef = ref(storage, storagePath);
    // ⚡ Envoi BINAIRE (uploadBytes) plutôt que base64 (uploadString) :
    // ~25 % de données en moins à transférer — appréciable en 4G sur chantier.
    const blob = await (await fetch(compressed)).blob();
    await withTimeout(uploadBytes(storageRef, blob, { contentType: "image/jpeg" }), 90000, "envoi de " + file.name);
    const url = await withTimeout(getDownloadURL(storageRef), 30000, "récupération URL");
    return { name: file.name, url, path: storagePath };
  }

  // ⚡ Envois PARALLÉLISÉS : 3 photos à la fois au lieu d'une par une.
  // Pendant qu'une photo part sur le réseau, la suivante se compresse sur le
  // processeur → ~3× plus rapide sur un lot. Limité à 3 simultanées pour ne pas
  // saturer la mémoire du téléphone ni la connexion mobile.
  const UPLOAD_CONCURRENCY = 3;
  async function addPhotos(files, zoneId, setter) {
    const arr = Array.from(files || []);
    if (!arr.length) return;
    setUploadingCount(n => n + arr.length);
    const failed = [];
    const queue = [...arr];
    const worker = async () => {
      while (queue.length) {
        const f = queue.shift();
        if (!f) break;
        try {
          const photo = await uploadPhotoToStorage(f, zoneId);
          setter(prev => ({ ...prev, [zoneId]: [...(prev[zoneId] || []), photo] }));
        } catch (e) {
          console.error("Erreur upload photo:", f?.name, e);
          failed.push(`${f?.name || "photo"} — ${e.message}`);
        } finally {
          // Toujours décrémenter, même en cas d'échec : le compteur ne peut plus rester bloqué
          setUploadingCount(n => Math.max(0, n - 1));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, arr.length) }, worker));
    // Une seule alerte récapitulative à la fin (les alertes en boucle bloquaient la file)
    if (failed.length) {
      alert(`${failed.length} photo${failed.length>1?"s n'ont":" n'a"} pas pu être envoyée${failed.length>1?"s":""} :\n\n${failed.join("\n")}\n\nLes autres photos ont bien été ajoutées. Vous pouvez réessayer.`);
    }
  }
  function removePhoto(zoneId,idx,setter) { setter(prev=>({...prev,[zoneId]:prev[zoneId].filter((_,i)=>i!==idx)})); }

  // ─── Lightbox : un seul écouteur (délégation) — clic sur n'importe quelle photo → agrandissement ───
  function openLightboxFromClick(e) {
    const img = e.target;
    if(!img || img.tagName!=="IMG") return;
    if(img.closest("button") || img.closest("a") || img.closest(".no-lightbox")) return;
    const src = img.currentSrc || img.src;
    if(!src || src===DELTA_LOGO) return; // exclut les logos
    setLightboxUrl(src);
  }

  // ─── Rotation manuelle 90° horaire — pour les photos sans étiquette EXIF (ex. chargées d'un PC) ───
  async function rotateImage90(src) {
    const img = await new Promise((res,rej)=>{ const i=new Image(); i.crossOrigin="anonymous"; i.onload=()=>res(i); i.onerror=()=>rej(new Error("Chargement de l'image impossible")); i.src=src; });
    const c=document.createElement("canvas");
    c.width=img.naturalHeight; c.height=img.naturalWidth;
    const ctx=c.getContext("2d");
    ctx.translate(c.width/2,c.height/2); ctx.rotate(Math.PI/2);
    ctx.drawImage(img,-img.naturalWidth/2,-img.naturalHeight/2);
    return c.toDataURL("image/jpeg",0.85);
  }
  async function rotatePhotoAt(photosObj, zoneId, idx, setter) {
    const p = photosObj?.[zoneId]?.[idx];
    if(!p?.url || rotatingKey) return;
    setRotatingKey(zoneId+"_"+idx);
    try {
      const rotated = await rotateImage90(p.url);
      const { type, immat } = uploadContext(zoneId);
      const timestamp = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const storagePath = `dossiers/${immat}/${type}/${zoneId}/${timestamp}_${rand}_rot.jpg`;
      const storageRef = ref(storage, storagePath);
      await withTimeout(uploadString(storageRef, rotated, "data_url"), 90000, "envoi photo pivotée");
      const url = await withTimeout(getDownloadURL(storageRef), 30000, "récupération URL");
      setter(prev=>{ const arr=[...(prev[zoneId]||[])]; if(!arr[idx]) return prev; arr[idx]={...arr[idx], url, path:storagePath}; return {...prev,[zoneId]:arr}; });
    } catch(e) {
      console.error("Rotation:", e);
      alert("Rotation impossible : " + e.message);
    } finally { setRotatingKey(null); }
  }

  // ─── Tri des photos importées en lot (expertise retour) ───
  // Déplace une photo du bac "a_trier" vers une section, un angle du tour ou un dégât.
  // Si c'est un dégât, il est coché automatiquement (quantité 1 par défaut).
  function assignPendingPhoto(idx, targetKey, degatId) {
    setRetPhotos(prev=>{
      const pool=[...(prev["a_trier"]||[])];
      const photo=pool.splice(idx,1)[0];
      if(!photo) return prev;
      return {...prev, a_trier:pool, [targetKey]:[...(prev[targetKey]||[]), photo]};
    });
    if(degatId){
      setRetDegats(prev=>prev.includes(degatId)?prev:[...prev,degatId]);
      setRetQtes(prev=>prev[degatId]?prev:{...prev,[degatId]:1});
    }
    setTriPhoto(null); setTriFilter("");
  }
  // Affectation d'une photo du bac DÉPART (sections / angles du tour / photos supplémentaires — pas de dégâts au départ)
  function assignDepPendingPhoto(idx, targetKey) {
    setDepPhotos(prev=>{
      const pool=[...(prev["a_trier"]||[])];
      const photo=pool.splice(idx,1)[0];
      if(!photo) return prev;
      return {...prev, a_trier:pool, [targetKey]:[...(prev[targetKey]||[]), photo]};
    });
    setDepTriPhoto(null); setDepTriFilter("");
  }
  // ─── Modification d'une expertise retour DÉJÀ validée ───
  // Recharge toutes les données sauvegardées (zones, tests, photos, dégâts,
  // quantités, notes) dans le formulaire retour. À la re-validation, saveRetour
  // écrase l'ancienne version et régénère le PDF.
  function editRetour(d) {
    if(!d?.retour) return;
    setFoundDossier(d);
    setSearchImmat(d.immat);
    setSearchDone(true);
    setRetForm({
      date: d.retour.date || todayISO(),
      heures: d.retour.heures || "",
      km_porteur: d.retour.km_porteur || "",
      agent: d.retour.agent || (userProfile ? `${userProfile.prenom} ${userProfile.nom}` : ""),
      lieu_restitution: d.retour.lieu_restitution || "",
      immat: d.immat,
      numero_cube: d.info?.numero_cube || "",
      type_nacelle: d.info?.type_nacelle || "",
      modele: d.info?.modele || "",
      annee_fab: d.info?.annee_fab || "",
      client: d.info?.client || "",
      contrat: d.info?.contrat || "",
      email: d.info?.email || ""
    });
    setRetZones(d.retour.zones || {});
    setRetTests(d.retour.tests || {});
    setRetPhotos(d.retour.photos || {});
    setRetDegats(d.retour.degats || []);
    setRetMontantsDevis(d.retour.montants_devis || {});
    // Recharge les tranches ; les montants sans tranche = saisie libre
    setRetTranchesDevis((()=>{ const td={...(d.retour.tranches_devis||{})}; Object.keys(d.retour.montants_devis||{}).forEach(id=>{ if(!td[id]) td[id]="__LIBRE__"; }); return td; })());
    setRetQtes(d.retour.quantites || {});
    setRetNote(d.retour.note || "");
    setEmailClient(d.info?.email || "");
    setEmailSent(false);
    setOpenZone(null);
    setActiveDossier(null);
    setRetStep(1);
    setView("retour");
  }

  // À la validation de l'étape 1 : les photos restées non triées partent en "Photos supplémentaires"
  function flushPendingPhotos() {
    setRetPhotos(prev=>{
      const pool=prev["a_trier"]||[];
      if(!pool.length) return prev;
      return {...prev, a_trier:[], photos_supplementaires:[...(prev["photos_supplementaires"]||[]), ...pool]};
    });
  }
  function setZE(setter,zoneId,etat) { setter(prev=>({...prev,[zoneId]:{...(prev[zoneId]||{}),etat}})); }
  function setZN(setter,zoneId,note) { setter(prev=>({...prev,[zoneId]:{...(prev[zoneId]||{}),note}})); }

  // 📧 Envoi AUTOMATIQUE de l'état de départ au client (serveur → Brevo).
  // Remplace l'ancien lien mailto: qui dépendait de la messagerie configurée
  // sur l'appareil de l'expert (source des « emails jamais partis »).
  async function sendDepartEmail() {
    const email = (depForm.email||"").trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      alert("Renseignez d'abord l'email du client (champ « Email client » de l'identification).");
      return;
    }
    if (depEmailSending) return;
    setDepEmailSending(true);
    try {
      // 1) Publie l'état de départ (page HTML) et active le lien court /depart
      const htmlContent = captureCurrentPageHTML();
      const reportUrl = await uploadReportToStorage(htmlContent, depForm.immat, "depart");
      await setDoc(doc(db, "rapports_links", depForm.immat), { depart_url: reportUrl, updatedAt: new Date().toISOString() }, { merge: true });
      // 2) Envoi serveur au client (+ copie assistanat commerce)
      const token = await auth.currentUser?.getIdToken();
      if (!token) throw new Error("utilisateur non authentifié");
      const resp = await fetch("/api/notify-depart", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
        body: JSON.stringify({ immat: depForm.immat, email_client: email, modele: depForm.modele, type_nacelle: depForm.type_nacelle }),
      });
      if (!resp.ok) { const t = await resp.json().catch(()=>({})); throw new Error(t.error || ("HTTP " + resp.status)); }
      setDepEmailSent(true);
      alert("📧 État de départ envoyé à " + email + " (copie assistanat commerce)");
    } catch (e) {
      console.error("Envoi état de départ:", e);
      alert("⚠ L'envoi automatique a échoué : " + e.message + "\n\nVous pouvez réessayer dans un instant.");
    } finally {
      setDepEmailSending(false);
    }
  }

  // Validation du départ (photos non triées confirmées, sauvegarde, retour accueil)
  // — factorisée pour être appelée depuis le haut ET le bas de l'écran de rapport.
  async function validerDepart() {
    const pending=(depPhotos["a_trier"]||[]).length;
    if(pending&&!window.confirm(`${pending} photo${pending>1?"s":""} du bac d'import n'${pending>1?"ont":"a"} pas été affectée${pending>1?"s":""} et ser${pending>1?"ont":"a"} abandonnée${pending>1?"s":""}.\n\nValider quand même ?`)) return;
    await saveDepart();
    clearDraft("depart");
    goHome();
  }

  async function saveDepart() {
    // ── Cycles multiples : une nacelle fait des allers-retours départ→retour→départ...
    // Si un cycle complet (départ + retour) existe déjà pour cette immat, on l'ARCHIVE
    // avant de créer le nouveau départ, au lieu de l'écraser définitivement.
    // Le dossier peut être ancien et hors des pages chargées → recherche serveur si besoin
    const previous = dossiers[depForm.immat] || await fetchDossier(depForm.immat);
    if (previous?.retour) {
      const archiveId = `${previous.immat}__ARCH__${Date.now()}`;
      const archivedDoc = { ...previous, archived: true, archiveId, archivedAt: new Date().toISOString() };
      try {
        await setDoc(doc(db, "dossiers", archiveId), archivedDoc);
        setDossiers(prev => ({ ...prev, [archiveId]: archivedDoc }));
        console.log("📦 Cycle précédent archivé:", archiveId);
      } catch (e) {
        console.error("Archivage impossible:", e);
        if (!window.confirm("⚠ L'archivage du cycle précédent a échoué (" + e.message + ").\n\nContinuer quand même ? L'ancien dossier (départ + retour) sera définitivement écrasé.")) {
          throw new Error("Sauvegarde annulée — cycle précédent conservé");
        }
      }
    }
    // Signature client (optionnelle) : upload PNG dans Storage
    let signatureInfo = null;
    if (depSignature) {
      try {
        // Même profondeur de chemin que les photos (dossiers/immat/type/zone/fichier)
        // pour correspondre aux règles de sécurité Storage existantes.
        const sigPath = `dossiers/${(depForm.immat||"no-immat").replace(/[^A-Z0-9-]/gi,"_")}/depart/signature/${Date.now()}.png`;
        const sigRef = ref(storage, sigPath);
        await uploadString(sigRef, depSignature, "data_url");
        const sigUrl = await getDownloadURL(sigRef);
        signatureInfo = { url: sigUrl, signedAt: new Date().toISOString() };
      } catch(e) {
        console.error("Upload signature:", e);
        alert("⚠ La signature n'a pas pu être enregistrée (" + e.message + ").\nLe dossier sera sauvegardé sans signature.");
      }
    }
    // ── Préservation des infos ADV (Delta VO) ──
    // Si un dossier pré-créé existe (infos client/contrat poussées par les
    // secrétaires depuis Delta VO), ses infos servent de socle : les champs
    // laissés VIDES dans le formulaire ne les écrasent pas.
    const depFormRempli = Object.fromEntries(
      Object.entries(depForm).filter(([,v]) => v !== "" && v != null)
    );
    const data={
      id:genId(),
      immat:depForm.immat,
      info:{...(previous?.info||{}), ...depFormRempli, immat:depForm.immat},
      // Le bac "a_trier" n'est jamais sauvegardé : les photos non affectées sont abandonnées (confirmées avant validation)
      depart:{zones:depZones,photos:(()=>{ const {a_trier,...rest}=depPhotos; return rest; })(),tests:depTests,date:depForm.date,heures:depForm.heures,km_porteur:depForm.km_porteur,agent:depForm.agent,...(signatureInfo?{signature_client:signatureInfo}:{})},
      retour:null,
      // 🚚 Sécurité départ : Delta VO détecte ce dossier (départ seul)
      // et fait suivre la machine (prête / louée LLD) — jamais de restitution.
      synced_to_delta_vo: false,
      createdAt:new Date().toISOString(),
      createdBy: currentUser?.uid || null,
      createdByName: userProfile ? `${userProfile.prenom} ${userProfile.nom}` : depForm.agent
    };
    await fbSaveDossier(data); setDossiers(prev=>({...prev,[data.immat]:data})); return data;
  }
  async function saveRetour() {
    if(!foundDossier) return;

    // ── Correction d'immatriculation (faute de frappe) ──
    // Le dossier est indexé par immat dans Firestore : si elle a changé,
    // on sauvegarde sous la nouvelle clé puis on supprime l'ancien document.
    const renamedFrom = foundDossier._renamedFrom;
    const isRenamed = !!renamedFrom && renamedFrom !== foundDossier.immat;
    if (isRenamed) {
      const clash = dossiers[foundDossier.immat] || await fetchDossier(foundDossier.immat);
      if (clash && clash.id !== foundDossier.id) {
        alert(`⚠ Impossible de corriger l'immatriculation : un autre dossier existe déjà pour « ${foundDossier.immat} ».`);
        return null;
      }
    }

    // Génération du PDF de restitution (côté navigateur) + upload Firebase Storage
    let pdfInfo = null;
    try {
      const recapEl = document.getElementById("retour-recap-content");
      if (recapEl) {
        const result = await generateAndUploadRetourPdf(recapEl, foundDossier.immat);
        pdfInfo = { pdf_url: result.url, pdf_path: result.path, pdf_generated_at: new Date().toISOString() };
      } else {
        console.warn("Élément #retour-recap-content introuvable, PDF non généré");
      }
    } catch(e) {
      console.error("Erreur génération/upload PDF:", e);
      // On poursuit la sauvegarde même si la génération PDF échoue,
      // pour ne pas bloquer l'expert. Il pourra régénérer plus tard.
      alert("⚠ Le PDF du rapport n'a pas pu être généré : " + e.message + "\nLe dossier sera quand même sauvegardé.");
    }
    
    const updated={
      ...foundDossier,
      info:{...foundDossier.info, numero_cube: retForm.numero_cube || foundDossier.info?.numero_cube || ""},
      retour:{
        zones:retZones,
        // Sécurité : les photos encore "à trier" partent en photos supplémentaires plutôt que d'être perdues
        photos:(()=>{ const {a_trier,...rest}=retPhotos; return a_trier?.length ? {...rest, photos_supplementaires:[...(rest.photos_supplementaires||[]),...a_trier]} : rest; })(),
        tests:retTests,
        degats:retDegats,
        quantites:retQtes,
        montants_devis:retMontantsDevis, // montants saisis en direct sur les postes "sur devis"
        // Tranches de barème choisies (libellés affichés dans le rapport) — hors saisie libre
        tranches_devis:Object.fromEntries(Object.entries(retTranchesDevis).filter(([,v])=>v&&v!=="__LIBRE__")),
        note:retNote,
        date:retForm.date,
        heures:retForm.heures,
        km_porteur:retForm.km_porteur,
        agent:retForm.agent,
        lieu_restitution:retForm.lieu_restitution||"",
        commercialPhotos:{ ...(foundDossier.retour?.commercialPhotos||{}) }, // préserve les photos de ventes prises via l'onglet dédié
        ...(pdfInfo || {})
      },
      synced_to_delta_vo: false, // Marqueur pour synchronisation avec Delta VO
      updatedAt:new Date().toISOString(),
      updatedBy: currentUser?.uid || null,
      updatedByName: userProfile ? `${userProfile.prenom} ${userProfile.nom}` : retForm.agent
    };
    // ─── DEVIS EN ATTENTE ───
    // Postes "sur devis" cochés SANS montant chiffré → le dossier passe en
    // « En attente de devis » : jeton d'accès pour l'atelier Nacelle Assistance
    // (page de saisie liée à ce seul dossier), alerte email, et mention
    // provisoire dans le rapport client.
    {
      const pendingIds = retDegats.filter(id => {
        const t = tarifs.find(t => t.id === id);
        return t?.surDevis && !retMontantsDevis[id];
      });
      if (pendingIds.length) {
        updated.devis_pending = pendingIds;
        // Libellés stockés avec le dossier : affichés tels quels côté Delta VO (badge secrétaire)
        updated.devis_pending_labels = pendingIds.map(id => (tarifs.find(t => t.id === id) || {}).label || id);
        updated.devis_complet = false;
        // Conserver le jeton existant si on re-valide le même dossier (le lien
        // déjà envoyé à l'atelier reste valable) ; sinon en générer un nouveau.
        if (foundDossier.devis_token) {
          updated.devis_token = foundDossier.devis_token;
          updated.devis_token_created = foundDossier.devis_token_created;
        } else {
          const bytes = new Uint8Array(24);
          crypto.getRandomValues(bytes);
          updated.devis_token = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
          updated.devis_token_created = new Date().toISOString();
        }
        updated.devis_recu = foundDossier.devis_recu || {};
      } else if (foundDossier.devis_pending?.length) {
        // Le dossier était en attente et tout est désormais chiffré (re-validation)
        updated.devis_pending = [];
        updated.devis_complet = true;
      }
    }
    // 💶 Résumé d'expertise (dégâts + montants + total retenue) stocké sur le
    // dossier : copié tel quel par Delta VO (secrétaires/commerciaux) et
    // recalculé à chaque chiffrage atelier (api/devis).
    updated.expertise_resume = buildExpertiseResume(updated, tarifs);
    delete updated._renamedFrom; // champ de travail : ne pas persister
    await fbSaveDossier(updated);
    if (isRenamed) {
      try { await deleteDoc(doc(db, "dossiers", renamedFrom)); console.log("🔤 Immat corrigée :", renamedFrom, "→", updated.immat); }
      catch(e) { console.error("Suppression ancien dossier:", e); }
    }
    setDossiers(prev=>{ const n={...prev,[updated.immat]:updated}; if(isRenamed) delete n[renamedFrom]; return n; });
    setActiveDossier(updated); return updated;
  }

  // Admin → Emails : enregistre les destinataires des envois automatiques
  async function saveEmailsCfg() {
    const parse=(s)=>String(s||"").split(/[\n,;]+/).map(x=>x.trim()).filter(Boolean);
    const bad=[...parse(emailsCfg.retour_to),...parse(emailsCfg.devis_to),...parse(emailsCfg.cc_assistanat),...parse(emailsCfg.compta_to)]
      .filter(e=>!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    if(bad.length){ alert("Adresse(s) invalide(s) :\n"+bad.join("\n")); return; }
    await fbSaveConfig("emails",{
      retour_to:parse(emailsCfg.retour_to),
      devis_to:parse(emailsCfg.devis_to),
      cc_assistanat:parse(emailsCfg.cc_assistanat),
      compta_to:parse(emailsCfg.compta_to),
      updatedAt:new Date().toISOString(),
    });
    flash("Destinataires enregistrés ✓");
  }

  async function saveZone() {
    if(!zoneForm.label.trim()) return;
    let updated;
    if(zoneEdit!==null) updated=zones.map((z,i)=>i===zoneEdit?{...z,label:zoneForm.label,icon:zoneForm.icon}:z);
    else { const id=zoneForm.label.toLowerCase().replace(/[^a-z0-9]/g,"_").slice(0,18)+"_"+genId().slice(0,3).toLowerCase(); updated=[...zones,{id,label:zoneForm.label,icon:zoneForm.icon}]; }
    setZones(updated); await fbSaveConfig("zones",{data:updated}); setZoneForm({label:"",icon:"⟋"}); setZoneEdit(null); flash(zoneEdit!==null?"Zone modifiée ✓":"Zone ajoutée ✓");
  }
  async function deleteZone(idx) { const z=zones[idx]; const uz=zones.filter((_,i)=>i!==idx); const ut=tarifs.filter(t=>t.zone!==z.id); setZones(uz); setTarifs(ut); await fbSaveConfig("zones",{data:uz}); await fbSaveConfig("tarifs",{data:ut}); flash("Zone supprimée ✓"); }
  async function saveTarif() {
    if(!tarifForm.label.trim()||!tarifForm.zone) return;
    const entry={zone:tarifForm.zone,label:tarifForm.label,surDevis:tarifForm.surDevis};
    if(!tarifForm.surDevis&&tarifForm.prix) entry.prix=parseInt(tarifForm.prix); else entry.prix=null;
    // Barème par taille : uniquement pour les postes sur devis, tranches complètes
    entry.bareme = tarifForm.surDevis
      ? (tarifForm.bareme||[]).filter(b=>b.label?.trim()&&Number(b.montant)>0)
      : null;
    if(!entry.bareme?.length) entry.bareme=null;
    let updated;
    if(tarifEdit!==null) updated=tarifs.map((t,i)=>i===tarifEdit?{...t,...entry}:t);
    else { const id=tarifForm.label.toLowerCase().replace(/[^a-z0-9]/g,"_").slice(0,18)+"_"+genId().slice(0,3).toLowerCase(); updated=[...tarifs,{id,...entry}]; }
    setTarifs(updated); await fbSaveConfig("tarifs",{data:updated}); setTarifForm({zone:"",label:"",prix:"",surDevis:false,bareme:[]}); setTarifEdit(null); flash(tarifEdit!==null?"Poste modifié ✓":"Poste ajouté ✓");
  }
  async function deleteTarif(idx) { const updated=tarifs.filter((_,i)=>i!==idx); setTarifs(updated); await fbSaveConfig("tarifs",{data:updated}); flash("Poste supprimé ✓"); }
  async function deleteDossier(immat) {
    if(!immat) { alert("Impossible de supprimer : immatriculation manquante.\nSupprimez ce dossier directement depuis la console Firebase."); return; }
    try {
      await deleteDoc(doc(db,"dossiers",immat));
      setDossiers(prev=>{ const n={...prev}; delete n[immat]; return n; });
      // 🔁 Suppression MIROIR de la fiche Delta VO (garde-fous côté serveur :
      // seules les fiches en début de cycle — restitution/disponible, non
      // archivées — sont supprimées ; une machine vendue/clôturée est conservée).
      let msgVO = "";
      try {
        const token = await auth.currentUser?.getIdToken();
        const r = await fetch("/api/delete-machine-vo", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify({ immat }),
        });
        const j = await r.json().catch(()=>({}));
        if (!r.ok) msgVO = " · ⚠ fiche Delta VO non supprimée ("+(j.error||("erreur "+r.status))+")";
        else if (j.deleted) msgVO = " · fiche Delta VO supprimée";
        else if (j.motif === "protegee") msgVO = " · fiche Delta VO conservée (statut : "+(j.statut||"avancé")+")";
        else msgVO = " · pas de fiche Delta VO";
      } catch(e2) { msgVO = " · ⚠ Delta VO injoignable ("+e2.message+")"; }
      flash("Dossier supprimé ✓"+msgVO, 6000);
    } catch(e) { alert("Erreur : "+e.message); }
  }
  function flash(msg, duree) { setAdminMsg(msg); setTimeout(()=>setAdminMsg(""),duree||2500); }

  const vetusteTaux = foundDossier ? getVetuste(foundDossier.info?.annee_fab) : 0;
  const totalRetenue = retDegats.reduce((s,id)=>{ const t=tarifs.find(t=>t.id===id); return s+montantPoste(t,retQtes[id]||1,vetusteTaux,retMontantsDevis); },0);
  // Les cycles archivés (allers-retours précédents) sont exclus des listes ; ils restent
  // consultables dans l'historique du rapport de chaque nacelle.
  const dossiersActifs = Object.values(dossiers).filter(d=>!d.archived);
  const filteredDossiers = dossiersActifs.filter(d=>{
    const matchQ = !searchQ||[d.immat,d.info?.client,d.info?.contrat].some(v=>v?.toLowerCase?.().includes(searchQ.toLowerCase()));
    const matchStatut = filterStatut==="tous" || (filterStatut==="retour"&&d.retour&&!d.devis_pending?.length) || (filterStatut==="location"&&!d.retour&&!d.depart?.sansDossier) || (filterStatut==="sans_depart"&&d.depart?.sansDossier&&!d.retour) || (filterStatut==="attente_devis"&&d.devis_pending?.length);
    return matchQ && matchStatut;
  });

  function goHome() { setShowInfoEdit(false); setView("home");setDepStep(0);setRetStep(0);setFoundDossier(null);setOpenZone(null);setSearchDone(false);setVenteImmat("");setVenteSearchDone(false);setEmailClient("");setEmailSent(false);setDepEmailSent(false);setDepEmailSending(false);setDepTests({});setRetTests({});setDepSignature(null);setDepTriPhoto(null);setDepTriFilter(""); }

  // --- Régénération Pro+ d'une photo commerciale sur un dossier déjà terminé (vue rapport) ---
  // Non destructif : on génère un aperçu, et le remplacement n'a lieu qu'après confirmation.
  async function regenerateCommercial(angleKey) {
    if(!activeDossier) return;
    const origUrl = activeDossier.retour?.photos?.[`tour_complet_${angleKey}`]?.[0]?.url;
    if(!origUrl) { alert("Photo d'origine introuvable pour cet angle."); return; }
    setRegenAngle(angleKey);
    try {
      const cutout = await removeBackgroundFromUrl(origUrl);
      if(!cutout) { alert("Échec du détourage (crédits remove.bg insuffisants ou paramètre refusé ?)."); return; }
      const composed = await composeCommercialPhoto(cutout, activeDossier.immat, DELTA_LOGO);
      if(!composed) { alert("Échec de la composition de la photo."); return; }
      setRegenPreview(prev=>({...prev,[angleKey]:composed}));
    } catch(e) {
      console.error("Régénération:", e); alert("Erreur pendant la régénération.");
    } finally { setRegenAngle(null); }
  }

  async function applyRegen(angleKey) {
    const composed = regenPreview[angleKey];
    if(!composed || !activeDossier) return;
    setRegenAngle(angleKey);
    try {
      const url = await uploadDetoureedPhotoToStorage(composed, activeDossier.immat, `tour_complet_${angleKey}`, angleKey, "retour");
      if(!url) return; // uploadDetoureedPhotoToStorage affiche déjà une alerte en cas d'échec
      const updated = {
        ...activeDossier,
        retour: {
          ...activeDossier.retour,
          commercialPhotos: { ...(activeDossier.retour?.commercialPhotos||{}), [angleKey]: { url, type:"storage" } }
        }
      };
      await fbSaveDossier(updated);
      setDossiers(prev=>({...prev,[updated.immat]:updated}));
      setActiveDossier(updated);
      setRegenPreview(prev=>{ const n={...prev}; delete n[angleKey]; return n; });
    } catch(e) {
      console.error("Enregistrement régénération:", e); alert("Erreur à l'enregistrement.");
    } finally { setRegenAngle(null); }
  }

  // Upload brut d'une photo de ventes (habitacles) — indépendant de la vue courante
  async function uploadVenteRaw(file, immat, slotKey) {
    const base64 = await photoToBase64(file);
    const compressed = await compressBase64(base64, 1600, 0.82);
    const timestamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const storagePath = `photos-ventes/${immat}/${slotKey}/${timestamp}_${rand}.jpg`;
    const storageRef = ref(storage, storagePath);
    await uploadString(storageRef, compressed, "data_url");
    return await getDownloadURL(storageRef);
  }

  // Recherche dans l'onglet Photos de ventes : charge le dossier s'il existe
  // ET les photos de ventes "libres" déjà prises pour cette immat (collection photos_ventes).
  async function searchVente() {
    const im = (venteImmat||"").trim().toUpperCase();
    if(!im) return;
    setActiveDossier((await fetchDossier(im))||null);
    setVentePhotosLibres({});
    setVenteSearchDone(true);
    try {
      const snap = await getDoc(doc(db,"photos_ventes",im));
      if(snap.exists()) setVentePhotosLibres(snap.data().photos||{});
    } catch(e) { console.error("Lecture photos_ventes:", e); }
  }

  // Capture d'une photo de ventes. Extérieures détourées Pro+, habitacles brutes.
  // FONCTIONNE MÊME SANS DOSSIER D'EXPERTISE : les photos sont toujours écrites dans
  // la collection photos_ventes/{IMMAT} (lue par Delta VO), et EN PLUS dans
  // retour.commercialPhotos si un dossier existe (compat + resync Delta VO).
  async function captureVentePhoto(slot) {
    const immat = (activeDossier?.immat || venteImmat || "").trim().toUpperCase();
    if(!immat) return;
    const picked = await pickFile({multiple:false});
    if(!picked) return;
    const file = Array.from(picked)[0];
    if(!file) return;
    setVenteBusy(slot.key);
    try {
      let url = null;
      if(slot.detour) {
        const b64 = await photoToBase64(file);
        const removed = await removeBackground(b64);
        if(!removed) throw new Error("Détourage impossible");
        const composed = await composeCommercialPhoto(removed, immat, DELTA_LOGO);
        if(!composed) throw new Error("Composition impossible");
        url = await uploadDetoureedPhotoToStorage(composed, immat, slot.key, slot.key, "retour");
      } else {
        url = await uploadVenteRaw(file, immat, slot.key);
      }
      if(!url) return; // une alerte a déjà été affichée en cas d'échec d'upload

      // 1) TOUJOURS : collection dédiée photos_ventes/{IMMAT} — c'est elle que lit
      //    Delta VO, avec ou sans dossier d'expertise.
      await setDoc(doc(db,"photos_ventes",immat), {
        immat,
        photos: { [slot.key]: { url, type:"storage" } },
        updatedAt: new Date().toISOString(),
        updatedBy: userProfile ? `${userProfile.prenom} ${userProfile.nom}` : (currentUser?.email||"")
      }, { merge:true });
      setVentePhotosLibres(prev=>({ ...prev, [slot.key]: { url, type:"storage" } }));

      // 2) SI un dossier existe : mise à jour classique (rapport + resynchronisation)
      if(activeDossier?.immat) {
        const updated = {
          ...activeDossier,
          retour: {
            ...(activeDossier.retour||{}),
            commercialPhotos: { ...(activeDossier.retour?.commercialPhotos||{}), [slot.key]: { url, type:"storage" } }
          },
          synced_to_delta_vo: false,
          updatedAt: new Date().toISOString()
        };
        await fbSaveDossier(updated);
        setDossiers(prev=>({...prev,[updated.immat]:updated}));
        setActiveDossier(updated);
      }
    } catch(e) {
      console.error("Photo de ventes:", e);
      alert("Erreur photo de ventes : " + e.message);
    } finally {
      setVenteBusy(null);
    }
  }

  function cancelRegen(angleKey) {
    setRegenPreview(prev=>{ const n={...prev}; delete n[angleKey]; return n; });
  }

  // Show loading while checking auth
  if(authLoading) {
    return (
      <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"var(--bg)"}}>
        <style>{css}</style>
        <div style={{textAlign:"center"}}>
          <div className="spinner" style={{margin:"0 auto 16px"}}/>
          <div style={{color:"var(--muted)"}}>Chargement...</div>
        </div>
      </div>
    );
  }

  // Show login page if not authenticated
  if(!currentUser || !userProfile) {
    return (
      <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"linear-gradient(135deg, var(--primary) 0%, #1a3a5c 100%)"}}>
        <style>{css}</style>
        <div style={{maxWidth:400,width:"100%",padding:24}}>
          <div className="card" style={{textAlign:"center",padding:48}}>
            <img src={DELTA_LOGO} alt="Delta Services" style={{height:60,objectFit:"contain",marginBottom:24}}/>
            <div style={{fontFamily:"'Share Tech Mono'",fontSize:20,letterSpacing:2,color:"var(--primary)",marginBottom:8}}>EXPERTISE NACELLE</div>
            <div style={{fontSize:12,color:"var(--muted)",marginBottom:32}}>Système d'expertise PEMP · Delta Services</div>
            
            {!currentUser ? (
              <>
                <button className="btn btn-primary" style={{width:"100%",marginBottom:16}} onClick={handleGoogleLogin}>
                  <span style={{marginRight:8}}>🔐</span>
                  Se connecter avec Google
                </button>
                <div style={{fontSize:11,color:"var(--muted)"}}>
                  Connexion réservée aux utilisateurs autorisés
                </div>
              </>
            ) : (
              <div style={{color:"var(--muted)",fontSize:13}}>
                <div style={{marginBottom:16}}>✉️ {currentUser.email}</div>
                {accessPending ? (
                  <div style={{marginBottom:16,color:"#208040"}}>
                    ✅ Votre demande d'accès a été envoyée.<br/>
                    Vous pourrez vous connecter dès qu'un administrateur l'aura validée.
                  </div>
                ) : (
                  <div style={{marginBottom:16,color:"var(--accent)"}}>
                    ⚠️ Votre compte n'est pas encore autorisé.<br/>
                    Contactez l'administrateur.
                  </div>
                )}
                <button className="btn btn-outline btn-sm" onClick={handleLogout}>
                  Se déconnecter
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{minHeight:"100vh",background:"var(--bg)"}} onClick={openLightboxFromClick}>
      <style>{css}</style>
      <div className="accent-bar"/>
      {uploadingCount > 0 && (
        <div style={{position:"sticky",top:0,zIndex:50,background:"linear-gradient(90deg,#1a2a6e,#c8102e)",color:"#fff",padding:"8px 16px",fontSize:12,fontWeight:700,letterSpacing:1,textAlign:"center",display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
          <div style={{width:14,height:14,border:"2px solid #fff",borderTopColor:"transparent",borderRadius:"50%",animation:"spin 0.8s linear infinite"}}/>
          ENVOI DE {uploadingCount} PHOTO{uploadingCount > 1 ? "S" : ""} EN COURS — NE QUITTEZ PAS LA PAGE
        </div>
      )}
      <div className="header-bar no-print">
        <div style={{display:"flex",alignItems:"center",gap:16,cursor:"pointer"}} onClick={goHome}>
          <img src={DELTA_LOGO} alt="Delta Services" style={{height:38,objectFit:"contain",filter:"brightness(0) invert(1)"}}/>
          <div>
            <div className="header-title" style={{fontFamily:"'Share Tech Mono'",fontSize:15,letterSpacing:3,color:"#fff"}}>EXPERTISE NACELLE</div>
            <div className="header-subtitle" style={{fontSize:10,letterSpacing:2,color:"rgba(255,255,255,.6)",textTransform:"uppercase"}}>Système d'expertise PEMP · Delta Services</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          {userProfile && (
            <div style={{color:"rgba(255,255,255,.8)",fontSize:12,marginRight:8}}>
              👤 {userProfile.prenom} {userProfile.nom}
            </div>
          )}
          <button className="btn btn-icon no-print" style={{color:"#fff",borderColor:"rgba(255,255,255,.3)"}} onClick={()=>{setAdminOpen(true);setAdminAuthed(false);setAdminPwd("");setAdminTab(isSuperAdmin?"zones":"dossiers");}}>⚙</button>
          {view==="home"&&<>
            <button className="btn btn-outline btn-sm" style={{color:"#fff",borderColor:"rgba(255,255,255,.4)"}} onClick={()=>{setView("ventes");setActiveDossier(null);setVenteImmat("");setVenteSearchDone(false);setVentePhotosLibres({});}}>📷 Photos de ventes</button>
            <button className="btn btn-outline btn-sm" style={{color:"#fff",borderColor:"rgba(255,255,255,.4)"}} onClick={()=>{setView("retour");setRetStep(0);setFoundDossier(null);setSearchImmat("");setSearchDone(false);}}>Expertise Retour</button>
            <button className="btn btn-accent btn-sm" onClick={()=>{setView("depart");setDepStep(0);setDepForm({immat:"",numero_cube:"",type_nacelle:"",modele:"",annee_fab:"",client:"",contrat:"",email:"",date:todayISO(),heures:"",km_porteur:"",agent:userProfile ? `${userProfile.prenom} ${userProfile.nom}` : ""});setDepZones({});setDepTests({});setDepPhotos({});setDepSignature(null);}}>+ Nouveau départ</button>
          </>}
          <button className="btn btn-icon no-print" style={{color:"#fff",borderColor:"rgba(255,255,255,.3)"}} onClick={handleLogout} title="Déconnexion">🚪</button>
        </div>
      </div>

      <div style={{maxWidth:840,margin:"0 auto",padding:"22px 16px"}}>

        {/* HOME */}
        {view==="home"&&(
          <div className="fade-in">
            {/* BANDEAU REPRISE BROUILLON */}
            {draftAvailable&&(
              <div style={{marginBottom:16,padding:"14px 18px",background:"linear-gradient(135deg,rgba(26,42,110,.06),rgba(200,16,46,.04))",border:"2px solid var(--primary)",animation:"fadeIn .4s ease"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:700,color:"var(--primary)",marginBottom:4}}>
                      📋 Expertise {draftAvailable.type==="depart"?"DÉPART":"RETOUR"} en cours
                    </div>
                    <div style={{fontSize:12,color:"var(--muted)"}}>
                      {draftAvailable.data.depForm?.immat || draftAvailable.data.foundDossier?.immat || draftAvailable.data.searchImmat || "—"}
                      {draftAvailable.data.depForm?.client ? ` · ${draftAvailable.data.depForm.client}` : ""}
                      {draftAvailable.data.foundDossier?.info?.client ? ` · ${draftAvailable.data.foundDossier.info.client}` : ""}
                      {" · "}Sauvegardé {draftAvailable.data.savedAt ? new Date(draftAvailable.data.savedAt).toLocaleString("fr-FR",{hour:"2-digit",minute:"2-digit",day:"2-digit",month:"2-digit"}) : ""}
                      {draftAvailable.data.photosLost ? " ⚠ (photos à reprendre)" : ""}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button className="btn btn-outline btn-sm" onClick={()=>{clearDraft(draftAvailable.type);setDraftAvailable(null);}}>Abandonner</button>
                    <button className="btn btn-accent btn-sm" onClick={()=>resumeDraft(draftAvailable)}>▶ Reprendre</button>
                  </div>
                </div>
              </div>
            )}
            <div style={{display:"flex",gap:10,marginBottom:18}}>
              {[["Dossiers",dossiersActifs.length,"var(--primary)"],["Retours traités",dossiersActifs.filter(d=>d.retour).length,"var(--ok)"],["En location",dossiersActifs.filter(d=>!d.retour).length,"var(--accent)"]].map(([l,n,c])=>(
                <div key={l} className="card" style={{flex:1,textAlign:"center"}}>
                  <div style={{fontFamily:"'Share Tech Mono'",fontSize:32,color:c,fontWeight:700}}>{n}</div>
                  <div style={{fontSize:10,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginTop:4}}>{l}</div>
                </div>
              ))}
            </div>
            {/* STATS */}
            {showStats&&(
              <div className="card fade-in" style={{marginBottom:18}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                  <div className="section-title" style={{marginBottom:0}}>Statistiques</div>
                  <button className="btn btn-icon" onClick={()=>setShowStats(false)}>✕</button>
                </div>
                {(()=>{
                  const tous=dossiersActifs;
                  const avecRetour=tous.filter(d=>d.retour);
                  const tousDegatIds=avecRetour.flatMap(d=>d.retour?.degats||[]);
                  const montants=avecRetour.map(d=>{const vt=getVetuste(d.info?.annee_fab);return (d.retour?.degats||[]).reduce((s,id)=>{const t=tarifs.find(t=>t.id===id);return s+montantPoste(t,d.retour?.quantites?.[id]||1,vt,d.retour?.montants_devis||{});},0);});
                  const totalGlobal=montants.reduce((s,m)=>s+m,0);
                  const moyenneRetenue=avecRetour.length?Math.round(totalGlobal/avecRetour.length):0;
                  const freqDegats=tousDegatIds.reduce((acc,id)=>{acc[id]=(acc[id]||0)+1;return acc;},{});
                  const top5=Object.entries(freqDegats).sort((a,b)=>b[1]-a[1]).slice(0,5);
                  return (
                    <div>
                      <div className="g3" style={{marginBottom:16}}>
                        {[["Dossiers total",tous.length,"var(--primary)"],["Retours traités",avecRetour.length,"var(--ok)"],["Retenue totale",totalGlobal.toLocaleString("fr-FR")+" €","var(--accent)"],["Retenue moyenne",moyenneRetenue.toLocaleString("fr-FR")+" €","var(--primary)"],["En location",tous.filter(d=>!d.retour).length,"#9a8a2a"],["Taux retour",tous.length?Math.round(avecRetour.length/tous.length*100)+"%":"—","var(--ok)"]].map(([l,v,c])=>(
                          <div key={l} style={{textAlign:"center",padding:"12px 8px",border:"1px solid var(--border)",background:"#f8f9fb"}}>
                            <div style={{fontFamily:"'Share Tech Mono'",fontSize:22,color:c,fontWeight:700}}>{v}</div>
                            <div style={{fontSize:10,letterSpacing:1.5,color:"var(--muted)",textTransform:"uppercase",marginTop:4}}>{l}</div>
                          </div>
                        ))}
                      </div>
                      {top5.length>0&&(
                        <div>
                          <div style={{fontSize:10,letterSpacing:3,color:"var(--primary)",textTransform:"uppercase",marginBottom:10,fontWeight:700}}>Top 5 dégâts les plus fréquents</div>
                          {top5.map(([id,count],i)=>{
                            const t=tarifs.find(t=>t.id===id);
                            const pct=Math.round(count/avecRetour.length*100);
                            return (
                              <div key={id} style={{display:"flex",alignItems:"center",gap:12,marginBottom:8}}>
                                <div style={{width:20,height:20,background:"var(--primary)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,flexShrink:0}}>{i+1}</div>
                                <div style={{flex:1}}>
                                  <div style={{fontSize:13,marginBottom:3}}>{t?.label||id}</div>
                                  <div style={{height:6,background:"var(--border)",borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:"var(--primary)",borderRadius:3}}/></div>
                                </div>
                                <div style={{fontSize:12,color:"var(--primary)",fontWeight:700,minWidth:60,textAlign:"right"}}>{count}× ({pct}%)</div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {top5.length===0&&<div style={{fontSize:13,color:"var(--muted)",textAlign:"center",padding:20}}>Pas encore de données de retour disponibles.</div>}
                    </div>
                  );
                })()}
              </div>
            )}

            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div className="section-title" style={{marginBottom:0}}>Dossiers</div>
              <button className="btn btn-outline btn-sm" onClick={()=>setShowStats(!showStats)}>{showStats?"Masquer":"📊 Statistiques"}</button>
            </div>
            <input placeholder="Rechercher immatriculation, client, contrat..." value={searchQ} onChange={e=>setSearchQ(e.target.value)} style={{marginBottom:10}}/>
            <div style={{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}}>
              {[["tous","Tous",dossiersActifs.length],["location","En location",dossiersActifs.filter(d=>!d.retour&&!d.depart?.sansDossier).length],["retour","Retour traité",dossiersActifs.filter(d=>d.retour&&!d.devis_pending?.length).length],["sans_depart","Sans départ",dossiersActifs.filter(d=>d.depart?.sansDossier&&!d.retour).length],["attente_devis","⏳ En attente de devis",dossiersActifs.filter(d=>d.devis_pending?.length).length]].map(([val,label,count])=>(
                <button key={val} onClick={()=>setFilterStatut(val)} style={{padding:"5px 12px",border:`1px solid ${filterStatut===val?"var(--primary)":"var(--border2)"}`,background:filterStatut===val?"var(--primary)":"#fff",color:filterStatut===val?"#fff":"var(--text)",fontSize:12,fontWeight:filterStatut===val?700:500,cursor:"pointer",fontFamily:"inherit",borderRadius:2,transition:"all .15s"}}>
                  {label} <span style={{opacity:.7}}>({count})</span>
                </button>
              ))}
            </div>
            {loading&&<div style={{textAlign:"center",color:"var(--muted)",padding:40}}>Connexion Firebase...</div>}
            {!loading&&filteredDossiers.length===0&&<div style={{textAlign:"center",color:"var(--muted)",padding:32,border:"1px dashed var(--border)",fontSize:13}}>Aucun dossier</div>}
            {filteredDossiers.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(d=>(
              <div key={d.immat} className="dossier-card" style={{marginBottom:6}} onClick={()=>{setActiveDossier(d);setView("rapport");}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
                    <span className="mono" style={{color:"var(--primary)",fontSize:14,fontWeight:700}}>{d.immat}</span>
                    <span style={{fontSize:13}}>{d.info?.type_nacelle} {d.info?.modele}</span>
                    <span style={{fontSize:12,color:"var(--muted)"}}>{d.info?.client}</span>
                  </div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <span style={{fontSize:11,color:"var(--muted)"}}>{d.depart?.date}</span>
                    <span className={`badge ${d.devis_pending?.length?"badge-warn":d.retour?"badge-ok":d.depart?.sansDossier?"badge-danger":"badge-warn"}`}>{d.devis_pending?.length?"⏳ Attente devis":d.retour?"Retour traité":d.depart?.sansDossier?"Sans départ":"En location"}</span>
                  </div>
                </div>
              </div>
            ))}
            {/* Pagination : les dossiers plus anciens se chargent à la demande */}
            {hasMoreDossiers && (
              <div style={{textAlign:"center",marginTop:12}}>
                <button className="btn btn-outline" onClick={loadMoreDossiers} disabled={loadingMore}>
                  {loadingMore ? "⏳ Chargement..." : "Voir plus de dossiers ↓"}
                </button>
                <div style={{fontSize:11,color:"var(--muted)",marginTop:4}}>
                  {Object.keys(dossiers).length} dossier(s) chargé(s) — les plus récents d'abord. La recherche par immatriculation trouve aussi les anciens dossiers.
                </div>
              </div>
            )}
          </div>
        )}

        {/* DÉPART */}
        {view==="depart"&&(
          <div className="fade-in">
            <div className="step-row" style={{display:"flex",gap:4,marginBottom:20,alignItems:"center"}}>
              {["Informations","État zones","Rapport"].map((s,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:4}}>
                  <div style={{padding:"4px 14px",background:i===depStep?"var(--primary)":i<depStep?"rgba(26,42,110,.15)":"var(--bg3)",color:i===depStep?"#fff":i<depStep?"var(--primary)":"var(--muted)",fontSize:11,letterSpacing:1.5,textTransform:"uppercase",fontWeight:700}}>{s}</div>
                  {i<2&&<div style={{width:16,height:2,background:"var(--border2)"}}/>}
                </div>
              ))}
            </div>

            {depStep===0&&(
              <div>
                <div className="section-title">Identification nacelle</div>
                <div className="card" style={{marginBottom:14}}>
                  <div className="g3" style={{marginBottom:12}}>
                    {/* Pré-remplissage automatique : si un dossier existe déjà pour cette immat
                        (infos ADV poussées par Delta VO, ou cycle précédent), les champs vides
                        client / contrat / email / modèle... sont remplis automatiquement. */}
                    <div><label>Immatriculation *</label><input value={depForm.immat} onChange={e=>{
                      const immat = normalizeImmat(e.target.value);
                      // Pré-remplit les champs VIDES depuis le dossier existant (infos ADV
                      // Delta VO ou cycle précédent). Le dossier est cherché sur le serveur
                      // s'il n'est pas dans les pages chargées (pagination).
                      // fresh=true : données relues sur le serveur → PRIORITAIRES
                      // (le pré-départ Delta VO vient d'y écrire le NOUVEL acheteur ;
                      // la copie en mémoire peut dater d'avant et montrer l'ancien client)
                      const applyPrefill = (d, fresh) => {
                        if (!d?.info) return;
                        const i = d.info;
                        setDepForm(f => f.immat === immat ? ({
                          ...f,
                          client: fresh ? (i.client || f.client || "") : (f.client || i.client || ""),
                          contrat: fresh ? (i.contrat || f.contrat || "") : (f.contrat || i.contrat || ""),
                          email: fresh ? (i.email || f.email || "") : (f.email || i.email || ""),
                          type_nacelle: f.type_nacelle || i.type_nacelle || "",
                          modele: f.modele || i.modele || "",
                          annee_fab: f.annee_fab || i.annee_fab || "",
                          numero_cube: f.numero_cube || i.numero_cube || "",
                        }) : f);
                      };
                      setDepForm(f=>({...f, immat}));
                      if (dossiers[immat]) applyPrefill(dossiers[immat], false);
                      // Immat complète → on relit TOUJOURS le dossier à jour sur le serveur
                      if (/^[A-Z]{2}-[0-9]{3}-[A-Z]{2}$/.test(immat)) fetchDossier(immat).then(d => {
                        if (!d) return;
                        applyPrefill(d, true);
                        setDossiers(prev => ({ ...prev, [immat]: d })); // rafraîchit la copie locale
                      });
                    }} placeholder="AB-123-CD"/></div>
                    <div><label>Type nacelle</label><TypeNacelleSelect value={depForm.type_nacelle} onChange={v=>setDepForm({...depForm,type_nacelle:v})} types={typesNacelle}/></div>
                    <div><label>Modèle porteur</label><input value={depForm.modele} onChange={e=>setDepForm({...depForm,modele:e.target.value})} placeholder="HA 16 PX"/></div>
                  </div>
                  <div className="g3" style={{marginBottom:12}}>
                    <div><label>Date mise en circulation</label><input type="text" value={depForm.annee_fab} onChange={e=>setDepForm({...depForm,annee_fab:e.target.value})} placeholder="JJ/MM/AAAA"/></div>
                    <div><label>N° Contrat</label><input value={depForm.contrat} onChange={e=>setDepForm({...depForm,contrat:e.target.value})} placeholder="CTR-2024-055"/></div>
                  </div>
                  <div className="g3" style={{marginBottom:12}}>
                    <div><label>Client</label><input value={depForm.client} onChange={e=>setDepForm({...depForm,client:e.target.value})} placeholder="Utilisateur / locataire"/></div>
                    <div><label>Email client</label><input type="email" value={depForm.email} onChange={e=>setDepForm({...depForm,email:e.target.value})} placeholder="client@email.com"/></div>
                    <div><label>Heures nacelle</label><input type="number" value={depForm.heures} onChange={e=>setDepForm({...depForm,heures:e.target.value})} placeholder="1 240"/></div>
                  </div>
                  <div className="g3" style={{marginBottom:12}}>
                    <div><label>Km porteur</label><input type="number" value={depForm.km_porteur} onChange={e=>setDepForm({...depForm,km_porteur:e.target.value})} placeholder="45 000"/></div>
                  </div>
                  <div className="g2">
                    <div><label>Date départ</label><input type="date" value={depForm.date} onChange={e=>setDepForm({...depForm,date:e.target.value})}/></div>
                    <div><label>Agent expert</label><input value={depForm.agent} onChange={e=>setDepForm({...depForm,agent:e.target.value})} placeholder="Prénom Nom"/></div>
                  </div>
                </div>
                <div style={{display:"flex",justifyContent:"space-between"}}>
                  <button className="btn btn-outline" onClick={goHome}>← Annuler</button>
                  <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:6}}>
                    {!depForm.immat&&<div style={{fontSize:11,color:"var(--accent)"}}>⚠ L'immatriculation est obligatoire</div>}
                    <button className="btn btn-gold" disabled={!depForm.immat} onClick={()=>setDepStep(1)}>Suivant →</button>
                  </div>
                </div>
              </div>
            )}

            {depStep===1&&(
              <div>
                <TestNacelle tests={depTests} onChange={setDepTests} />
                {/* Import de photos en lot — départ */}
                <div className="card" style={{marginBottom:14,border:"2px dashed var(--border2)",background:"#f8f9fb"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
                    <div>
                      <div style={{fontSize:11,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",fontWeight:700}}>📥 Import de photos en lot</div>
                      <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>Importez toutes vos photos d'un coup, puis touchez chaque photo pour l'affecter à une section ou un angle du tour.</div>
                    </div>
                    <button className="btn btn-gold btn-sm" onClick={async()=>{const f=await pickFile({multiple:true});if(f) addPhotos(f,"a_trier",setDepPhotos);}}>+ Importer des photos</button>
                  </div>
                  {(depPhotos["a_trier"]||[]).length>0&&(
                    <div style={{marginTop:12}}>
                      <div style={{fontSize:10,letterSpacing:1.5,color:"var(--accent)",textTransform:"uppercase",fontWeight:700,marginBottom:8}}>{depPhotos["a_trier"].length} photo{depPhotos["a_trier"].length>1?"s":""} à trier — touchez une photo pour l'affecter</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                        {depPhotos["a_trier"].map((p,i)=>(
                          <div key={i} className="no-lightbox" style={{position:"relative",cursor:"pointer",border:"2px solid var(--accent)"}} onClick={()=>{setDepTriPhoto(i);setDepTriFilter("");}}>
                            <img src={p.url} alt="" style={{width:100,height:74,objectFit:"cover",display:"block"}}/>
                            <div style={{position:"absolute",bottom:0,left:0,right:0,background:"rgba(200,16,46,.85)",color:"#fff",fontSize:9,textAlign:"center",padding:"2px 0",letterSpacing:1,fontWeight:700}}>AFFECTER →</div>
                            <button className="btn btn-danger" onClick={(e)=>{e.stopPropagation();removePhoto("a_trier",i,setDepPhotos);}} style={{position:"absolute",top:2,right:2,padding:"2px 5px",fontSize:9}}>✕</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Modal d'affectation d'une photo à trier — départ */}
                {depTriPhoto!==null&&(depPhotos["a_trier"]||[])[depTriPhoto]&&(
                  <div className="modal-overlay" onClick={()=>{setDepTriPhoto(null);setDepTriFilter("");}}>
                    <div className="modal" onClick={e=>e.stopPropagation()}>
                      <div style={{display:"flex",gap:14,alignItems:"center",marginBottom:14}}>
                        <img src={depPhotos["a_trier"][depTriPhoto].url} alt="" style={{width:110,height:80,objectFit:"cover",border:"1px solid var(--border2)",flexShrink:0}}/>
                        <div>
                          <div style={{fontSize:12,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",fontWeight:700}}>Affecter cette photo</div>
                          <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>Choisissez une section, un angle du tour ou les photos supplémentaires.</div>
                        </div>
                      </div>
                      <input value={depTriFilter} onChange={e=>setDepTriFilter(e.target.value)} placeholder="🔍 Rechercher (ex: gyro, bac, phare...)" style={{marginBottom:10}}/>
                      <div style={{maxHeight:"46vh",overflowY:"auto"}}>
                        {"photos supplémentaires".includes(depTriFilter.toLowerCase())&&(
                          <div className="tarif-row" onClick={()=>assignDepPendingPhoto(depTriPhoto,"photos_supplementaires")}>
                            <span style={{fontSize:13}}>🖼 Photos supplémentaires <span style={{color:"var(--muted)",fontSize:11}}>(hors sections)</span></span>
                          </div>
                        )}
                        {TOUR_ANGLES.filter(a=>!depPhotos[`tour_complet_${a.key}`]?.[0]&&(`tour complet ${a.label}`.toLowerCase().includes(depTriFilter.toLowerCase()))).map(a=>(
                          <div key={a.key} className="tarif-row" onClick={()=>assignDepPendingPhoto(depTriPhoto,`tour_complet_${a.key}`)}>
                            <span style={{fontSize:13}}>📷 Tour complet — {a.label}</span>
                          </div>
                        ))}
                        {zones.filter(z=>z.id!=="tour_complet"&&(!depTriFilter||z.label.toLowerCase().includes(depTriFilter.toLowerCase()))).map(z=>(
                          <div key={z.id} className="tarif-row" onClick={()=>assignDepPendingPhoto(depTriPhoto,z.id)}>
                            <span style={{fontSize:13}}>{z.icon} {z.label}</span>
                          </div>
                        ))}
                      </div>
                      <div style={{display:"flex",justifyContent:"flex-end",marginTop:12}}>
                        <button className="btn btn-outline btn-sm" onClick={()=>{setDepTriPhoto(null);setDepTriFilter("");}}>Annuler</button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="section-title">État des zones</div>
                {zones.map(zone=>(
                  <div key={zone.id} className="zone-row">
                    <div className="zone-header" onClick={()=>setOpenZone(openZone===zone.id?null:zone.id)}>
                      <div style={{display:"flex",alignItems:"center",gap:10}}>
                        <span style={{color:"var(--primary)",fontSize:18,width:24}}>{zone.icon}</span>
                        <span style={{fontWeight:600}}>{zone.label}</span>
                      </div>
                      <div style={{display:"flex",gap:8,alignItems:"center"}}>
                        {depZones[zone.id]?.etat&&<span className="etat-tag" style={{background:ETAT_COLORS[depZones[zone.id].etat]+"22",color:ETAT_COLORS[depZones[zone.id].etat],border:`1px solid ${ETAT_COLORS[depZones[zone.id].etat]}44`}}>{depZones[zone.id].etat}</span>}
                        {zone.id==="tour_complet"&&TOUR_ANGLES.filter(a=>depPhotos[`tour_complet_${a.key}`]?.[0]).length>0&&<span className="badge badge-ok">{TOUR_ANGLES.filter(a=>depPhotos[`tour_complet_${a.key}`]?.[0]).length}/4</span>}
                        {zone.id!=="tour_complet"&&depPhotos[zone.id]?.length>0&&<span className="badge badge-ok">{depPhotos[zone.id].length} photo{depPhotos[zone.id].length>1?"s":""}</span>}
                        <span style={{color:"var(--muted)"}}>{openZone===zone.id?"▲":"▼"}</span>
                      </div>
                    </div>
                    {openZone===zone.id&&(
                      <div className="zone-body">
                        {zone.id==="tour_complet"?(
                          <div>
                            <div style={{fontSize:11,color:"var(--muted)",marginBottom:14}}>Photographiez la nacelle sous les 4 angles standards.</div>
                            {TOUR_ANGLES.map((angle,idx)=>{
                              const key=`tour_complet_${angle.key}`; const photo=depPhotos[key]?.[0];
                              return (
                                <div key={angle.key} style={{marginBottom:12,padding:"12px 14px",border:"1px solid var(--border)",background:"#f8f9fb"}}>
                                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                                      <div style={{width:24,height:24,background:"var(--primary)",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,fontWeight:700}}>{idx+1}</div>
                                      <span style={{fontWeight:600,fontSize:14,color:"var(--primary)"}}>{angle.label}</span>
                                    </div>
                                    {photo&&<span className="badge badge-ok">✓</span>}
                                  </div>
                                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                                    {photo?(<div style={{position:"relative"}}><img src={photo.url} alt="" style={{width:120,height:88,objectFit:"cover",border:"1px solid var(--border2)",cursor:"zoom-in"}}/><button className="btn" title="Pivoter 90°" disabled={rotatingKey===key+"_"+0} onClick={(e)=>{rotatePhotoAt(depPhotos,key,0,setDepPhotos);}} style={{position:"absolute",top:2,left:2,padding:"2px 4px",fontSize:9,background:"rgba(255,255,255,.92)",border:"1px solid var(--border2)",color:"var(--primary)"}}>{rotatingKey===key+"_"+0?"…":"↻"}</button><button className="btn btn-danger" onClick={()=>removePhoto(key,0,setDepPhotos)} style={{position:"absolute",top:2,right:2,padding:"2px 5px",fontSize:10}}>✕</button></div>):(<div className="photo-add" style={{width:120,height:88}} onClick={async()=>{
  const f=await pickFile({multiple:false});
  if(!f) return;
  await addPhotos(f,key,setDepPhotos);
}}>+</div>)}
                                    <div style={{flex:1}}>
                                      <div style={{fontSize:11,color:"var(--muted)",lineHeight:1.6,marginBottom:6}}>{angle.key==="av_droit"?"Avant droit, ~5m":angle.key==="av_gauche"?"Avant gauche, ~5m":angle.key==="ar_gauche"?"Arrière gauche, ~5m":"Arrière droit, ~5m"}</div>

                                    </div>
                                  </div>

                                </div>
                              );
                            })}
                          </div>
                        ):(
                          <div>
                            <div className="g2" style={{marginBottom:12}}>
                              <div><label>État constaté</label>
                                <select value={depZones[zone.id]?.etat||""} onChange={e=>setZE(setDepZones,zone.id,e.target.value)}>
                                  <option value="">-- Sélectionner --</option>
                                  {ETAT_OPTIONS.map(o=><option key={o}>{o}</option>)}
                                </select>
                              </div>
                              <div><label>Observation</label><input value={depZones[zone.id]?.note||""} onChange={e=>setZN(setDepZones,zone.id,e.target.value)} placeholder="Détail..."/></div>
                            </div>
                            <label>Photos</label>
                            <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                              {(depPhotos[zone.id]||[]).map((p,i)=>(<div key={i} style={{position:"relative"}}><img src={p.url} alt="" className="photo-thumb"/><button className="btn" title="Pivoter 90°" disabled={rotatingKey===zone.id+"_"+i} onClick={(e)=>{rotatePhotoAt(depPhotos,zone.id,i,setDepPhotos);}} style={{position:"absolute",top:2,left:2,padding:"2px 4px",fontSize:9,background:"rgba(255,255,255,.92)",border:"1px solid var(--border2)",color:"var(--primary)"}}>{rotatingKey===zone.id+"_"+i?"…":"↻"}</button><button className="btn btn-danger" onClick={()=>removePhoto(zone.id,i,setDepPhotos)} style={{position:"absolute",top:2,right:2,padding:"2px 4px",fontSize:9}}>✕</button></div>))}
                              <div className="photo-add" onClick={async()=>{const files=await pickFile({multiple:true});if(files) addPhotos(files,zone.id,setDepPhotos);}}>+</div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                <div className="zone-row" style={{marginTop:10}}>
                  <div className="zone-header" onClick={()=>setOpenZone(openZone==="photos_supplementaires"?null:"photos_supplementaires")}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <span style={{color:"var(--primary)",fontSize:18,width:24}}>🖼</span>
                      <span style={{fontWeight:600}}>Photos supplémentaires</span>
                      <span style={{fontSize:11,color:"var(--muted)"}}>— hors sections</span>
                    </div>
                    <div style={{display:"flex",gap:8,alignItems:"center"}}>
                      {(depPhotos["photos_supplementaires"]||[]).length>0&&<span className="badge badge-ok">{depPhotos["photos_supplementaires"].length} photo{depPhotos["photos_supplementaires"].length>1?"s":""}</span>}
                      <span style={{color:"var(--muted)"}}>{openZone==="photos_supplementaires"?"▲":"▼"}</span>
                    </div>
                  </div>
                  {openZone==="photos_supplementaires"&&(
                    <div className="zone-body">
                      <div style={{fontSize:11,color:"var(--muted)",marginBottom:10}}>Ajoutez ici toute photo qui ne concerne pas les sections ci-dessus. Vous pouvez en sélectionner plusieurs d'un coup.</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                        {(depPhotos["photos_supplementaires"]||[]).map((p,i)=>(<div key={i} style={{position:"relative"}}><img src={p.url} alt="" className="photo-thumb"/><button className="btn" title="Pivoter 90°" disabled={rotatingKey==="photos_supplementaires"+"_"+i} onClick={(e)=>{rotatePhotoAt(depPhotos,"photos_supplementaires",i,setDepPhotos);}} style={{position:"absolute",top:2,left:2,padding:"2px 4px",fontSize:9,background:"rgba(255,255,255,.92)",border:"1px solid var(--border2)",color:"var(--primary)"}}>{rotatingKey==="photos_supplementaires"+"_"+i?"…":"↻"}</button><button className="btn btn-danger" onClick={()=>removePhoto("photos_supplementaires",i,setDepPhotos)} style={{position:"absolute",top:2,right:2,padding:"2px 4px",fontSize:9}}>✕</button></div>))}
                        <div className="photo-add" onClick={async()=>{const f=await pickFile({multiple:true});if(f) addPhotos(f,"photos_supplementaires",setDepPhotos);}}>+</div>
                      </div>
                    </div>
                  )}
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:14}}>
                  <button className="btn btn-outline" onClick={()=>setDepStep(0)}>← Retour</button>
                  <button className="btn btn-gold" onClick={()=>setDepStep(2)}>Prévisualiser →</button>
                </div>
              </div>
            )}

            {depStep===2&&(
              <div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                  <div className="section-title" style={{marginBottom:0}}>Rapport état départ</div>
                  <div style={{display:"flex",gap:8}}>
                    <button className="btn btn-outline btn-sm no-print" onClick={()=>window.print()}>⬇ PDF</button>
                    {depForm.email && (
                      <button className="btn btn-blue btn-sm no-print" disabled={depEmailSending} onClick={sendDepartEmail}>{depEmailSending?"⏳ Envoi…":depEmailSent?"✓ Envoyé — renvoyer":"📧 Envoyer au client"}</button>
                    )}
                    <button className="btn btn-gold" onClick={validerDepart} disabled={!depForm.immat || uploadingCount > 0}>{uploadingCount > 0 ? `⏳ Upload en cours (${uploadingCount})` : "✓ Valider & sauvegarder"}</button>
                  </div>
                </div>
                <div className="card" style={{marginBottom:10}}>
                  <div className="g3">
                    {[["Immatriculation",depForm.immat],["Type nacelle",depForm.type_nacelle],["Modèle porteur",depForm.modele],["Mise en circulation",depForm.annee_fab],["Client",depForm.client],["Contrat",depForm.contrat],["Email",depForm.email],["Date",depForm.date],["Heures nacelle",depForm.heures?depForm.heures+" h":"—"],["Km porteur",depForm.km_porteur?depForm.km_porteur+" km":"—"],["Agent",depForm.agent]].map(([k,v])=>(
                      <div key={k} style={{marginBottom:6}}><div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:2}}>{k}</div><div style={{fontSize:13,fontWeight:600}}>{v||"—"}</div></div>
                    ))}
                  </div>
                </div>
                <TestNacelleSummary tests={depTests} />
                {zones.map(zone=>{
                  const z=depZones[zone.id]; const photos=depPhotos[zone.id]||[];
                  const tourPhotos=zone.id==="tour_complet"?TOUR_ANGLES.map(a=>({angle:a,photo:depPhotos[`tour_complet_${a.key}`]?.[0]})).filter(x=>x.photo):[];
                  const hasPhotos=zone.id==="tour_complet"?tourPhotos.length>0:photos.length>0;
                  return (
                    <div key={zone.id} style={{marginBottom:5,border:"1px solid var(--border)",padding:"10px 14px",background:"#fff"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                        <div style={{display:"flex",gap:10,alignItems:"center"}}>
                          <span style={{color:"var(--primary)"}}>{zone.icon}</span>
                          <span style={{fontWeight:600}}>{zone.label}</span>
                          {z?.note&&<span style={{fontSize:12,color:"var(--muted)"}}>— {z.note}</span>}
                        </div>
                        <div style={{display:"flex",gap:8}}>
                          {hasPhotos&&<span className="badge badge-ok">{zone.id==="tour_complet"?tourPhotos.length:photos.length} photo{(zone.id==="tour_complet"?tourPhotos.length:photos.length)>1?"s":""}</span>}
                          {z?.etat?<span className="etat-tag" style={{background:ETAT_COLORS[z.etat]+"22",color:ETAT_COLORS[z.etat],border:`1px solid ${ETAT_COLORS[z.etat]}44`}}>{z.etat}</span>:<span style={{fontSize:11,color:"var(--muted)"}}>{zone.id==="tour_complet"?"":"Non renseigné"}</span>}
                        </div>
                      </div>
                      {zone.id==="tour_complet"&&tourPhotos.length>0&&(<div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:10}}>{tourPhotos.map(({angle,photo})=>(<div key={angle.key} style={{textAlign:"center"}}><img src={photo.url} alt="" className="photo-thumb"/><div style={{fontSize:9,color:"var(--muted)",marginTop:3}}>{angle.label}</div></div>))}</div>)}
                      {zone.id!=="tour_complet"&&photos.length>0&&(<div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:8}}>{photos.map((p,i)=><img key={i} src={p.url} alt="" className="photo-thumb"/>)}</div>)}
                    </div>
                  );
                })}
                {(depPhotos["photos_supplementaires"]||[]).length>0&&(
                  <div style={{marginBottom:5,border:"1px solid var(--border)",padding:"10px 14px",background:"#fff"}}>
                    <div style={{display:"flex",gap:10,alignItems:"center"}}>
                      <span style={{color:"var(--primary)"}}>🖼</span>
                      <span style={{fontWeight:600}}>Photos supplémentaires</span>
                      <span className="badge badge-ok">{depPhotos["photos_supplementaires"].length} photo{depPhotos["photos_supplementaires"].length>1?"s":""}</span>
                    </div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:8}}>{depPhotos["photos_supplementaires"].map((p,i)=><img key={i} src={p.url} alt="" className="photo-thumb"/>)}</div>
                  </div>
                )}
                {/* Signature client (optionnelle) — le canvas ne s'imprime pas, l'image enregistrée oui */}
                <div className="card" style={{marginTop:14}}>
                  <div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:8}}>Signature client — état de départ</div>
                  <div className="no-print">
                    <div style={{fontSize:11,color:"var(--muted)",marginBottom:8}}>Faites signer le client dans le cadre ci-dessous (au doigt sur téléphone/tablette). Optionnel.</div>
                    <SignaturePad value={depSignature} onChange={setDepSignature}/>
                  </div>
                  {depSignature&&(
                    <div style={{marginTop:8}}>
                      <img src={depSignature} alt="Signature client" className="no-lightbox" style={{maxWidth:260,border:"1px solid var(--border)",background:"#fff"}}/>
                      <div style={{fontSize:11,color:"var(--muted)",marginTop:4}} className="no-print">Signature enregistrée — elle sera jointe au dossier à la validation.</div>
                    </div>
                  )}
                </div>
                <div className="card no-print" style={{marginTop:14}}>
                  <label>Email client — pour envoi de l'état de départ</label>
                  <input type="email" value={depForm.email} onChange={e=>setDepForm({...depForm,email:e.target.value})} placeholder="client@email.com" style={{marginBottom:8}}/>
                </div>
                {/* Barre d'actions FINALE — là où l'expert termine (après la signature) :
                    envoi du rapport de départ au client, puis validation. */}
                <div className="no-print" style={{marginTop:14,display:"flex",justifyContent:"space-between",gap:8,flexWrap:"wrap"}}>
                  <button className="btn btn-outline" onClick={()=>setDepStep(1)}>← Modifier</button>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    <button className="btn btn-blue" disabled={depEmailSending} onClick={sendDepartEmail}>{depEmailSending?"⏳ Envoi…":depEmailSent?"✓ Envoyé — renvoyer":"📧 Envoyer le rapport de départ"}</button>
                    <button className="btn btn-gold" onClick={validerDepart} disabled={!depForm.immat || uploadingCount > 0}>{uploadingCount > 0 ? `⏳ Upload en cours (${uploadingCount})` : "✓ Valider & sauvegarder"}</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* RETOUR */}
        {view==="retour"&&(
          <div className="fade-in">
            {retStep===0&&(
              <div>
                <div className="section-title">Recherche dossier départ</div>
                <div className="card" style={{marginBottom:14}}>
                  <label>Immatriculation nacelle</label>
                  <div style={{display:"flex",gap:8}}>
                    <input value={searchImmat} onChange={e=>{setSearchImmat(normalizeImmat(e.target.value));setSearchDone(false);}} placeholder="AB-123-CD" style={{flex:1}} onKeyDown={e=>{if(e.key==="Enter"){fetchDossier(searchImmat).then(d=>{setFoundDossier(d||null);setSearchDone(true);});}}}/>
                    <button className="btn btn-gold" onClick={()=>{fetchDossier(searchImmat).then(d=>{setFoundDossier(d||null);setSearchDone(true);});}}>Rechercher</button>
                  </div>
                </div>
                {searchDone&&!foundDossier&&(
                  <div style={{marginBottom:14}}>
                    <div style={{color:"var(--accent)",fontSize:13,padding:"10px 14px",border:"1px solid rgba(200,16,46,.3)",background:"rgba(200,16,46,.06)",marginBottom:10}}>
                      Aucun dossier départ pour « {searchImmat} »
                    </div>
                    <div style={{padding:"16px",border:"2px dashed var(--border2)",background:"#f8f9fb"}}>
                      <div style={{fontSize:13,fontWeight:600,color:"var(--primary)",marginBottom:6}}>Retour sans dossier départ</div>
                      <div style={{fontSize:12,color:"var(--muted)",marginBottom:12}}>Aucun état de départ disponible. Vous devrez remplir les informations du véhicule.</div>
                      {!searchImmat.trim() && <div style={{color:"var(--accent)",fontSize:12,marginBottom:8}}>⚠ Saisissez d'abord l'immatriculation ci-dessus.</div>}
                      <button className="btn btn-accent" disabled={!searchImmat.trim()} onClick={()=>{
                        // Préparer le formulaire pour remplir les infos manquantes
                        setRetForm({...retForm, immat:searchImmat, date:todayISO(), agent:userProfile ? `${userProfile.prenom} ${userProfile.nom}` : ""});
                        setRetStep(0.5); // Étape intermédiaire pour remplir les infos
                      }}>+ Créer retour sans départ</button>
                    </div>
                  </div>
                )}
                {foundDossier&&(
                  <div>
                    <div className="card" style={{marginBottom:14,border:"2px solid var(--primary)"}}>
                      <div style={{fontSize:10,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",marginBottom:10,fontWeight:700}}>Dossier trouvé</div>
                      <div className="g3">
                        {[["Immatriculation",foundDossier.immat],["N° de cube",foundDossier.info?.numero_cube],["Type nacelle",foundDossier.info?.type_nacelle],["Modèle porteur",foundDossier.info?.modele],["Client",foundDossier.info?.client],["Contrat",foundDossier.info?.contrat],["Départ",foundDossier.depart?.date],["Mise en circulation",foundDossier.info?.annee_fab],["Heures départ",foundDossier.depart?.heures?foundDossier.depart.heures+" h":"—"],["Km porteur départ",foundDossier.depart?.km_porteur?foundDossier.depart.km_porteur+" km":"—"]].map(([k,v])=>(
                          <div key={k}><div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:2}}>{k}</div><div style={{fontSize:13,fontWeight:600}}>{v||"—"}</div></div>
                        ))}
                      </div>
                      {foundDossier.info?.annee_fab&&(()=>{ const t=getVetuste(foundDossier.info.annee_fab); return t!==0?(<div style={{marginTop:10,padding:"8px 12px",background:"rgba(200,16,46,.06)",color:"var(--accent)",fontSize:12,fontWeight:600}}>⚖ Taux de vétusté : {t}% (nacelle de {foundDossier.info.annee_fab} — {new Date().getFullYear()-parseInt(foundDossier.info.annee_fab)} an{new Date().getFullYear()-parseInt(foundDossier.info.annee_fab)>1?"s":""})</div>):null; })()}
                      {foundDossier.retour&&(
                        <div style={{marginTop:10,padding:"10px 12px",background:"rgba(26,42,110,.05)",border:"1px solid rgba(26,42,110,.2)"}}>
                          <div style={{fontSize:12,color:"var(--primary)",fontWeight:600,marginBottom:8}}>✓ Une expertise retour validée existe déjà pour ce dossier ({foundDossier.retour.date||"date inconnue"}).</div>
                          <button className="btn btn-gold btn-sm" onClick={()=>editRetour(foundDossier)}>✎ Modifier l'expertise existante (ajouter photos, corriger)</button>
                          <div style={{fontSize:11,color:"var(--muted)",marginTop:8}}>Ou démarrez une nouvelle expertise ci-dessous : l'ancienne sera écrasée et repartira de zéro.</div>
                        </div>
                      )}
                    </div>
                    <div className="card" style={{marginBottom:14}}>
                      <div className="g2" style={{marginBottom:12}}>
                        <div><label>N° de cube *</label><input value={retForm.numero_cube||""} onChange={e=>setRetForm({...retForm,numero_cube:e.target.value.toUpperCase()})} placeholder="Ex : C12345"/></div>
                        <div><label>Date retour</label><input type="date" value={retForm.date} onChange={e=>setRetForm({...retForm,date:e.target.value})}/></div>
                      </div>
                      <div className="g2" style={{marginBottom:12}}>
                        <div><label>Agent expert</label><input value={retForm.agent} onChange={e=>setRetForm({...retForm,agent:e.target.value})} placeholder="Prénom Nom"/></div>
                        <div><label>Lieu de restitution *</label>
                          <select value={retForm.lieu_restitution||""} onChange={e=>setRetForm({...retForm,lieu_restitution:e.target.value})}>
                            <option value="">-- Sélectionner --</option>
                            {LIEUX_RESTITUTION.map(l=><option key={l}>{l}</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="g2">
                        <div><label>Heures nacelle retour</label><input type="number" value={retForm.heures} onChange={e=>setRetForm({...retForm,heures:e.target.value})} placeholder="1 380"/></div>
                        <div><label>Km porteur retour</label><input type="number" value={retForm.km_porteur} onChange={e=>setRetForm({...retForm,km_porteur:e.target.value})} placeholder="47 000"/></div>
                      </div>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <button className="btn btn-outline" onClick={()=>{setFoundDossier(null);setSearchImmat("");setSearchDone(false);}}>← Annuler</button>
                      <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:6}}>
                        {!retForm.numero_cube&&<div style={{fontSize:11,color:"var(--accent)"}}>⚠ Le N° de cube est obligatoire</div>}
                        {!retForm.lieu_restitution&&<div style={{fontSize:11,color:"var(--accent)"}}>⚠ Le lieu de restitution est obligatoire</div>}
                        <button className="btn btn-gold" disabled={!retForm.numero_cube||!retForm.lieu_restitution} onClick={()=>{setRetZones({});setRetTests({});setRetPhotos({});setRetDegats([]);setRetQtes({});setRetMontantsDevis({});setRetTranchesDevis({});setRetNote("");setEmailClient(foundDossier?.info?.email||"");setEmailSent(false);setRetStep(1);}}>Démarrer expertise retour →</button>
                      </div>
                    </div>
                  </div>
                )}
                {!foundDossier&&<div style={{marginTop:8}}><button className="btn btn-outline" onClick={goHome}>← Accueil</button></div>}
              </div>
            )}

            {retStep===0.5&&(
              <div>
                <div className="section-title">Informations du véhicule</div>
                <div className="card" style={{marginBottom:14}}>
                  <div style={{fontSize:12,color:"var(--muted)",marginBottom:14}}>
                    Aucun dossier départ n'existe. Veuillez renseigner les informations du véhicule.
                  </div>
                  
                  <div className="g2" style={{marginBottom:12}}>
                    <div><label>N° de cube *</label><input value={retForm.numero_cube||""} onChange={e=>setRetForm({...retForm,numero_cube:e.target.value.toUpperCase()})} placeholder="Ex : C12345"/></div>
                    <div><label>Type nacelle *</label><TypeNacelleSelect value={retForm.type_nacelle||""} onChange={v=>setRetForm(f=>({...f,type_nacelle:v}))} types={typesNacelle}/></div>
                  </div>
                  
                  <div className="g2" style={{marginBottom:12}}>
                    <div><label>Modèle porteur *</label><input value={retForm.modele||""} onChange={e=>setRetForm({...retForm,modele:e.target.value})} placeholder="Iveco Daily"/></div>
                    <div><label>Année de mise en circulation</label><input type="number" value={retForm.annee_fab||""} onChange={e=>setRetForm({...retForm,annee_fab:e.target.value})} placeholder="2015"/></div>
                  </div>
                  
                  <div className="g2" style={{marginBottom:12}}>
                    <div><label>Client *</label><input value={retForm.client||""} onChange={e=>setRetForm({...retForm,client:e.target.value})} placeholder="Utilisateur / locataire"/></div>
                    <div><label>Numéro de contrat</label><input value={retForm.contrat||""} onChange={e=>setRetForm({...retForm,contrat:e.target.value})} placeholder="CTR-2024-001"/></div>
                  </div>
                  
                  <div className="g2" style={{marginBottom:12}}>
                    <div><label>Email client</label><input type="email" value={retForm.email||""} onChange={e=>setRetForm({...retForm,email:e.target.value})} placeholder="client@exemple.fr"/></div>
                    <div><label>Date retour</label><input type="date" value={retForm.date} onChange={e=>setRetForm({...retForm,date:e.target.value})}/></div>
                  </div>

                  <div className="g2" style={{marginBottom:12}}>
                    <div><label>Heures nacelle retour</label><input type="number" value={retForm.heures||""} onChange={e=>setRetForm({...retForm,heures:e.target.value})} placeholder="1 380"/></div>
                    <div><label>Km porteur retour</label><input type="number" value={retForm.km_porteur||""} onChange={e=>setRetForm({...retForm,km_porteur:e.target.value})} placeholder="47 000"/></div>
                  </div>
                  
                  <div className="g2" style={{marginBottom:12}}>
                    <div><label>Lieu de restitution *</label>
                      <select value={retForm.lieu_restitution||""} onChange={e=>setRetForm({...retForm,lieu_restitution:e.target.value})}>
                        <option value="">-- Sélectionner --</option>
                        {LIEUX_RESTITUTION.map(l=><option key={l}>{l}</option>)}
                      </select>
                    </div>
                    <div/>
                  </div>

                  <div style={{fontSize:11,color:"var(--muted)",marginTop:8}}>* Champs recommandés — le lieu de restitution est obligatoire</div>
                </div>
                
                <div style={{display:"flex",justifyContent:"space-between"}}>
                  <button className="btn btn-outline" onClick={()=>{setRetStep(0);setFoundDossier(null);setSearchImmat("");setSearchDone(false);}}>← Annuler</button>
                  <button 
                    className="btn btn-gold" 
                    disabled={!retForm.numero_cube || !retForm.type_nacelle || !retForm.modele || !retForm.client || !retForm.lieu_restitution}
                    onClick={async()=>{
                      // Créer le dossier avec les infos remplies
                      const d={
                        id:genId(),
                        immat:searchImmat,
                        info:{
                          immat:searchImmat,
                          numero_cube:retForm.numero_cube||"",
                          type_nacelle:retForm.type_nacelle,
                          modele:retForm.modele,
                          annee_fab:retForm.annee_fab||"",
                          client:retForm.client,
                          contrat:retForm.contrat||"",
                          email:retForm.email||"",
                          date:todayISO(),
                          heures:"",
                          km_porteur:"",
                          agent:retForm.agent
                        },
                        depart:{
                          zones:{},
                          photos:{},
                          date:todayISO(),
                          heures:"",
                          km_porteur:"",
                          agent:"",
                          sansDossier:true
                        },
                        retour:null,
                        createdAt:new Date().toISOString(),
                        createdBy: currentUser?.uid || null,
                        createdByName: userProfile ? `${userProfile.prenom} ${userProfile.nom}` : retForm.agent
                      };
                      await fbSaveDossier(d);
                      setDossiers(prev=>({...prev,[d.immat]:d}));
                      setFoundDossier(d);
                      setRetZones({});
                      setRetTests({});
                      setRetPhotos({});
                      setRetDegats([]);setRetQtes({});setRetMontantsDevis({});setRetTranchesDevis({});
                      setRetNote("");
                      setEmailClient(d.info.email);
                      setEmailSent(false);
                      setRetStep(1);
                    }}
                  >
                    Continuer l'expertise →
                  </button>
                </div>
              </div>
            )}

            {retStep===1&&foundDossier&&(
              <div>
                <div className="section-title">État retour — zone par zone</div>

                {/* ═══ CORRECTION DES INFORMATIONS DU DOSSIER (fautes de frappe) ═══ */}
                <div className="zone-row" style={{marginBottom:14}}>
                  <div className="zone-header" onClick={()=>setShowInfoEdit(!showInfoEdit)}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <span style={{color:"var(--primary)",fontSize:16,width:24}}>✏</span>
                      <span style={{fontWeight:600}}>Corriger les informations</span>
                      <span style={{fontSize:11,color:"var(--muted)"}}>— immat, kilométrages, heures, client...</span>
                    </div>
                    <span style={{color:"var(--muted)"}}>{showInfoEdit?"▲":"▼"}</span>
                  </div>
                  {showInfoEdit&&(
                    <div className="zone-body">
                      <div className="g3" style={{marginBottom:12}}>
                        <div><label>Immatriculation</label>
                          <input value={foundDossier.immat||""} onChange={e=>{const v=normalizeImmat(e.target.value);setFoundDossier(prev=>({...prev,_renamedFrom:prev._renamedFrom??prev.immat,immat:v,info:{...prev.info,immat:v}}));setRetForm(f=>({...f,immat:v}));}}/>
                          {foundDossier._renamedFrom&&foundDossier._renamedFrom!==foundDossier.immat&&<div style={{fontSize:10,color:"var(--accent)",marginTop:3}}>⚠ Correction : {foundDossier._renamedFrom} → {foundDossier.immat}. Appliquée à la validation finale. Si la machine était déjà dans Delta VO, l'ancienne fiche devra y être supprimée.</div>}
                        </div>
                        <div><label>N° de cube</label><input value={retForm.numero_cube||""} onChange={e=>{const v=e.target.value.toUpperCase();setRetForm(f=>({...f,numero_cube:v}));setFoundDossier(prev=>({...prev,info:{...prev.info,numero_cube:v}}));}}/></div>
                        <div><label>Contrat</label><input value={foundDossier.info?.contrat||""} onChange={e=>setFoundDossier(prev=>({...prev,info:{...prev.info,contrat:e.target.value}}))}/></div>
                      </div>
                      <div className="g3" style={{marginBottom:12}}>
                        <div><label>Client</label><input value={foundDossier.info?.client||""} onChange={e=>setFoundDossier(prev=>({...prev,info:{...prev.info,client:e.target.value}}))}/></div>
                        <div><label>Email client</label><input type="email" value={foundDossier.info?.email||""} onChange={e=>{setFoundDossier(prev=>({...prev,info:{...prev.info,email:e.target.value}}));setEmailClient(e.target.value);}}/></div>
                        <div><label>Type nacelle</label><TypeNacelleSelect value={foundDossier.info?.type_nacelle||""} onChange={v=>setFoundDossier(prev=>({...prev,info:{...prev.info,type_nacelle:v}}))} types={typesNacelle}/></div>
                      </div>
                      <div className="g3" style={{marginBottom:12}}>
                        <div><label>Modèle porteur</label><input value={foundDossier.info?.modele||""} onChange={e=>setFoundDossier(prev=>({...prev,info:{...prev.info,modele:e.target.value}}))}/></div>
                        <div><label>Mise en circulation (année)</label><input type="number" value={foundDossier.info?.annee_fab||""} onChange={e=>setFoundDossier(prev=>({...prev,info:{...prev.info,annee_fab:e.target.value}}))}/></div>
                        <div><label>Date retour</label><input type="date" value={retForm.date||""} onChange={e=>setRetForm(f=>({...f,date:e.target.value}))}/></div>
                      </div>
                      <div className="g3" style={{marginBottom:12}}>
                        <div><label>Heures nacelle départ</label><input type="number" value={foundDossier.depart?.heures||""} onChange={e=>setFoundDossier(prev=>({...prev,depart:{...prev.depart,heures:e.target.value}}))}/></div>
                        <div><label>Heures nacelle retour</label><input type="number" value={retForm.heures||""} onChange={e=>setRetForm(f=>({...f,heures:e.target.value}))}/></div>
                        <div><label>Agent expert retour</label><input value={retForm.agent||""} onChange={e=>setRetForm(f=>({...f,agent:e.target.value}))}/></div>
                      </div>
                      <div className="g3">
                        <div><label>Km porteur départ</label><input type="number" value={foundDossier.depart?.km_porteur||""} onChange={e=>setFoundDossier(prev=>({...prev,depart:{...prev.depart,km_porteur:e.target.value}}))}/></div>
                        <div><label>Km porteur retour</label><input type="number" value={retForm.km_porteur||""} onChange={e=>setRetForm(f=>({...f,km_porteur:e.target.value}))}/></div>
                        <div><label>Lieu de restitution *</label>
                          <select value={retForm.lieu_restitution||""} onChange={e=>setRetForm(f=>({...f,lieu_restitution:e.target.value}))}>
                            <option value="">-- Sélectionner --</option>
                            {LIEUX_RESTITUTION.map(l=><option key={l}>{l}</option>)}
                          </select>
                        </div>
                      </div>
                      <div style={{fontSize:11,color:"var(--muted)",marginTop:10}}>Les corrections sont enregistrées à la validation finale de l'expertise (bouton "✓ Confirmer").</div>
                    </div>
                  )}
                </div>

                {/* ═══ IMPORT EN LOT + TRI DES PHOTOS ═══ */}
                <div className="card" style={{marginBottom:14,border:"2px dashed var(--border2)",background:"#f8f9fb"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
                    <div>
                      <div style={{fontSize:11,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",fontWeight:700}}>📥 Import de photos en lot</div>
                      <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>Importez toutes vos photos d'un coup, puis touchez chaque photo pour l'affecter à une section ou un dégât.</div>
                    </div>
                    <button className="btn btn-gold btn-sm" onClick={async()=>{const f=await pickFile({multiple:true});if(f) addPhotos(f,"a_trier",setRetPhotos);}}>+ Importer des photos</button>
                  </div>
                  {(retPhotos["a_trier"]||[]).length>0&&(
                    <div style={{marginTop:12}}>
                      <div style={{fontSize:10,letterSpacing:1.5,color:"var(--accent)",textTransform:"uppercase",fontWeight:700,marginBottom:8}}>{retPhotos["a_trier"].length} photo{retPhotos["a_trier"].length>1?"s":""} à trier — touchez une photo pour l'affecter</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                        {retPhotos["a_trier"].map((p,i)=>(
                          <div key={i} className="no-lightbox" style={{position:"relative",cursor:"pointer",border:"2px solid var(--accent)"}} onClick={()=>{setTriPhoto(i);setTriFilter("");}}>
                            <img src={p.url} alt="" style={{width:100,height:74,objectFit:"cover",display:"block"}}/>
                            <div style={{position:"absolute",bottom:0,left:0,right:0,background:"rgba(200,16,46,.85)",color:"#fff",fontSize:9,textAlign:"center",padding:"2px 0",letterSpacing:1,fontWeight:700}}>AFFECTER →</div>
                            <button className="btn btn-danger" onClick={(e)=>{e.stopPropagation();removePhoto("a_trier",i,setRetPhotos);}} style={{position:"absolute",top:2,right:2,padding:"2px 5px",fontSize:9}}>✕</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Modal d'affectation d'une photo à trier */}
                {triPhoto!==null&&(retPhotos["a_trier"]||[])[triPhoto]&&(
                  <div className="modal-overlay" onClick={()=>{setTriPhoto(null);setTriFilter("");}}>
                    <div className="modal" onClick={e=>e.stopPropagation()}>
                      <div style={{display:"flex",gap:14,alignItems:"center",marginBottom:14}}>
                        <img src={retPhotos["a_trier"][triPhoto].url} alt="" style={{width:110,height:80,objectFit:"cover",border:"1px solid var(--border2)",flexShrink:0}}/>
                        <div>
                          <div style={{fontSize:12,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",fontWeight:700}}>Affecter cette photo</div>
                          <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>Choisissez une section, un angle ou un dégât. Un dégât sera coché automatiquement.</div>
                        </div>
                      </div>
                      <input value={triFilter} onChange={e=>setTriFilter(e.target.value)} placeholder="🔍 Rechercher (ex: gyro, bac, phare...)" style={{marginBottom:10}}/>
                      <div style={{maxHeight:"46vh",overflowY:"auto"}}>
                        {"photos supplémentaires".includes(triFilter.toLowerCase())&&(
                          <div className="tarif-row" onClick={()=>assignPendingPhoto(triPhoto,"photos_supplementaires")}>
                            <span style={{fontSize:13}}>🖼 Photos supplémentaires <span style={{color:"var(--muted)",fontSize:11}}>(hors sections)</span></span>
                          </div>
                        )}
                        {TOUR_ANGLES.filter(a=>!retPhotos[`tour_complet_${a.key}`]?.[0]&&(`tour complet ${a.label}`.toLowerCase().includes(triFilter.toLowerCase()))).map(a=>(
                          <div key={a.key} className="tarif-row" onClick={()=>assignPendingPhoto(triPhoto,`tour_complet_${a.key}`)}>
                            <span style={{fontSize:13}}>📷 Tour complet — {a.label}</span>
                          </div>
                        ))}
                        {zones.filter(z=>z.id!=="tour_complet").map(z=>{
                          const zoneTarifs=tarifs.filter(t=>t.zone===z.id);
                          const zMatch=z.label.toLowerCase().includes(triFilter.toLowerCase());
                          const tMatch=zoneTarifs.filter(t=>t.label.toLowerCase().includes(triFilter.toLowerCase()));
                          if(triFilter&&!zMatch&&!tMatch.length) return null;
                          return (
                            <div key={z.id} style={{marginBottom:6}}>
                              <div style={{fontSize:10,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",fontWeight:700,padding:"6px 2px 3px"}}>{z.icon} {z.label}</div>
                              {(!triFilter||zMatch)&&(
                                <div className="tarif-row" onClick={()=>assignPendingPhoto(triPhoto,z.id)}>
                                  <span style={{fontSize:13}}>Photo générale de la section</span>
                                </div>
                              )}
                              {(triFilter?tMatch:zoneTarifs).map(t=>(
                                <div key={t.id} className={`tarif-row ${retDegats.includes(t.id)?"active":""}`} onClick={()=>assignPendingPhoto(triPhoto,`degat_${t.id}`,t.id)}>
                                  <span style={{fontSize:13}}>⚠ {t.label}{retDegats.includes(t.id)&&<span style={{marginLeft:6,fontSize:10,color:"var(--primary)",fontWeight:700}}>déjà coché</span>}</span>
                                  <span className="mono" style={{fontSize:11,color:"var(--primary)",fontWeight:700,whiteSpace:"nowrap"}}>{t.surDevis?"SUR DEVIS":prixAvecVetuste(t.prix,vetusteTaux)+" €"}</span>
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                      <div style={{display:"flex",justifyContent:"flex-end",marginTop:12}}>
                        <button className="btn btn-outline btn-sm" onClick={()=>{setTriPhoto(null);setTriFilter("");}}>Annuler</button>
                      </div>
                    </div>
                  </div>
                )}

                <TestNacelle tests={retTests} onChange={setRetTests} />
                {vetusteTaux!==0&&<div style={{padding:"8px 14px",background:"rgba(200,16,46,.06)",border:"1px solid rgba(200,16,46,.2)",fontSize:12,color:"var(--accent)",marginBottom:10,fontWeight:600}}>⚖ Taux de vétusté appliqué : {vetusteTaux}% sur les prix</div>}
                {zones.map(zone=>{
                  const depZ=foundDossier.depart?.zones?.[zone.id]; const depP=foundDossier.depart?.photos?.[zone.id]||[];
                  const zoneTarifs=tarifs.filter(t=>t.zone===zone.id);
                  return (
                    <div key={zone.id} className="zone-row">
                      <div className="zone-header" onClick={()=>setOpenZone(openZone===zone.id?null:zone.id)}>
                        <div style={{display:"flex",alignItems:"center",gap:10}}>
                          <span style={{color:"var(--primary)",fontSize:18,width:24}}>{zone.icon}</span>
                          <span style={{fontWeight:600}}>{zone.label}</span>
                          {depZ?.etat&&<span className="etat-tag" style={{fontSize:10,opacity:.7,background:ETAT_COLORS[depZ.etat]+"11",color:ETAT_COLORS[depZ.etat],border:`1px solid ${ETAT_COLORS[depZ.etat]}33`}}>Départ: {depZ.etat}</span>}
                        </div>
                        <div style={{display:"flex",gap:8,alignItems:"center"}}>
                          {retDegats.some(id=>zoneTarifs.find(t=>t.id===id))&&<span className="badge" style={{background:"rgba(200,16,46,.1)",color:"var(--accent)",border:"1px solid rgba(200,16,46,.3)"}}>{retDegats.filter(id=>zoneTarifs.find(t=>t.id===id)).length} dégât{retDegats.filter(id=>zoneTarifs.find(t=>t.id===id)).length>1?"s":""}</span>}
                          {retZones[zone.id]?.etat&&<span className="etat-tag" style={{background:ETAT_COLORS[retZones[zone.id].etat]+"22",color:ETAT_COLORS[retZones[zone.id].etat],border:`1px solid ${ETAT_COLORS[retZones[zone.id].etat]}44`}}>{retZones[zone.id].etat}</span>}
                          <span style={{color:"var(--muted)"}}>{openZone===zone.id?"▲":"▼"}</span>
                        </div>
                      </div>
                      {openZone===zone.id&&(
                        <div className="zone-body">
                          {zone.id==="tour_complet"?(
                            <div>
                              {TOUR_ANGLES.map((angle,idx)=>{
                                const key=`tour_complet_${angle.key}`; const depPhoto=foundDossier.depart?.photos?.[key]?.[0]; const retPhoto=retPhotos[key]?.[0];
                                return (
                                  <div key={angle.key} style={{marginBottom:12,border:"1px solid var(--border)",overflow:"hidden"}}>
                                    <div style={{padding:"8px 12px",background:"#f8f9fb",fontSize:11,fontWeight:700,color:"var(--primary)",letterSpacing:1}}>{idx+1}. {angle.label}</div>
                                    <div style={{display:"flex",gap:2}}>
                                      <div style={{flex:1,padding:10,background:"#fff"}}>
                                        <div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:6}}>Départ</div>
                                        {depPhoto?<img src={depPhoto.url} alt="" style={{width:"100%",maxWidth:160,height:110,objectFit:"cover",border:"1px solid var(--border2)"}}/>:<div style={{fontSize:12,color:"var(--muted)"}}>Pas de photo départ</div>}
                                      </div>
                                      <div style={{flex:1,padding:10,background:"#fff",borderLeft:"1px solid var(--border)"}}>
                                        <div style={{fontSize:9,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",marginBottom:6}}>Retour</div>
                                        {retPhoto?(
                                          <div>
                                            <div style={{position:"relative",display:"inline-block"}}><img src={retPhoto.url} alt="" style={{width:"100%",maxWidth:160,height:110,objectFit:"cover",border:"1px solid var(--border2)",cursor:"zoom-in"}}/><button className="btn" title="Pivoter 90°" disabled={rotatingKey===key+"_"+0} onClick={(e)=>{rotatePhotoAt(retPhotos,key,0,setRetPhotos);}} style={{position:"absolute",top:2,left:2,padding:"2px 4px",fontSize:9,background:"rgba(255,255,255,.92)",border:"1px solid var(--border2)",color:"var(--primary)"}}>{rotatingKey===key+"_"+0?"…":"↻"}</button><button className="btn btn-danger" onClick={()=>removePhoto(key,0,setRetPhotos)} style={{position:"absolute",top:2,right:2,padding:"2px 5px",fontSize:9}}>✕</button></div>
                                          </div>
                                        ):(<div className="photo-add" style={{width:120,height:88}} onClick={async()=>{
                                          const f=await pickFile({multiple:false});
                                          if(!f) return;
                                          await addPhotos(f,key,setRetPhotos); // photos d'expertise brutes (plus de détourage auto)
                                        }}>+</div>)}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ):(
                            <div>
                              <div style={{display:"flex",gap:10,marginBottom:14}}>
                                <div style={{flex:1,background:"#f8f9fb",padding:10,border:"1px solid var(--border)"}}>
                                  <div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:6}}>État départ</div>
                                  {depZ?.etat?<span className="etat-tag" style={{background:ETAT_COLORS[depZ.etat]+"22",color:ETAT_COLORS[depZ.etat],border:`1px solid ${ETAT_COLORS[depZ.etat]}44`}}>{depZ.etat}</span>:<span style={{fontSize:12,color:"var(--muted)"}}>—</span>}
                                  {depZ?.note&&<div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>{depZ.note}</div>}
                                  <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:8}}>{depP.map((p,i)=><img key={i} src={p.url} alt="" className="photo-thumb"/>)}</div>
                                </div>
                                <div style={{flex:1,background:"#f8f9fb",padding:10,border:"1px solid var(--border)"}}>
                                  <div style={{fontSize:9,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",marginBottom:6}}>État retour</div>
                                  <select value={retZones[zone.id]?.etat||""} onChange={e=>setZE(setRetZones,zone.id,e.target.value)} style={{marginBottom:6}}>
                                    <option value="">-- Sélectionner --</option>
                                    {ETAT_OPTIONS.map(o=><option key={o}>{o}</option>)}
                                  </select>
                                  <input value={retZones[zone.id]?.note||""} onChange={e=>setZN(setRetZones,zone.id,e.target.value)} placeholder="Observation retour..." style={{marginBottom:8}}/>
                                  <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                                    {(retPhotos[zone.id]||[]).map((p,i)=>(<div key={i} style={{position:"relative"}}><img src={p.url} alt="" className="photo-thumb"/><button className="btn" title="Pivoter 90°" disabled={rotatingKey===zone.id+"_"+i} onClick={(e)=>{rotatePhotoAt(retPhotos,zone.id,i,setRetPhotos);}} style={{position:"absolute",top:2,left:2,padding:"2px 4px",fontSize:9,background:"rgba(255,255,255,.92)",border:"1px solid var(--border2)",color:"var(--primary)"}}>{rotatingKey===zone.id+"_"+i?"…":"↻"}</button><button className="btn btn-danger" onClick={()=>removePhoto(zone.id,i,setRetPhotos)} style={{position:"absolute",top:2,right:2,padding:"2px 4px",fontSize:9}}>✕</button></div>))}
                                    <div className="photo-add" style={{width:64,height:48,fontSize:20}} onClick={async()=>{const f=await pickFile({multiple:true});if(f) addPhotos(f,zone.id,setRetPhotos);}}>+</div>
                                  </div>
                                </div>
                              </div>
                              {zoneTarifs.length>0&&(
                                <div>
                                  <div style={{fontSize:10,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",marginBottom:8,fontWeight:700,paddingTop:8,borderTop:"1px solid var(--border)"}}>Dégâts constatés — cochez puis prenez la photo du dégât</div>
                                  {zoneTarifs.map(t=>{
                                    const checked=retDegats.includes(t.id);
                                    const pkey=`degat_${t.id}`;
                                    const dphotos=retPhotos[pkey]||[];
                                    return (
                                    <div key={t.id} style={{marginBottom:3}}>
                                      <div className={`tarif-row ${checked?"active":""}`} style={{marginBottom:0}} onClick={()=>{const wasChecked=retDegats.includes(t.id);setRetDegats(prev=>wasChecked?prev.filter(d=>d!==t.id):[...prev,t.id]);setRetQtes(prev=>{const n={...prev};if(wasChecked){delete n[t.id];}else{n[t.id]=1;}return n;});setRetMontantsDevis(prev=>{if(!wasChecked)return prev;const n={...prev};delete n[t.id];return n;});setRetTranchesDevis(prev=>{if(!wasChecked)return prev;const n={...prev};delete n[t.id];return n;});}}>
                                        <div style={{display:"flex",alignItems:"center",gap:10}}>
                                          <div style={{width:16,height:16,border:`2px solid ${checked?"var(--primary)":"var(--border2)"}`,background:checked?"var(--primary)":"transparent",display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,color:"#fff",flexShrink:0}}>{checked?"✓":""}</div>
                                          <span style={{fontSize:13}}>{t.label}{checked&&(retQtes[t.id]||1)>1&&<span className="mono" style={{marginLeft:6,fontSize:11,color:"var(--accent)",fontWeight:700}}>× {retQtes[t.id]}</span>}</span>
                                        </div>
                                        {t.surDevis?(
                                          retMontantsDevis[t.id] ? (
                                            <div style={{textAlign:"right",flexShrink:0}}>
                                              <div className="mono" style={{color:"var(--primary)",fontSize:13,fontWeight:700}}>{Number(retMontantsDevis[t.id]).toLocaleString("fr-FR")} €</div>
                                              <div style={{fontSize:9,color:"var(--muted)"}}>montant saisi</div>
                                            </div>
                                          ) : (
                                            <span style={{fontSize:11,color:"var(--accent)",fontWeight:700,fontFamily:"monospace",whiteSpace:"nowrap"}}>SUR DEVIS</span>
                                          )
                                        ):(
                                          <div style={{textAlign:"right",flexShrink:0}}>
                                            <div className="mono" style={{color:"var(--primary)",fontSize:13,fontWeight:700}}>{checked&&(retQtes[t.id]||1)>1?(prixAvecVetuste(t.prix,vetusteTaux)*(retQtes[t.id]||1)).toLocaleString("fr-FR"):prixAvecVetuste(t.prix,vetusteTaux)} €</div>
                                            {checked&&(retQtes[t.id]||1)>1&&<div style={{fontSize:9,color:"var(--muted)"}}>{retQtes[t.id]} × {prixAvecVetuste(t.prix,vetusteTaux)} €</div>}
                                            {vetusteTaux!==0&&<div style={{fontSize:9,color:"var(--muted)"}}>{t.prix}€ {vetusteTaux}%</div>}
                                          </div>
                                        )}
                                      </div>
                                      {checked&&(
                                        <div style={{display:"flex",flexWrap:"wrap",gap:6,alignItems:"center",padding:"8px 12px",border:"1px solid var(--primary)",borderTop:"none",background:"rgba(26,42,110,.03)"}} onClick={e=>e.stopPropagation()}>
                                          <span style={{fontSize:10,letterSpacing:1.5,color:"var(--muted)",textTransform:"uppercase"}}>Qté</span>
                                          <div style={{display:"flex",alignItems:"center",border:"1px solid var(--border2)",background:"#fff",marginRight:10}}>
                                            <button type="button" style={{border:"none",background:"transparent",color:"var(--primary)",padding:"6px 14px",fontSize:16,fontWeight:700,cursor:"pointer",lineHeight:1}} onClick={(e)=>{e.stopPropagation();setRetQtes(prev=>({...prev,[t.id]:Math.max(1,(prev[t.id]||1)-1)}));}}>−</button>
                                            <span className="mono" style={{minWidth:30,textAlign:"center",fontSize:14,fontWeight:700,color:"var(--primary)"}}>{retQtes[t.id]||1}</span>
                                            <button type="button" style={{border:"none",background:"transparent",color:"var(--primary)",padding:"6px 14px",fontSize:16,fontWeight:700,cursor:"pointer",lineHeight:1}} onClick={(e)=>{e.stopPropagation();setRetQtes(prev=>({...prev,[t.id]:Math.min(99,(prev[t.id]||1)+1)}));}}>+</button>
                                          </div>
                                          {/* Poste "sur devis" : chiffrage EN DIRECT par l'expert.
                                              - Barème par taille défini (admin) → choix d'une tranche, montant automatique
                                              - Option "Autre montant" ou pas de barème → saisie libre
                                              - Rien choisi → reste "SUR DEVIS" (non compté dans le total) */}
                                          {t.surDevis&&(
                                            <>
                                              {Array.isArray(t.bareme)&&t.bareme.length>0&&(
                                                <>
                                                  <span style={{fontSize:10,letterSpacing:1.5,color:"var(--muted)",textTransform:"uppercase"}}>Taille constatée</span>
                                                  <select
                                                    value={retTranchesDevis[t.id]??""}
                                                    onClick={e=>e.stopPropagation()}
                                                    onChange={e=>{
                                                      const label=e.target.value;
                                                      if(label===""){
                                                        setRetTranchesDevis(prev=>{const n={...prev};delete n[t.id];return n;});
                                                        setRetMontantsDevis(prev=>{const n={...prev};delete n[t.id];return n;});
                                                      } else if(label==="__LIBRE__"){
                                                        setRetTranchesDevis(prev=>({...prev,[t.id]:"__LIBRE__"}));
                                                        setRetMontantsDevis(prev=>{const n={...prev};delete n[t.id];return n;});
                                                      } else {
                                                        const tr=t.bareme.find(b=>b.label===label);
                                                        setRetTranchesDevis(prev=>({...prev,[t.id]:label}));
                                                        setRetMontantsDevis(prev=>({...prev,[t.id]:Number(tr?.montant)||0}));
                                                      }
                                                    }}
                                                    style={{maxWidth:280,padding:"6px 8px",border:"1px solid var(--border2)",fontSize:12,marginRight:10}}
                                                  >
                                                    <option value="">Sur devis (non chiffré)</option>
                                                    {t.bareme.map(b=><option key={b.label} value={b.label}>{b.label} — {b.montant} €</option>)}
                                                    <option value="__LIBRE__">Autre montant…</option>
                                                  </select>
                                                </>
                                              )}
                                              {((!Array.isArray(t.bareme)||t.bareme.length===0)||retTranchesDevis[t.id]==="__LIBRE__")&&(
                                                <>
                                                  <span style={{fontSize:10,letterSpacing:1.5,color:"var(--muted)",textTransform:"uppercase"}}>Montant € HT</span>
                                                  <input
                                                    type="number" min="0" step="1" inputMode="numeric"
                                                    placeholder="Sur devis"
                                                    value={retMontantsDevis[t.id]??""}
                                                    onClick={e=>e.stopPropagation()}
                                                    onChange={e=>{const v=e.target.value;setRetMontantsDevis(prev=>{const n={...prev};if(v===""||Number(v)<=0){delete n[t.id];}else{n[t.id]=Number(v);}return n;});}}
                                                    style={{width:110,padding:"6px 8px",border:"1px solid var(--border2)",fontSize:13,marginRight:10}}
                                                  />
                                                </>
                                              )}
                                            </>
                                          )}
                                          <span style={{fontSize:10,letterSpacing:1.5,color:"var(--muted)",textTransform:"uppercase",marginRight:4}}>Photos du dégât</span>
                                          {dphotos.map((p,i)=>(<div key={i} style={{position:"relative"}} onClick={(e)=>{e.stopPropagation();setLightboxUrl(p.url);}}><img src={p.url} alt="" className="photo-thumb"/><button className="btn" title="Pivoter 90°" disabled={rotatingKey===pkey+"_"+i} onClick={(e)=>{e.stopPropagation();rotatePhotoAt(retPhotos,pkey,i,setRetPhotos);}} style={{position:"absolute",top:2,left:2,padding:"2px 4px",fontSize:9,background:"rgba(255,255,255,.92)",border:"1px solid var(--border2)",color:"var(--primary)"}}>{rotatingKey===pkey+"_"+i?"…":"↻"}</button><button className="btn btn-danger" onClick={(e)=>{e.stopPropagation();removePhoto(pkey,i,setRetPhotos);}} style={{position:"absolute",top:2,right:2,padding:"2px 4px",fontSize:9}}>✕</button></div>))}
                                          <div className="photo-add" style={{width:64,height:48,fontSize:20}} onClick={async(e)=>{e.stopPropagation();const f=await pickFile({multiple:true});if(f) addPhotos(f,pkey,setRetPhotos);}}>+</div>
                                        </div>
                                      )}
                                    </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div className="zone-row" style={{marginTop:10}}>
                  <div className="zone-header" onClick={()=>setOpenZone(openZone==="photos_supplementaires"?null:"photos_supplementaires")}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <span style={{color:"var(--primary)",fontSize:18,width:24}}>🖼</span>
                      <span style={{fontWeight:600}}>Photos supplémentaires</span>
                      <span style={{fontSize:11,color:"var(--muted)"}}>— hors sections</span>
                    </div>
                    <div style={{display:"flex",gap:8,alignItems:"center"}}>
                      {(retPhotos["photos_supplementaires"]||[]).length>0&&<span className="badge badge-ok">{retPhotos["photos_supplementaires"].length} photo{retPhotos["photos_supplementaires"].length>1?"s":""}</span>}
                      <span style={{color:"var(--muted)"}}>{openZone==="photos_supplementaires"?"▲":"▼"}</span>
                    </div>
                  </div>
                  {openZone==="photos_supplementaires"&&(
                    <div className="zone-body">
                      <div style={{fontSize:11,color:"var(--muted)",marginBottom:10}}>Ajoutez ici toute photo qui ne concerne pas les sections ci-dessus. Vous pouvez en sélectionner plusieurs d'un coup.</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                        {(retPhotos["photos_supplementaires"]||[]).map((p,i)=>(<div key={i} style={{position:"relative"}}><img src={p.url} alt="" className="photo-thumb"/><button className="btn" title="Pivoter 90°" disabled={rotatingKey==="photos_supplementaires"+"_"+i} onClick={(e)=>{rotatePhotoAt(retPhotos,"photos_supplementaires",i,setRetPhotos);}} style={{position:"absolute",top:2,left:2,padding:"2px 4px",fontSize:9,background:"rgba(255,255,255,.92)",border:"1px solid var(--border2)",color:"var(--primary)"}}>{rotatingKey==="photos_supplementaires"+"_"+i?"…":"↻"}</button><button className="btn btn-danger" onClick={()=>removePhoto("photos_supplementaires",i,setRetPhotos)} style={{position:"absolute",top:2,right:2,padding:"2px 4px",fontSize:9}}>✕</button></div>))}
                        <div className="photo-add" onClick={async()=>{const f=await pickFile({multiple:true});if(f) addPhotos(f,"photos_supplementaires",setRetPhotos);}}>+</div>
                      </div>
                    </div>
                  )}
                </div>
                {retDegats.length>0&&(
                  <div className="total-strip" style={{marginTop:14}}>
                    <span style={{fontSize:12,letterSpacing:2,textTransform:"uppercase",fontWeight:700}}>Total retenue · {retDegats.length} poste{retDegats.length>1?"s":""}</span>
                    <span style={{fontFamily:"'Share Tech Mono'",fontSize:28,fontWeight:700}}>{totalRetenue.toLocaleString("fr-FR")} € HT</span>
                  </div>
                )}
                <div style={{display:"flex",justifyContent:"space-between",marginTop:14}}>
                  <button className="btn btn-outline" onClick={()=>setRetStep(0)}>← Retour</button>
                  <button className="btn btn-gold" onClick={()=>{
                    if(!retForm.lieu_restitution){
                      alert("⚠ Le lieu de restitution est obligatoire.\n\nRenseignez-le dans le panneau « ✏ Corriger les informations » en haut de la page (EGI, Ferrières, Avignon ou St Alban).");
                      setShowInfoEdit(true);
                      window.scrollTo({top:0,behavior:"smooth"});
                      return;
                    }
                    const pending=(retPhotos["a_trier"]||[]).length;
                    if(pending>0){
                      if(!window.confirm(`${pending} photo${pending>1?"s":""} importée${pending>1?"s":""} n'${pending>1?"ont":"a"} pas été triée${pending>1?"s":""}.\n\nOK → elle${pending>1?"s":""} sera${pending>1?"ont":""} ajoutée${pending>1?"s":""} aux « Photos supplémentaires »\nAnnuler → revenir pour les trier`)) return;
                      flushPendingPhotos();
                    }
                    setRetStep(2);
                  }}>Valider l'expertise →</button>
                </div>
              </div>
            )}

            {retStep===2&&foundDossier&&(
              <div id="retour-recap-content">
                <div className="section-title">Validation finale</div>
                <div className="card" style={{marginBottom:14,border:"2px solid var(--primary)"}}>
                  <div style={{fontSize:11,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",fontWeight:700,marginBottom:12}}>Récapitulatif</div>
                  <div className="g3" style={{marginBottom:14}}>
                    {[["Immatriculation",foundDossier.immat],["N° de cube",retForm.numero_cube||foundDossier.info?.numero_cube],["Client",foundDossier.info?.client],["Contrat",foundDossier.info?.contrat],["Date retour",retForm.date],["Lieu de restitution",retForm.lieu_restitution],["Heures départ",foundDossier.depart?.heures?foundDossier.depart.heures+" h":"—"],["Heures retour",retForm.heures?retForm.heures+" h":"—"],["Heures utilisées",foundDossier.depart?.heures&&retForm.heures?(parseInt(retForm.heures)-parseInt(foundDossier.depart.heures))+" h":"—"],["Km porteur départ",foundDossier.depart?.km_porteur?foundDossier.depart.km_porteur+" km":"—"],["Km porteur retour",retForm.km_porteur?retForm.km_porteur+" km":"—"],["Km parcourus",foundDossier.depart?.km_porteur&&retForm.km_porteur?(parseInt(retForm.km_porteur)-parseInt(foundDossier.depart.km_porteur))+" km":"—"]].map(([k,v])=>(
                      <div key={k}><div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:2}}>{k}</div><div style={{fontSize:13,fontWeight:600}}>{v||"—"}</div></div>
                    ))}
                  </div>
                  {retDegats.length>0?(
                    <div>
                      <div style={{fontSize:10,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",marginBottom:8,fontWeight:700}}>Dégâts retenus</div>
                      {retDegats.map(id=>{const t=tarifs.find(t=>t.id===id);const dphotos=retPhotos[`degat_${id}`]||[];const q=retQtes[id]||1;return t?(<div key={id} style={{padding:"7px 0",borderBottom:"1px solid var(--border)"}}><div style={{display:"flex",justifyContent:"space-between",fontSize:13}}><span>{t.label}{retTranchesDevis[id]&&retTranchesDevis[id]!=="__LIBRE__"&&<span style={{marginLeft:6,fontSize:11,color:"var(--muted)"}}>({retTranchesDevis[id]})</span>}{q>1&&<span className="mono" style={{marginLeft:6,fontSize:11,color:"var(--accent)",fontWeight:700}}>× {q}</span>}</span><span className="mono" style={{color:"var(--primary)",fontWeight:700}}>{t.surDevis?(retMontantsDevis[id]?`${Number(retMontantsDevis[id]).toLocaleString("fr-FR")} €`:"SUR DEVIS"):(q>1?`${q} × ${prixAvecVetuste(t.prix,vetusteTaux)} € = ${(prixAvecVetuste(t.prix,vetusteTaux)*q).toLocaleString("fr-FR")} €`:prixAvecVetuste(t.prix,vetusteTaux)+" €")}</span></div>{dphotos.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:5,marginTop:6}}>{dphotos.map((p,i)=><img key={i} src={p.url} alt="" className="photo-thumb"/>)}</div>}</div>):null;})}
                      {vetusteTaux!==0&&<div style={{fontSize:11,color:"var(--muted)",marginTop:6}}>Taux de vétusté appliqué : {vetusteTaux}%</div>}
                      {(()=>{ const nbAttente=retDegats.filter(id=>{const t=tarifs.find(t=>t.id===id);return t?.surDevis&&!retMontantsDevis[id];}).length; return (
                      <div>
                        {nbAttente>0&&<div style={{marginTop:8,padding:"8px 12px",background:"#fdf3ec",border:"1px solid #e8c9a8",borderRadius:4,fontSize:13,fontWeight:600,color:"#b3541e"}}>⏳ {nbAttente} poste{nbAttente>1?"s":""} en attente de devis — le montant définitif sera communiqué après chiffrage.</div>}
                        <div className="total-strip" style={{marginTop:10}}>
                          <span style={{fontSize:12,letterSpacing:2,textTransform:"uppercase",fontWeight:700}}>{nbAttente>0?"TOTAL PROVISOIRE HT":"TOTAL RETENUE HT"}</span>
                          <span style={{fontFamily:"'Share Tech Mono'",fontSize:28,fontWeight:700}}>{totalRetenue.toLocaleString("fr-FR")} €</span>
                        </div>
                      </div>
                      ); })()}
                    </div>
                  ):(<div style={{padding:"12px 0",color:"#208040",fontWeight:600}}>✓ Aucun dégât — nacelle rendue conforme</div>)}
                </div>
                <div className="card" style={{marginBottom:14}}>
                  {(retPhotos["photos_supplementaires"]||[]).length>0&&(
                    <div style={{marginBottom:14}}>
                      <div style={{fontSize:10,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",marginBottom:8,fontWeight:700}}>Photos supplémentaires</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:5}}>{retPhotos["photos_supplementaires"].map((p,i)=><img key={i} src={p.url} alt="" className="photo-thumb"/>)}</div>
                    </div>
                  )}
                  <label>Notes / observations complémentaires</label>
                  <textarea value={retNote} onChange={e=>setRetNote(e.target.value)} rows={3} placeholder="Réserves, observations..." style={{resize:"vertical"}}/>
                </div>
                <div className="g2" style={{marginBottom:20}}>
                  {[["Expert retour",retForm.agent,retForm.date],["Client (accord retenue)",foundDossier.info?.client,""]].map(([l,n,d])=>(
                    <div key={l} style={{border:"1px solid var(--border)",padding:"14px",background:"#fff"}}>
                      <div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:2}}>{l}</div>
                      <div style={{fontSize:12,marginBottom:36}}>{n||"—"}{d?` · ${d}`:""}</div>
                      <div style={{borderTop:"2px solid var(--primary)",paddingTop:4,fontSize:10,color:"var(--muted)"}}>Signature</div>
                    </div>
                  ))}
                </div>
                <div className="card" style={{marginBottom:14}}>
                  <label>Email client — pour envoi du rapport</label>
                  <input type="email" value={emailClient} onChange={e=>setEmailClient(e.target.value)} placeholder="client@email.com"/>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",gap:10}}>
                  <button className="btn btn-outline" onClick={()=>setRetStep(1)}>← Modifier</button>
                  <button className="btn btn-outline btn-sm no-print" onClick={()=>window.print()}>⬇ PDF</button>
                  {emailClient && (
                    <button className="btn btn-blue btn-sm no-print" onClick={()=>openEmailClient(emailClient, foundDossier.immat, "retour", foundDossier)}>📧 Email</button>
                  )}
                  <button className="btn btn-gold" disabled={uploadingCount > 0 || savingRetour} onClick={async()=>{
                    setSavingRetour(true);
                    try {
                      const hadRetour = !!foundDossier?.retour; // re-validation après modification ?
                      const d=await saveRetour();
                      if(!d) return; // sauvegarde refusée (ex: conflit d'immatriculation) — on reste sur l'écran
                      clearDraft("retour");
                      setActiveDossier(d);
                      setView("rapport");
                      // Alerte automatique aux destinataires fixes (avec lien du rapport) — non bloquant
                      if(d) notifyRapportExpertise(d, tarifs, hadRetour);
                      // ⏳ Postes en attente de devis → alerte atelier + rapport provisoire client
                      if(d?.devis_pending?.length) notifyDevisEnAttente(d, tarifs);
                    } finally {
                      setSavingRetour(false);
                    }
                  }}>{uploadingCount > 0 ? `⏳ Upload en cours (${uploadingCount})` : savingRetour ? "📄 Génération du PDF..." : "✓ Confirmer"}</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* RAPPORT */}
        {view==="rapport"&&activeDossier&&(
          <div className="fade-in">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div className="section-title" style={{marginBottom:0}}>Rapport d'expertise</div>
              <div style={{display:"flex",gap:8}}>
                <button className="btn btn-outline btn-sm no-print" onClick={goHome}>← Dossiers</button>
                {activeDossier.retour&&!activeDossier.archived&&<button className="btn btn-accent btn-sm no-print" onClick={()=>editRetour(activeDossier)}>✎ Modifier le retour</button>}
                <button className="btn btn-outline btn-sm no-print" onClick={()=>window.print()}>⬇ PDF</button>
                {activeDossier.info?.email && (
                  <button className="btn btn-blue btn-sm no-print" onClick={()=>openEmailClient(activeDossier.info.email, activeDossier.immat, "retour", activeDossier)}>📧 Email</button>
                )}
              </div>
            </div>
            <div className="card" style={{marginBottom:10}}>
              <div className="g3">
                {[["Immatriculation",activeDossier.immat],["Type nacelle",activeDossier.info?.type_nacelle],["Modèle porteur",activeDossier.info?.modele],["Mise en circulation",activeDossier.info?.annee_fab],["Client",activeDossier.info?.client],["Contrat",activeDossier.info?.contrat],["Email",activeDossier.info?.email],["Date départ",activeDossier.depart?.date],["Date retour",activeDossier.retour?.date||"—"],["Lieu de restitution",activeDossier.retour?.lieu_restitution||"—"],["Durée",activeDossier.depart?.date&&activeDossier.retour?.date?(()=>{const d=Math.round((new Date(activeDossier.retour.date)-new Date(activeDossier.depart.date))/864e5);return d+" jour"+(d>1?"s":"");})():"—"],["Heures départ",activeDossier.depart?.heures?activeDossier.depart.heures+" h":"—"],["Heures retour",activeDossier.retour?.heures?activeDossier.retour.heures+" h":"—"],["Heures utilisées",activeDossier.depart?.heures&&activeDossier.retour?.heures?(parseInt(activeDossier.retour.heures)-parseInt(activeDossier.depart.heures))+" h":"—"],["Km porteur départ",activeDossier.depart?.km_porteur?activeDossier.depart.km_porteur+" km":"—"],["Km porteur retour",activeDossier.retour?.km_porteur?activeDossier.retour.km_porteur+" km":"—"],["Km parcourus",activeDossier.depart?.km_porteur&&activeDossier.retour?.km_porteur?(parseInt(activeDossier.retour.km_porteur)-parseInt(activeDossier.depart.km_porteur))+" km":"—"]].map(([k,v])=>(
                  <div key={k} style={{marginBottom:6}}><div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:2}}>{k}</div><div style={{fontSize:13,fontWeight:600}}>{v||"—"}</div></div>
                ))}
              </div>
            </div>
            {activeDossier.archived&&(
              <div className="no-print" style={{marginBottom:10,padding:"10px 14px",background:"rgba(26,42,110,.06)",border:"1px solid rgba(26,42,110,.25)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
                <span style={{fontSize:13,color:"var(--primary)",fontWeight:600}}>📦 Cycle archivé le {activeDossier.archivedAt?new Date(activeDossier.archivedAt).toLocaleDateString("fr-FR"):"—"} — lecture seule</span>
                {dossiers[activeDossier.immat]&&<button className="btn btn-outline btn-sm" onClick={()=>setActiveDossier(dossiers[activeDossier.immat])}>Voir le dossier actuel →</button>}
              </div>
            )}
            {!activeDossier.archived&&(()=>{
              const cycles=Object.values(dossiers).filter(d=>d.archived&&d.immat===activeDossier.immat).sort((a,b)=>new Date(b.archivedAt||0)-new Date(a.archivedAt||0));
              if(!cycles.length) return null;
              return (
                <div className="card no-print" style={{marginBottom:10,background:"#f8f9fb"}}>
                  <div style={{fontSize:10,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",fontWeight:700,marginBottom:8}}>📦 Historique — {cycles.length} cycle{cycles.length>1?"s":""} précédent{cycles.length>1?"s":""} sur cette nacelle</div>
                  {cycles.map(c=>(
                    <div key={c.archiveId} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 10px",border:"1px solid var(--border)",background:"#fff",marginBottom:4,flexWrap:"wrap",gap:6}}>
                      <span style={{fontSize:13}}>
                        <span className="mono" style={{fontWeight:700,color:"var(--primary)"}}>{c.depart?.date||"?"} → {c.retour?.date||"?"}</span>
                        <span style={{color:"var(--muted)",marginLeft:10,fontSize:12}}>{c.info?.client||""}{c.info?.contrat?` · ${c.info.contrat}`:""}</span>
                      </span>
                      <button className="btn btn-outline btn-sm" onClick={()=>setActiveDossier(c)}>Voir →</button>
                    </div>
                  ))}
                </div>
              );
            })()}
            <div style={{fontSize:10,letterSpacing:3,color:"var(--primary)",textTransform:"uppercase",marginBottom:8,marginTop:14,fontWeight:700}}>Comparaison départ / retour</div>
            {zones.map(zone=>{
              const dep=activeDossier.depart?.zones?.[zone.id]; const ret=activeDossier.retour?.zones?.[zone.id];
              const depP=activeDossier.depart?.photos?.[zone.id]||[]; const retP=activeDossier.retour?.photos?.[zone.id]||[];
              const hasChange=dep?.etat!==ret?.etat&&ret?.etat;
              const tourDepPhotos=zone.id==="tour_complet"?TOUR_ANGLES.map(a=>({angle:a,dep:activeDossier.depart?.photos?.[`tour_complet_${a.key}`]?.[0],ret:activeDossier.retour?.photos?.[`tour_complet_${a.key}`]?.[0]})):[];
              return (
                <div key={zone.id} style={{marginBottom:5,border:`1px solid ${hasChange?"var(--accent)":"var(--border)"}`,overflow:"hidden"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,padding:"9px 14px",background:hasChange?"rgba(200,16,46,.04)":"#f8f9fb"}}>
                    <span style={{color:"var(--primary)"}}>{zone.icon}</span>
                    <span style={{fontWeight:600,fontSize:14}}>{zone.label}</span>
                    {hasChange&&<span style={{fontSize:11,color:"var(--accent)",marginLeft:"auto",fontWeight:700}}>⚠ CHANGEMENT D'ÉTAT</span>}
                  </div>
                  {zone.id==="tour_complet"?(
                    <div style={{padding:10,background:"#fff"}}>
                      {tourDepPhotos.map(({angle,dep:d,ret:r})=>(
                        <div key={angle.key} style={{marginBottom:10}}>
                          <div style={{fontSize:10,color:"var(--primary)",fontWeight:700,marginBottom:6}}>{angle.label}</div>
                          <div style={{display:"flex",gap:8}}>
                            <div style={{flex:1}}><div style={{fontSize:9,color:"var(--muted)",textTransform:"uppercase",letterSpacing:2,marginBottom:4}}>Départ</div>{d?<img src={d.url} alt="" style={{width:"100%",maxWidth:160,height:100,objectFit:"cover",border:"1px solid var(--border2)"}}/>:<span style={{fontSize:12,color:"var(--muted)"}}>—</span>}</div>
                            <div style={{flex:1}}><div style={{fontSize:9,color:"var(--primary)",textTransform:"uppercase",letterSpacing:2,marginBottom:4}}>Retour</div>{r?<img src={r.url} alt="" style={{width:"100%",maxWidth:160,height:100,objectFit:"cover",border:"1px solid var(--border2)"}}/>:<span style={{fontSize:12,color:"var(--muted)"}}>—</span>}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ):(
                    <div style={{display:"flex",gap:2}}>
                      {[{label:"DÉPART",z:dep,photos:depP},{label:"RETOUR",z:ret,photos:retP}].map(({label,z,photos})=>(
                        <div key={label} style={{flex:1,padding:"10px 12px",background:"#fff",borderRight:label==="DÉPART"?"1px solid var(--border)":"none"}}>
                          <div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:6}}>{label}</div>
                          {z?.etat?<span className="etat-tag" style={{background:ETAT_COLORS[z.etat]+"22",color:ETAT_COLORS[z.etat],border:`1px solid ${ETAT_COLORS[z.etat]}44`}}>{z.etat}</span>:<span style={{fontSize:12,color:"var(--muted)"}}>—</span>}
                          {z?.note&&<div style={{fontSize:12,color:"var(--muted)",marginTop:4}}>{z.note}</div>}
                          <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:6}}>{photos.map((p,i)=><img key={i} src={p.url} alt="" className="photo-thumb"/>)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {(()=>{
              const depSup=activeDossier.depart?.photos?.["photos_supplementaires"]||[];
              const retSup=activeDossier.retour?.photos?.["photos_supplementaires"]||[];
              if(!depSup.length&&!retSup.length) return null;
              return (
                <div style={{marginBottom:5,border:"1px solid var(--border)",overflow:"hidden"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,padding:"9px 14px",background:"#f8f9fb"}}>
                    <span style={{color:"var(--primary)"}}>🖼</span>
                    <span style={{fontWeight:600,fontSize:14}}>Photos supplémentaires</span>
                  </div>
                  <div style={{display:"flex",gap:2}}>
                    {[{label:"DÉPART",photos:depSup},{label:"RETOUR",photos:retSup}].map(({label,photos})=>(
                      <div key={label} style={{flex:1,padding:"10px 12px",background:"#fff",borderRight:label==="DÉPART"?"1px solid var(--border)":"none"}}>
                        <div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:6}}>{label}</div>
                        {photos.length?<div style={{display:"flex",flexWrap:"wrap",gap:4}}>{photos.map((p,i)=><img key={i} src={p.url} alt="" className="photo-thumb"/>)}</div>:<span style={{fontSize:12,color:"var(--muted)"}}>—</span>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}
            {activeDossier.retour?.degats?.length>0&&(
              <div style={{marginTop:14}}>
                <div style={{fontSize:10,letterSpacing:3,color:"var(--primary)",textTransform:"uppercase",marginBottom:8,fontWeight:700}}>Tarifs des frais de remise en état</div>
                <div className="card" style={{marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"2px solid var(--primary)",marginBottom:4,fontSize:10,letterSpacing:1,textTransform:"uppercase",color:"var(--muted)",fontWeight:700}}>
                    <span>Désignation</span><span>Montant HT facturé</span>
                  </div>
                  {activeDossier.retour.degats.map(id=>{
                    const t=tarifs.find(t=>t.id===id);
                    const vTaux=getVetuste(activeDossier.info?.annee_fab);
                    const q=activeDossier.retour?.quantites?.[id]||1;
                    return t?(<div key={id} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid var(--border)",fontSize:13,alignItems:"center"}}>
                      <span style={{flex:1,paddingRight:16}}>{t.label}{activeDossier.retour?.tranches_devis?.[id]&&<span style={{marginLeft:6,fontSize:11,color:"var(--muted)"}}>({activeDossier.retour.tranches_devis[id]})</span>}{q>1&&<span className="mono" style={{marginLeft:6,fontSize:11,color:"var(--accent)",fontWeight:700}}>× {q}</span>}</span>
                      <span className="mono" style={{color:"var(--primary)",fontWeight:700,whiteSpace:"nowrap"}}>{t.surDevis?((activeDossier.retour?.montants_devis?.[id])?Number(activeDossier.retour.montants_devis[id]).toLocaleString("fr-FR")+" €":"Sur devis"):(q>1?`${q} × ${prixAvecVetuste(t.prix,vTaux)} € = ${(prixAvecVetuste(t.prix,vTaux)*q).toLocaleString("fr-FR")} €`:prixAvecVetuste(t.prix,vTaux)+" €")}</span>
                    </div>):null;
                  })}
                  {(()=>{ const vTaux=getVetuste(activeDossier.info?.annee_fab); const total=activeDossier.retour.degats.reduce((s,id)=>{const t=tarifs.find(t=>t.id===id);return s+montantPoste(t,activeDossier.retour?.quantites?.[id]||1,vTaux,activeDossier.retour?.montants_devis||{});},0); const nbAttente=activeDossier.devis_pending?.length||0; return (
                    <div>
                      {vTaux!==0&&<div style={{fontSize:11,color:"var(--muted)",marginTop:6,textAlign:"right"}}>Taux de vétusté : {vTaux}% — {activeDossier.info?.annee_fab}</div>}
                      {nbAttente>0&&<div style={{marginTop:8,padding:"8px 12px",background:"#fdf3ec",border:"1px solid #e8c9a8",borderRadius:4,fontSize:13,fontWeight:600,color:"#b3541e"}}>⏳ {nbAttente} poste{nbAttente>1?"s":""} en attente de devis — le montant définitif sera communiqué après chiffrage.</div>}
                      <div className="total-strip" style={{marginTop:10}}>
                        <span style={{fontSize:12,letterSpacing:2,textTransform:"uppercase",fontWeight:700}}>{nbAttente>0?"TOTAL PROVISOIRE HT":"TOTAL RETENUE HT"}</span>
                        <span style={{fontFamily:"'Share Tech Mono'",fontSize:28,fontWeight:700}}>{total.toLocaleString("fr-FR")} €</span>
                      </div>
                    </div>
                  ); })()}
                </div>
              </div>
            )}
            {!activeDossier.retour?.degats?.length&&activeDossier.retour&&(<div style={{marginTop:12,padding:"14px 16px",border:"1px solid rgba(48,160,80,.3)",background:"rgba(48,160,80,.06)",color:"#208040",fontSize:13,fontWeight:600}}>✓ Aucun dégât constaté — nacelle rendue conforme</div>)}
            {activeDossier.retour?.note&&<div className="card" style={{marginTop:10}}><div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:6}}>Notes</div><div style={{fontSize:13,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{activeDossier.retour.note}</div></div>}
            {activeDossier.depart?.signature_client?.url&&(
              <div className="card" style={{marginTop:10}}>
                <div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:6}}>Signature client — état de départ</div>
                <img src={activeDossier.depart.signature_client.url} alt="Signature client" style={{maxWidth:260,border:"1px solid var(--border)",background:"#fff"}}/>
                <div style={{fontSize:11,color:"var(--muted)",marginTop:4}}>Signé le {new Date(activeDossier.depart.signature_client.signedAt).toLocaleString("fr-FR",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"})}</div>
              </div>
            )}
            <div style={{marginTop:6,padding:"10px 14px",background:"#f8f9fb",border:"1px solid var(--border)",fontSize:11,color:"var(--muted)",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
              <span>DELTA SERVICES / 14 Avenue James de Rothschild / 77164 Ferrières-en-Brie · Tel. +33 (0)1 60 95 47 80 · Siret : 512 252 792 00050</span>
              <span style={{fontWeight:600,color:"var(--primary)"}}>© {new Date().getFullYear()} Delta Services · Tous droits réservés</span>
            </div>
            <div className="g2" style={{marginTop:14}}>
              {[["Expert départ",activeDossier.depart?.agent,activeDossier.depart?.date],["Expert retour",activeDossier.retour?.agent,activeDossier.retour?.date],["Client (accord état départ)",activeDossier.info?.client,""],["Client (accord retenue)",activeDossier.info?.client,""]].map(([l,n,d])=>(
                <div key={l} style={{border:"1px solid var(--border)",padding:"12px 14px",background:"#fff"}}>
                  <div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:2}}>{l}</div>
                  <div style={{fontSize:12,marginBottom:28}}>{n||"—"}{d?` · ${d}`:""}</div>
                  <div style={{borderTop:"2px solid var(--primary)",paddingTop:4,fontSize:10,color:"var(--muted)"}}>Signature</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* PHOTOS DE VENTES — onglet dédié, lien par immatriculation */}
        {view==="ventes"&&(
          <div className="fade-in">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div className="section-title" style={{marginBottom:0}}>Photos de ventes</div>
              <button className="btn btn-outline btn-sm no-print" onClick={goHome}>← Accueil</button>
            </div>
            <div className="card" style={{marginBottom:14}}>
              <label>Immatriculation nacelle</label>
              <div style={{display:"flex",gap:8}}>
                <input value={venteImmat} onChange={e=>{setVenteImmat(normalizeImmat(e.target.value));setVenteSearchDone(false);}} placeholder="AB-123-CD" style={{flex:1}} onKeyDown={e=>{if(e.key==="Enter"){searchVente();}}}/>
                <button className="btn btn-gold" onClick={searchVente}>Rechercher</button>
              </div>
            </div>
            {venteSearchDone&&!activeDossier&&(
              <div style={{fontSize:13,padding:"10px 14px",border:"1px solid rgba(26,42,110,.25)",background:"rgba(26,42,110,.05)",color:"var(--primary)",marginBottom:14}}>
                ℹ Aucun dossier d'expertise pour « {venteImmat} » — <b>mode libre</b> : vous pouvez quand même prendre les photos de ventes, elles seront envoyées à Delta VO avec cette immatriculation.
              </div>
            )}
            {venteSearchDone&&activeDossier&&!activeDossier.retour&&(
              <div style={{color:"var(--accent)",fontSize:13,padding:"10px 14px",border:"1px solid rgba(200,16,46,.3)",background:"rgba(200,16,46,.06)",marginBottom:14}}>
                ⚠ L'expertise retour de « {activeDossier.immat} » n'a pas encore été réalisée. Vous pouvez quand même prendre les photos de ventes : elles partiront vers Delta VO.
              </div>
            )}
            {venteSearchDone&&activeDossier&&activeDossier.retour&&(
              <div className="card" style={{marginBottom:14,border:"2px solid var(--primary)"}}>
                <div style={{fontSize:10,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",marginBottom:10,fontWeight:700}}>Dossier trouvé</div>
                <div className="g3">
                  {[["Immatriculation",activeDossier.immat],["Type nacelle",activeDossier.info?.type_nacelle],["Modèle porteur",activeDossier.info?.modele],["Client",activeDossier.info?.client],["Contrat",activeDossier.info?.contrat],["Date retour",activeDossier.retour?.date]].map(([k,v])=>(
                    <div key={k}><div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:2}}>{k}</div><div style={{fontSize:13,fontWeight:600}}>{v||"—"}</div></div>
                  ))}
                </div>
              </div>
            )}
            {venteSearchDone&&venteImmat.trim()&&(
              <div className="card">
                <div style={{fontSize:9,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:8}}>Photos de ventes — {venteImmat}</div>
                <div style={{fontSize:11,color:"var(--muted)",marginBottom:10}}>Les 2 vues extérieures sont détourées automatiquement (logo + immat), les habitacles restent brutes. Ces 4 photos partent vers Delta VO pour la fiche de ventes.</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:12}}>
                  {VENTE_SLOTS.map(slot=>{
                    const current=activeDossier?.retour?.commercialPhotos?.[slot.key]||ventePhotosLibres[slot.key];
                    const currentUrl=current?(typeof current==="object"?current.url:current):null;
                    const busy=venteBusy===slot.key;
                    return (
                      <div key={slot.key} style={{border:"1px solid var(--border)",padding:8,width:152}}>
                        <div style={{fontSize:10,fontWeight:600,marginBottom:6}}>{slot.label}{slot.detour&&<span style={{color:"var(--accent)"}}> · Pro+</span>}</div>
                        {currentUrl?(
                          <img src={currentUrl} alt="" style={{width:"100%",height:104,objectFit:"contain",background:"#f0f2f5",cursor:"zoom-in"}} onClick={()=>setLightboxUrl(currentUrl)}/>
                        ):(
                          <div style={{width:"100%",height:104,background:"#f0f2f5",border:"1px dashed var(--border2)",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--muted)",fontSize:24}}>+</div>
                        )}
                        <button className={currentUrl?"btn btn-outline btn-sm":"btn btn-blue btn-sm"} style={{marginTop:6,width:"100%"}} disabled={busy} onClick={()=>captureVentePhoto(slot)}>{busy?(slot.detour?"Détourage…":"Envoi…"):(currentUrl?"↻ Reprendre":"📷 Prendre")}</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* FOOTER */}
      <div style={{textAlign:"center",padding:"16px",fontSize:11,color:"var(--muted)",borderTop:"1px solid var(--border)",marginTop:20}} className="no-print">
        © {new Date().getFullYear()} Delta Services · Application propriétaire · Tous droits réservés · Reproduction interdite
      </div>

      {/* LIGHTBOX — clic sur une photo pour l'agrandir */}
      {lightboxUrl&&(
        <div className="no-print" onClick={()=>setLightboxUrl(null)} style={{position:"fixed",inset:0,background:"rgba(8,12,30,.93)",zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",padding:24,cursor:"zoom-out"}}>
          <img src={lightboxUrl} alt="" style={{maxWidth:"96%",maxHeight:"92%",objectFit:"contain",boxShadow:"0 12px 48px rgba(0,0,0,.6)",background:"#fff"}}/>
          <button className="btn" onClick={()=>setLightboxUrl(null)} style={{position:"absolute",top:16,right:16,background:"transparent",color:"#fff",border:"1px solid rgba(255,255,255,.5)",padding:"8px 14px"}}>✕ Fermer</button>
        </div>
      )}

      {/* ADMIN */}
      {adminOpen&&(
        <div className="modal-overlay" onClick={e=>{if(e.target===e.currentTarget){setAdminOpen(false);setAdminAuthed(false);}}}>
          <div className="modal">
            {!adminAuthed?(
              <div>
                <div style={{fontFamily:"'Share Tech Mono'",fontSize:16,color:"var(--primary)",letterSpacing:3,marginBottom:20}}>ACCÈS ADMIN</div>
                <label>Mot de passe</label>
                <input type="password" value={adminPwd} onChange={e=>{setAdminPwd(e.target.value);setAdminPwdErr(false);}} onKeyDown={e=>e.key==="Enter"&&(adminPwd===ADMIN_PASSWORD?(setAdminAuthed(true),setAdminPwd("")):setAdminPwdErr(true))} placeholder="••••••••" autoFocus style={{marginBottom:8}}/>
                {adminPwdErr&&<div style={{color:"var(--accent)",fontSize:12,marginBottom:8}}>Mot de passe incorrect</div>}
                <div style={{display:"flex",justifyContent:"space-between",marginTop:14}}>
                  <button className="btn btn-outline btn-sm" onClick={()=>setAdminOpen(false)}>Annuler</button>
                  <button className="btn btn-gold btn-sm" onClick={()=>adminPwd===ADMIN_PASSWORD?(setAdminAuthed(true),setAdminPwd("")):setAdminPwdErr(true)}>Accéder →</button>
                </div>
              </div>
            ):(
              <div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                  <div style={{fontFamily:"'Share Tech Mono'",fontSize:15,color:"var(--primary)",letterSpacing:3}}>ADMINISTRATION</div>
                  <button className="btn btn-icon" onClick={()=>{setAdminOpen(false);setAdminAuthed(false);}}>✕</button>
                </div>
                <div style={{display:"flex",flexWrap:"wrap",borderBottom:"2px solid var(--primary)",marginBottom:18}}>
                  {[[" zones","Zones"],["tarifs","Postes tarifaires"],["types","Types nacelle"],["dossiers","Dossiers"],["users","Utilisateurs"],["emails","📧 Emails"]].filter(([id])=>isSuperAdmin||id.trim()==="dossiers").map(([id,label])=>(<div key={id} className={`tab ${adminTab===id?"active":""}`} onClick={()=>{setAdminTab(id);setZoneEdit(null);setTarifEdit(null);loadUsers();}}>{label}</div>))}
                </div>
                {adminMsg&&<div style={{padding:"8px 12px",background:"rgba(48,160,80,.1)",color:"#208040",border:"1px solid rgba(48,160,80,.3)",fontSize:13,marginBottom:14}}>{adminMsg}</div>}
                {isSuperAdmin&&adminTab==="zones"&&(
                  <div>
                    {zones.map((z,i)=>(<div key={z.id} className="admin-row"><div style={{display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:18}}>{z.icon}</span><span style={{fontWeight:600}}>{z.label}</span><span style={{fontSize:10,color:"var(--muted)"}}>{tarifs.filter(t=>t.zone===z.id).length} poste{tarifs.filter(t=>t.zone===z.id).length!==1?"s":""}</span></div><div style={{display:"flex",gap:4}}><button className="btn btn-icon" onClick={()=>{setZoneEdit(i);setZoneForm({label:z.label,icon:z.icon});}}>✏</button><button className="btn btn-icon" style={{color:"var(--danger)"}} onClick={()=>window.confirm(`Supprimer "${z.label}" ?`)&&deleteZone(i)}>🗑</button></div></div>))}
                    <div style={{marginTop:16,padding:14,border:"1px solid var(--border2)",background:"#f8f9fb"}}>
                      <div style={{fontSize:11,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",marginBottom:10,fontWeight:700}}>{zoneEdit!==null?"Modifier":"Nouvelle zone"}</div>
                      <div style={{marginBottom:10}}><label>Nom *</label><input value={zoneForm.label} onChange={e=>setZoneForm({...zoneForm,label:e.target.value})} placeholder="Ex: Bras télescopique"/></div>
                      <label>Icône</label>
                      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:6,marginBottom:12}}>{ICONS.map(ic=><div key={ic} className={`icon-btn ${zoneForm.icon===ic?"sel":""}`} onClick={()=>setZoneForm({...zoneForm,icon:ic})}>{ic}</div>)}</div>
                      <div style={{display:"flex",gap:8}}>{zoneEdit!==null&&<button className="btn btn-outline btn-sm" onClick={()=>{setZoneEdit(null);setZoneForm({label:"",icon:"⟋"});}}>Annuler</button>}<button className="btn btn-gold btn-sm" disabled={!zoneForm.label.trim()} onClick={saveZone}>{zoneEdit!==null?"Enregistrer":"Ajouter"}</button></div>
                    </div>
                  </div>
                )}
                {isSuperAdmin&&adminTab==="types"&&(
                  <div>
                    <div style={{fontSize:12,color:"var(--muted)",marginBottom:12,lineHeight:1.5}}>
                      Cette liste alimente le menu déroulant « Type nacelle » (départ, retour, corrections). L'option <b>AUTRE</b> (saisie libre) est toujours présente automatiquement.
                    </div>
                    {typesNacelle.map((t,i)=>(
                      <div key={t+i} className="admin-row">
                        <span style={{fontWeight:600}}>{t}</span>
                        <div style={{display:"flex",gap:4}}>
                          <button className="btn btn-icon" title="Monter" disabled={i===0} onClick={async()=>{const u=[...typesNacelle];[u[i-1],u[i]]=[u[i],u[i-1]];setTypesNacelle(u);await fbSaveConfig("types_nacelle",{data:u});}}>↑</button>
                          <button className="btn btn-icon" title="Descendre" disabled={i===typesNacelle.length-1} onClick={async()=>{const u=[...typesNacelle];[u[i+1],u[i]]=[u[i],u[i+1]];setTypesNacelle(u);await fbSaveConfig("types_nacelle",{data:u});}}>↓</button>
                          <button className="btn btn-icon" style={{color:"var(--danger)"}} onClick={async()=>{if(!window.confirm(`Supprimer « ${t} » de la liste ?\n(Les dossiers existants qui l'utilisent ne sont pas modifiés.)`))return;const u=typesNacelle.filter((_,j)=>j!==i);setTypesNacelle(u);await fbSaveConfig("types_nacelle",{data:u});flash("Type supprimé ✓");}}>🗑</button>
                        </div>
                      </div>
                    ))}
                    <div style={{marginTop:16,padding:14,border:"1px solid var(--border2)",background:"#f8f9fb"}}>
                      <div style={{fontSize:11,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",marginBottom:10,fontWeight:700}}>Ajouter un type</div>
                      <div style={{display:"flex",gap:8}}>
                        <input value={typeNacForm} onChange={e=>setTypeNacForm(e.target.value)} placeholder="Ex : KL 27" style={{flex:1}} onKeyDown={async e=>{if(e.key==="Enter"&&typeNacForm.trim()&&!typesNacelle.includes(typeNacForm.trim())){const u=[...typesNacelle,typeNacForm.trim()];setTypesNacelle(u);await fbSaveConfig("types_nacelle",{data:u});setTypeNacForm("");flash("Type ajouté ✓");}}}/>
                        <button className="btn btn-gold btn-sm" disabled={!typeNacForm.trim()||typesNacelle.includes(typeNacForm.trim())} onClick={async()=>{const u=[...typesNacelle,typeNacForm.trim()];setTypesNacelle(u);await fbSaveConfig("types_nacelle",{data:u});setTypeNacForm("");flash("Type ajouté ✓");}}>Ajouter</button>
                      </div>
                      {typeNacForm.trim()&&typesNacelle.includes(typeNacForm.trim())&&<div style={{fontSize:11,color:"var(--accent)",marginTop:6}}>Ce type existe déjà dans la liste.</div>}
                    </div>
                  </div>
                )}
                {adminTab==="dossiers"&&(
                  <div>
                    <div style={{fontSize:11,color:"var(--accent)",padding:"8px 12px",background:"rgba(200,16,46,.06)",border:"1px solid rgba(200,16,46,.2)",marginBottom:14,lineHeight:1.5}}>
                      ⚠ La suppression est définitive et irréversible. Les photos associées seront perdues.
                    </div>
                    {dossiersActifs.length===0&&<div style={{fontSize:13,color:"var(--muted)",padding:"12px",border:"1px dashed var(--border)"}}>Aucun dossier</div>}
                    {dossiersActifs.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).map(d=>(
                      <div key={d.immat} className="admin-row" style={{flexWrap:"wrap",gap:8}}>
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                            <span className="mono" style={{color:"var(--primary)",fontWeight:700,fontSize:13}}>{d.immat}</span>
                            <span style={{fontSize:12}}>{d.info?.client||"—"}</span>
                            <span style={{fontSize:11,color:"var(--muted)"}}>{d.depart?.date}</span>
                            <span className={`badge ${d.retour?"badge-ok":d.depart?.sansDossier?"badge-danger":"badge-warn"}`} style={{fontSize:10}}>
                              {d.retour?"Retour traité":d.depart?.sansDossier?"Sans départ":"En location"}
                            </span>
                          </div>
                        </div>
                        <button className="btn btn-danger btn-sm" onClick={()=>{ if(window.confirm(`Supprimer définitivement le dossier "${d.immat||"SANS IMMAT"}" (${d.info?.client||"sans client"}) ?\n\nLa fiche Delta VO liée sera aussi supprimée si elle est encore en début de cycle (restitution/disponible).\nUne machine vendue, clôturée ou en préparation ne sera PAS touchée.`)) deleteDossier(d.immat||d.id); }}>🗑 Supprimer</button>
                      </div>
                    ))}
                  </div>
                )}
                {isSuperAdmin&&adminTab==="tarifs"&&(
                  <div>
                    {zones.map(zone=>{
                      const tz=tarifs.filter(t=>t.zone===zone.id);
                      return (<div key={zone.id} style={{marginBottom:12}}>
                        <div style={{fontSize:10,letterSpacing:3,color:"var(--muted)",textTransform:"uppercase",marginBottom:6,display:"flex",gap:8,alignItems:"center"}}><span style={{color:"var(--primary)"}}>{zone.icon}</span>{zone.label}</div>
                        {tz.length===0&&<div style={{fontSize:12,color:"var(--muted)",padding:"8px 12px",border:"1px dashed var(--border)"}}>Aucun poste</div>}
                        {tz.map(t=>{const gi=tarifs.findIndex(x=>x.id===t.id);return(<div key={t.id} className="admin-row"><span style={{fontSize:12,flex:1,paddingRight:8}}>{t.label}</span><div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}><span className="mono" style={{color:t.surDevis?"var(--accent)":"var(--primary)",fontSize:12,fontWeight:700}}>{t.surDevis?(Array.isArray(t.bareme)&&t.bareme.length?`Barème (${t.bareme.length})`:"Sur devis"):t.prix+" €"}</span><button className="btn btn-icon" onClick={()=>{setTarifEdit(gi);setTarifForm({zone:t.zone,label:t.label,prix:t.prix?String(t.prix):"",surDevis:!!t.surDevis,bareme:Array.isArray(t.bareme)?t.bareme.map(b=>({...b})):[]});}}>✏</button><button className="btn btn-icon" style={{color:"var(--danger)"}} onClick={()=>window.confirm(`Supprimer "${t.label}" ?`)&&deleteTarif(gi)}>🗑</button></div></div>);})}
                      </div>);
                    })}
                    <div style={{marginTop:16,padding:14,border:"1px solid var(--border2)",background:"#f8f9fb"}}>
                      <div style={{fontSize:11,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",marginBottom:10,fontWeight:700}}>{tarifEdit!==null?"Modifier":"Nouveau poste"}</div>
                      <div style={{marginBottom:10}}><label>Zone *</label><select value={tarifForm.zone} onChange={e=>setTarifForm({...tarifForm,zone:e.target.value})}><option value="">-- Sélectionner --</option>{zones.map(z=><option key={z.id} value={z.id}>{z.icon} {z.label}</option>)}</select></div>
                      <div style={{marginBottom:10}}><label>Libellé *</label><input value={tarifForm.label} onChange={e=>setTarifForm({...tarifForm,label:e.target.value})} placeholder="Ex: Pare-choc cassé"/></div>
                      <div style={{marginBottom:10,display:"flex",alignItems:"center",gap:12}}>
                        <label style={{marginBottom:0,display:"flex",alignItems:"center",gap:6,cursor:"pointer"}}>
                          <input type="checkbox" checked={tarifForm.surDevis} onChange={e=>setTarifForm({...tarifForm,surDevis:e.target.checked})} style={{width:"auto"}}/>
                          <span style={{fontSize:12,textTransform:"none",letterSpacing:0}}>Sur devis</span>
                        </label>
                      </div>
                      {!tarifForm.surDevis&&<div style={{marginBottom:12}}><label>Prix € HT *</label><input type="number" value={tarifForm.prix} onChange={e=>setTarifForm({...tarifForm,prix:e.target.value})} placeholder="250"/></div>}
                      {/* Barème par taille (postes sur devis) : tranches libellé + montant.
                          L'expert choisira une tranche pendant l'expertise retour. */}
                      {tarifForm.surDevis&&(
                        <div style={{marginBottom:12,padding:10,border:"1px dashed var(--border2)",background:"#fff"}}>
                          <label style={{marginBottom:6}}>Barème par taille (facultatif)</label>
                          {(tarifForm.bareme||[]).map((b,bi)=>(
                            <div key={bi} style={{display:"flex",gap:6,marginBottom:6,alignItems:"center"}}>
                              <input value={b.label} onChange={e=>{const nb=[...tarifForm.bareme];nb[bi]={...nb[bi],label:e.target.value};setTarifForm({...tarifForm,bareme:nb});}} placeholder="Ex: 5 à 30 cm — raccord peinture" style={{flex:1}}/>
                              <input type="number" value={b.montant??""} onChange={e=>{const nb=[...tarifForm.bareme];nb[bi]={...nb[bi],montant:Number(e.target.value)||0};setTarifForm({...tarifForm,bareme:nb});}} placeholder="€ HT" style={{width:90}}/>
                              <button className="btn btn-icon" style={{color:"var(--danger)"}} onClick={()=>setTarifForm({...tarifForm,bareme:tarifForm.bareme.filter((_,i)=>i!==bi)})}>🗑</button>
                            </div>
                          ))}
                          <button className="btn btn-outline btn-sm" onClick={()=>setTarifForm({...tarifForm,bareme:[...(tarifForm.bareme||[]),{label:"",montant:0}]})}>+ Ajouter une tranche</button>
                          <div style={{fontSize:11,color:"var(--muted)",marginTop:6}}>Sans tranche, le poste reste « sur devis » avec saisie libre du montant par l'expert.</div>
                        </div>
                      )}
                      <div style={{display:"flex",gap:8}}>{tarifEdit!==null&&<button className="btn btn-outline btn-sm" onClick={()=>{setTarifEdit(null);setTarifForm({zone:"",label:"",prix:"",surDevis:false,bareme:[]});}}>Annuler</button>}<button className="btn btn-gold btn-sm" disabled={!tarifForm.label.trim()||!tarifForm.zone||(!tarifForm.surDevis&&!tarifForm.prix)} onClick={saveTarif}>{tarifEdit!==null?"Enregistrer":"Ajouter"}</button></div>
                    </div>
                  </div>
                )}
                {isSuperAdmin&&adminTab==="emails"&&(
                  <div>
                    <div style={{fontSize:12,color:"var(--muted)",marginBottom:14}}>
                      Destinataires des envois automatiques. Une adresse par ligne. Laisser vide = valeurs par défaut.
                      {!emailsCfgLoaded&&<span style={{color:"var(--accent)"}}> (première configuration : les champs vides utilisent les défauts actuels)</span>}
                    </div>
                    <div style={{marginBottom:12}}>
                      <label>🔔 Alerte expertise retour (interne)</label>
                      <textarea rows={4} value={emailsCfg.retour_to} onChange={e=>setEmailsCfg({...emailsCfg,retour_to:e.target.value})} placeholder={"jlaroche@klubb.com\nnneguy@klubb.com\n..."} style={{width:"100%",fontFamily:"monospace",fontSize:13}}/>
                      <div style={{fontSize:11,color:"var(--muted)"}}>Reçoivent l'alerte à chaque validation d'expertise retour (total retenue + lien rapport).</div>
                    </div>
                    <div style={{marginBottom:12}}>
                      <label>⏳ Alerte devis à chiffrer (atelier Nacelle Assistance)</label>
                      <textarea rows={3} value={emailsCfg.devis_to} onChange={e=>setEmailsCfg({...emailsCfg,devis_to:e.target.value})} placeholder="atelier@nacelle-assistance.fr" style={{width:"100%",fontFamily:"monospace",fontSize:13}}/>
                      <div style={{fontSize:11,color:"var(--muted)"}}>Reçoivent le lien de saisie du devis quand une expertise contient des postes non chiffrés.</div>
                    </div>
                    <div style={{marginBottom:14}}>
                      <label>📋 Copie des envois client (assistanat)</label>
                      <textarea rows={2} value={emailsCfg.cc_assistanat} onChange={e=>setEmailsCfg({...emailsCfg,cc_assistanat:e.target.value})} placeholder="assistanat.commerce@delta-services.fr" style={{width:"100%",fontFamily:"monospace",fontSize:13}}/>
                      <div style={{fontSize:11,color:"var(--muted)"}}>En copie des rapports envoyés automatiquement aux clients (état de départ, rapport de restitution).</div>
                    </div>
                    <div style={{marginBottom:14}}>
                      <label>💶 Mise à jour des VNC (service compta)</label>
                      <textarea rows={2} value={emailsCfg.compta_to} onChange={e=>setEmailsCfg({...emailsCfg,compta_to:e.target.value})} placeholder="compta@delta-services.fr" style={{width:"100%",fontFamily:"monospace",fontSize:13}}/>
                      <div style={{fontSize:11,color:"var(--muted)"}}>Reçoivent le fichier VNC du parc VO automatiquement le 1er et le 16 de chaque mois.</div>
                    </div>
                    <button className="btn btn-gold" onClick={saveEmailsCfg}>✓ Enregistrer</button>
                  </div>
                )}
                {isSuperAdmin&&adminTab==="users"&&(
                  <div>
                    <div style={{marginBottom:14}}>
                      <div style={{fontSize:11,letterSpacing:2,color:"var(--primary)",textTransform:"uppercase",marginBottom:10,fontWeight:700}}>
                        {editingUser?"Modifier l'utilisateur":"Nouvel utilisateur"}
                      </div>
                      <div style={{marginBottom:10}}>
                        <label>Email *</label>
                        <input type="email" value={userForm.email} onChange={e=>setUserForm({...userForm,email:e.target.value})} placeholder="prenom.nom@exemple.com" disabled={!!editingUser}/>
                      </div>
                      <div className="g2" style={{marginBottom:10}}>
                        <div>
                          <label>Prénom *</label>
                          <input value={userForm.prenom} onChange={e=>setUserForm({...userForm,prenom:e.target.value})} placeholder="Jean"/>
                        </div>
                        <div>
                          <label>Nom *</label>
                          <input value={userForm.nom} onChange={e=>setUserForm({...userForm,nom:e.target.value})} placeholder="Dupont"/>
                        </div>
                      </div>
                      <div style={{marginBottom:12}}>
                        <label>Rôle *</label>
                        <select value={userForm.role} onChange={e=>setUserForm({...userForm,role:e.target.value})}>
                          <option value="expert">Expert</option>
                          <option value="admin">Administrateur</option>
                          <option value="superadmin">🏆 Super administrateur</option>
                        </select>
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        {editingUser&&<button className="btn btn-outline btn-sm" onClick={()=>{setEditingUser(null);setUserForm({email:"",nom:"",prenom:"",role:"expert"});}}>Annuler</button>}
                        <button 
                          className="btn btn-gold btn-sm" 
                          disabled={!userForm.email.trim()||!userForm.nom.trim()||!userForm.prenom.trim()} 
                          onClick={()=>editingUser?updateUser(editingUser,{nom:userForm.nom,prenom:userForm.prenom,role:userForm.role}):createUser(userForm)}
                        >
                          {editingUser?"Enregistrer":"Créer"}
                        </button>
                      </div>
                    </div>
                    <div style={{fontSize:11,letterSpacing:2,color:"var(--muted)",textTransform:"uppercase",marginBottom:10,marginTop:20}}>Liste des utilisateurs</div>
                    {users.length===0&&<div style={{fontSize:13,color:"var(--muted)",padding:"12px",border:"1px dashed var(--border)"}}>Aucun utilisateur</div>}
                    {users.map(u=>(
                      <div key={u.uid} className="admin-row">
                        <div style={{flex:1,minWidth:0}}>
                          <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                            <span style={{fontWeight:700,fontSize:13}}>{u.prenom} {u.nom}</span>
                            <span style={{fontSize:12,color:"var(--muted)"}}>{u.email}</span>
                            {u.role&&<span className={`badge ${(u.role==="admin"||u.role==="superadmin")?"badge-primary":"badge-ok"}`} style={{fontSize:10}}>
                              {u.role==="superadmin"?"🏆 Super admin":u.role==="admin"?"Admin":"Expert"}
                            </span>}
                            {u.status==="pending"&&(u.role
                              ?<span className="badge badge-warn" style={{fontSize:10}}>En attente de connexion</span>
                              :<span className="badge badge-warn" style={{fontSize:10}}>🔔 Demande d'accès à valider</span>)}
                            {u.status==="active"&&<span className="badge badge-ok" style={{fontSize:10}}>✓ Actif</span>}
                          </div>
                        </div>
                        <div style={{display:"flex",gap:8,alignItems:"center"}}>
                          {u.status==="pending"&&!u.role&&(<>
                            <select value={pendingRole[u.uid]||"expert"} onChange={e=>setPendingRole({...pendingRole,[u.uid]:e.target.value})} style={{fontSize:12,padding:"4px 6px"}}>
                              <option value="expert">Expert</option>
                              <option value="admin">Administrateur</option>
                              <option value="superadmin">🏆 Super administrateur</option>
                            </select>
                            <button className="btn btn-gold btn-sm" onClick={()=>approveRequest(u.uid)}>✓ Valider</button>
                          </>)}
                          <button className="btn btn-icon" onClick={()=>{setEditingUser(u.uid);setUserForm({email:u.email,nom:u.nom,prenom:u.prenom,role:u.role});}} disabled={u.status==="pending"}>✏</button>
                          <button className="btn btn-icon" style={{color:"var(--danger)"}} onClick={()=>deleteUser(u.uid)}>🗑</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
