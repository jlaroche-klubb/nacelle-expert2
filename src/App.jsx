import { useState, useEffect } from "react";
import { db } from "./firebase";
import {
  collection, doc, setDoc, getDocs, query, orderBy
} from "firebase/firestore";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = "nacelle2024"; // À changer !

const TOUR_ANGLES = [
  { key: "av_droit", label: "3/4 Avant Droit" },
  { key: "av_gauche", label: "3/4 Avant Gauche" },
  { key: "ar_gauche", label: "3/4 Arrière Gauche" },
  { key: "ar_droit", label: "3/4 Arrière Droit" },
];

const DEFAULT_ZONES = [
  { id: "tour_complet", label: "Tour complet · 4 vues", icon: "📷" },
  { id: "bras", label: "Bras / Flèche", icon: "⟋" },
  { id: "plateforme", label: "Plateforme / Panier", icon: "▭" },
  { id: "moteur", label: "Moteur / Groupe", icon: "⚙" },
  { id: "roues", label: "Roues / Chenilles", icon: "○" },
  { id: "capots", label: "Capots / Carrosimmat", icon: "◻" },
  { id: "tourelle", label: "Tourelle / Pivot", icon: "↻" },
  { id: "verin", label: "Vérins / Hydraulique", icon: "⇕" },
  { id: "cabrage", label: "Stabilisateurs / Lests", icon: "⊥" },
  { id: "electrique", label: "Câblage / Électrique", icon: "⚡" },
  { id: "securite", label: "Sécurités / Limiteurs", icon: "⛨" },
];

const DEFAULT_TARIFS = [
  { id: "rayure_legere", zone: "capots", label: "Rayure légère carrosserie", prix: 80 },
  { id: "rayure_profonde", zone: "capots", label: "Rayure profonde carrosserie", prix: 180 },
  { id: "bosse", zone: "capots", label: "Bosse / enfoncement", prix: 280 },
  { id: "capot_casse", zone: "capots", label: "Capot cassé / fendu", prix: 450 },
  { id: "jante_rayee", zone: "roues", label: "Jante rayée", prix: 90 },
  { id: "pneu_degrade", zone: "roues", label: "Pneu dégradé / crevé", prix: 220 },
  { id: "roue_voilee", zone: "roues", label: "Roue voilée", prix: 350 },
  { id: "bras_rayure", zone: "bras", label: "Rayure sur bras/flèche", prix: 150 },
  { id: "bras_plie", zone: "bras", label: "Bras plié / déformé", prix: 1200 },
  { id: "verin_fuite", zone: "verin", label: "Fuite vérin hydraulique", prix: 380 },
  { id: "verin_casse", zone: "verin", label: "Vérin cassé", prix: 850 },
  { id: "cable_abime", zone: "electrique", label: "Câble électrique abîmé", prix: 120 },
  { id: "connecteur_casse", zone: "electrique", label: "Connecteur cassé", prix: 90 },
  { id: "securite_hs", zone: "securite", label: "Sécurité neutralisée / HS", prix: 300 },
  { id: "plateforme_deforme", zone: "plateforme", label: "Plateforme déformée", prix: 600 },
  { id: "garde_corps", zone: "plateforme", label: "Garde-corps endommagé", prix: 250 },
  { id: "tourelle_choc", zone: "tourelle", label: "Choc sur tourelle", prix: 400 },
  { id: "stabilo_tord", zone: "cabrage", label: "Stabilisateur tordu", prix: 320 },
];

const ETAT_OPTIONS = ["Bon état", "Usure normale", "Dégradé", "Endommagé", "Manquant"];
const ETAT_COLORS = {
  "Bon état": "#3a9a5a", "Usure normale": "#9a8a2a",
  "Dégradé": "#c07020", "Endommagé": "#c03030", "Manquant": "#7030b0"
};
const ICONS = ["⟋","▭","⚙","○","◻","↻","⇕","⊥","⚡","⛨","🔧","🔩","⬡","◈","⌖","⎔","⊞","△","◉","⊗"];

// ─── CSS ──────────────────────────────────────────────────────────────────────
const css = `
@import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#0a0c0f;--bg2:#111419;--bg3:#181c22;
  --border:#1e2530;--border2:#2a3340;
  --gold:#e8a020;--gold2:#f0c060;
  --text:#c8d4e0;--muted:#5a6878;
  --danger:#c03030;--ok:#30a050;--ai:#6040c0;
}
body{background:var(--bg);color:var(--text);font-family:'Rajdhani',sans-serif;}
::-webkit-scrollbar{width:4px;}::-webkit-scrollbar-thumb{background:var(--gold);}
.mono{font-family:'Share Tech Mono',monospace;}
.btn{cursor:pointer;border:none;font-family:'Rajdhani',sans-serif;font-weight:700;
  letter-spacing:1.5px;text-transform:uppercase;transition:all .18s;font-size:13px;}
.btn-gold{background:var(--gold);color:#080a0c;padding:10px 26px;}
.btn-gold:hover{background:var(--gold2);}
.btn-gold:disabled{opacity:.35;cursor:not-allowed;}
.btn-outline{background:transparent;color:var(--gold);border:1px solid var(--border2);padding:9px 20px;}
.btn-outline:hover{border-color:var(--gold);background:rgba(232,160,32,.08);}
.btn-danger{background:var(--danger);color:#fff;padding:6px 12px;font-size:11px;}
.btn-danger:hover{background:#e04040;}
.btn-ai{background:linear-gradient(135deg,#6040c0,#9060e0);color:#fff;padding:10px 22px;}
.btn-ai:hover{background:linear-gradient(135deg,#7050d0,#a070f0);}
.btn-ai:disabled{opacity:.4;cursor:not-allowed;}
.btn-sm{padding:6px 14px;font-size:11px;}
.btn-icon{background:transparent;border:1px solid var(--border);cursor:pointer;
  padding:6px 10px;font-size:14px;transition:all .15s;color:var(--muted);}
.btn-icon:hover{border-color:var(--border2);color:var(--text);}
input,select,textarea{background:var(--bg3);border:1px solid var(--border);color:var(--text);
  font-family:'Rajdhani',sans-serif;font-size:14px;font-weight:500;
  padding:9px 13px;width:100%;outline:none;transition:border .2s;}
input:focus,select:focus,textarea:focus{border-color:rgba(232,160,32,.4);}
input::placeholder,textarea::placeholder{color:var(--muted);}
select option{background:var(--bg3);}
label{font-size:10px;letter-spacing:2.5px;text-transform:uppercase;
  color:var(--muted);display:block;margin-bottom:5px;}
.card{background:var(--bg2);border:1px solid var(--border);padding:18px;}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;}
.section-title{font-size:11px;letter-spacing:4px;text-transform:uppercase;
  color:var(--gold);margin-bottom:14px;padding-bottom:8px;border-bottom:1px solid var(--border);}
.badge{font-family:'Share Tech Mono',monospace;font-size:11px;padding:3px 8px;}
.badge-ok{background:rgba(48,160,80,.15);color:#50c070;border:1px solid rgba(48,160,80,.3);}
.badge-warn{background:rgba(232,160,32,.1);color:var(--gold);border:1px solid rgba(232,160,32,.3);}
.badge-ai{background:rgba(96,64,192,.2);color:#a080f0;border:1px solid rgba(96,64,192,.4);}
.photo-thumb{width:88px;height:64px;object-fit:cover;border:1px solid var(--border2);}
.photo-add{width:88px;height:64px;border:1px dashed var(--border2);
  display:flex;align-items:center;justify-content:center;
  cursor:pointer;color:var(--muted);font-size:24px;transition:all .2s;flex-shrink:0;}
.photo-add:hover{border-color:var(--gold);color:var(--gold);}
.zone-row{border:1px solid var(--border);margin-bottom:4px;overflow:hidden;}
.zone-header{display:flex;align-items:center;justify-content:space-between;
  padding:11px 14px;cursor:pointer;background:var(--bg3);transition:background .15s;}
.zone-header:hover{background:#1e242e;}
.zone-body{padding:14px;background:var(--bg2);border-top:1px solid var(--border);}
.tarif-row{display:flex;justify-content:space-between;align-items:center;
  padding:9px 12px;border:1px solid var(--border);margin-bottom:3px;cursor:pointer;transition:all .15s;}
.tarif-row:hover{border-color:var(--border2);}
.tarif-row.active{border-color:var(--gold);background:rgba(232,160,32,.06);}
.tarif-row.ai-suggest{border-color:rgba(96,64,192,.5);background:rgba(96,64,192,.06);}
.tarif-row.ai-suggest.active{border-color:var(--gold);background:rgba(232,160,32,.06);}
.total-strip{background:var(--gold);color:#080a0c;padding:14px 20px;
  display:flex;justify-content:space-between;align-items:center;}
.dossier-card{border:1px solid var(--border);padding:14px 16px;cursor:pointer;
  transition:all .2s;background:var(--bg2);}
.dossier-card:hover{border-color:var(--border2);background:var(--bg3);}
.etat-tag{font-size:11px;font-family:'Share Tech Mono',monospace;padding:2px 7px;border-radius:2px;}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);
  display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(4px);}
.modal{background:var(--bg2);border:1px solid var(--border2);padding:28px;
  min-width:340px;max-width:560px;width:90%;max-height:85vh;overflow-y:auto;}
.admin-row{display:flex;justify-content:space-between;align-items:center;
  padding:10px 12px;border:1px solid var(--border);margin-bottom:4px;background:var(--bg3);}
.icon-btn{width:36px;height:36px;display:flex;align-items:center;justify-content:center;
  border:1px solid var(--border);cursor:pointer;font-size:16px;transition:all .15s;}
.icon-btn:hover,.icon-btn.sel{border-color:var(--gold);background:rgba(232,160,32,.1);}
.tab{padding:8px 18px;cursor:pointer;font-size:11px;letter-spacing:2px;
  text-transform:uppercase;font-weight:700;border-bottom:2px solid transparent;
  transition:all .2s;color:var(--muted);}
.tab.active{color:var(--gold);border-bottom-color:var(--gold);}
.ai-panel{background:rgba(96,64,192,.08);border:1px solid rgba(96,64,192,.3);padding:16px;margin-bottom:14px;}
.ai-thinking{display:flex;gap:6px;align-items:center;}
.ai-dot{width:6px;height:6px;border-radius:50%;background:#a080f0;
  animation:aiPulse 1.2s ease-in-out infinite;}
.ai-dot:nth-child(2){animation-delay:.2s;}
.ai-dot:nth-child(3){animation-delay:.4s;}
@keyframes aiPulse{0%,80%,100%{opacity:.2}40%{opacity:1}}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.fade-in{animation:fadeIn .3s ease;}
@media(max-width:600px){.g2,.g3{grid-template-columns:1fr;}.step-row{flex-wrap:wrap;gap:6px;}}
@media print{
  .no-print{display:none!important;}
  body{background:white!important;color:black!important;}
  .card,.zone-row{background:#f5f5f5!important;border-color:#ccc!important;color:black!important;}
  .total-strip{background:#111!important;color:white!important;}
}
`;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const genId = () => Math.random().toString(36).slice(2,9).toUpperCase();
const todayISO = () => new Date().toISOString().slice(0,10);

function photoToBase64(file) {
  return new Promise((res,rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function pickFile(opts = {}) {
  return new Promise(res => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = opts.accept || "image/*";
    inp.multiple = opts.multiple || false;
    inp.onchange = () => res(inp.files);
    inp.click();
  });
}

// ─── COMPRESSION IMAGE ────────────────────────────────────────────────────────
async function compressBase64(base64, maxW = 800, quality = 0.7) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ratio = Math.min(maxW / img.width, maxW / img.height, 1);
      canvas.width = img.width * ratio;
      canvas.height = img.height * ratio;
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      res(canvas.toDataURL("image/jpeg", quality));
    };
    img.src = base64;
  });
}

async function compressPhotos(photos) {
  if (!photos) return photos;
  const result = {};
  for (const key of Object.keys(photos)) {
    const arr = photos[key];
    if (!Array.isArray(arr)) continue;
    result[key] = await Promise.all(arr.map(async p => ({
      ...p,
      url: p.url?.startsWith("data:") ? await compressBase64(p.url) : p.url
    })));
  }
  return result;
}

// ─── FIREBASE HELPERS ─────────────────────────────────────────────────────────
async function fbSaveDossier(data) {
  try {
    // Compresser les photos avant envoi Firebase
    const compressed = { ...data };
    if (compressed.depart?.photos) {
      compressed.depart = { ...compressed.depart, photos: await compressPhotos(compressed.depart.photos) };
    }
    if (compressed.retour?.photos) {
      compressed.retour = { ...compressed.retour, photos: await compressPhotos(compressed.retour.photos) };
    }
    await setDoc(doc(db, "dossiers", compressed.immat), compressed);
  } catch(e) {
    console.error("Firebase save error:", e);
    alert("Erreur de sauvegarde : " + e.message);
  }
}
async function fbSaveConfig(id, data) {
  await setDoc(doc(db, "config", id), data);
}
async function fbGetConfig(id) {
  const snap = await getDocs(query(collection(db, "config")));
  const found = snap.docs.find(d => d.id === id);
  return found ? found.data() : null;
}

// ─── CLAUDE AI ANALYSIS ───────────────────────────────────────────────────────
async function analyzeWithClaude(depPhotos, retPhotos, zoneName, tarifs, zoneId) {
  const tarifList = tarifs.filter(t => t.zone === zoneId).map(t => `- ${t.label} (id: ${t.id})`).join("\n");

  const buildImgBlock = (b64) => {
    const mime = b64.split(";")[0].split(":")[1] || "image/jpeg";
    return { type: "image", source: { type: "base64", media_type: mime, data: b64.split(",")[1] } };
  };

  const content = [];

  if (depPhotos?.length) {
    content.push({ type: "text", text: `PHOTOS ÉTAT DÉPART — Zone: ${zoneName}` });
    depPhotos.slice(0,3).forEach(p => content.push(buildImgBlock(p.url)));
  }
  if (retPhotos?.length) {
    content.push({ type: "text", text: `PHOTOS ÉTAT RETOUR — Zone: ${zoneName}` });
    retPhotos.slice(0,3).forEach(p => content.push(buildImgBlock(p.url)));
  }

  content.push({
    type: "text",
    text: `Tu es expert en expertise de nacelles élévatrices (PEMP).
Compare les photos DÉPART et RETOUR de la zone "${zoneName}".

Grille de dégâts disponible pour cette zone :
${tarifList || "Aucun poste spécifique pour cette zone"}

Réponds UNIQUEMENT en JSON (sans markdown) avec ce format exact :
{
  "etat_retour": "Bon état|Usure normale|Dégradé|Endommagé|Manquant",
  "degats_suggeres": ["id_degat1", "id_degat2"],
  "resume": "2-3 phrases décrivant les différences constatées",
  "confiance": "haute|moyenne|faible"
}`
  });

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content }]
    })
  });

  const data = await resp.json();
  const text = data.content?.map(c => c.text || "").join("").trim();
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
    return { etat_retour: null, degats_suggeres: [], resume: text, confiance: "faible" };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// COMPOSANT PRINCIPAL
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [view, setView] = useState("home");
  const [dossiers, setDossiers] = useState({});
  const [zones, setZones] = useState(DEFAULT_ZONES);
  const [tarifs, setTarifs] = useState(DEFAULT_TARIFS);
  const [loading, setLoading] = useState(true);
  const [searchQ, setSearchQ] = useState("");
  const [activeDossier, setActiveDossier] = useState(null);

  // Admin
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminAuthed, setAdminAuthed] = useState(false);
  const [adminPwd, setAdminPwd] = useState("");
  const [adminPwdErr, setAdminPwdErr] = useState(false);
  const [adminTab, setAdminTab] = useState("zones");
  const [adminMsg, setAdminMsg] = useState("");
  const [zoneForm, setZoneForm] = useState({ label:"", icon:"⟋" });
  const [zoneEdit, setZoneEdit] = useState(null);
  const [tarifForm, setTarifForm] = useState({ zone:"", label:"", prix:"" });
  const [tarifEdit, setTarifEdit] = useState(null);

  // Départ
  const [depForm, setDepForm] = useState({ immat:"",marque:"",modele:"",type:"",client:"",contrat:"",email:"",date:todayISO(),horametre:"",agent:"" });
  const [depZones, setDepZones] = useState({});
  const [depPhotos, setDepPhotos] = useState({});
  const [depStep, setDepStep] = useState(0);
  const [openZone, setOpenZone] = useState(null);

  // Retour
  const [retForm, setRetForm] = useState({ date:todayISO(),horametre:"",agent:"" });
  const [retZones, setRetZones] = useState({});
  const [retPhotos, setRetPhotos] = useState({});
  const [retDegats, setRetDegats] = useState([]);
  const [retNote, setRetNote] = useState("");
  const [retStep, setRetStep] = useState(0);
  const [searchSerie, setSearchSerie] = useState("");
  const [foundDossier, setFoundDossier] = useState(null);
  const [searchDone, setSearchDone] = useState(false);

  // IA
  const [aiResults, setAiResults] = useState({});   // { zoneId: { etat, degats, resume, confiance } }
  const [aiLoading, setAiLoading] = useState({});   // { zoneId: bool }
  const [aiGlobalLoading, setAiGlobalLoading] = useState(false);

  // ── Load ──
  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, "dossiers"));
      const result = {};
      snap.docs.forEach(d => { result[d.id] = d.data(); });
      setDossiers(result);

      const zConf = await fbGetConfig("zones");
      if (zConf?.data) setZones(zConf.data);
      const tConf = await fbGetConfig("tarifs");
      if (tConf?.data) setTarifs(tConf.data);
    } catch(e) { console.error(e); }
    setLoading(false);
  }

  // ── Photos ──
  async function addPhotos(files, zoneId, setter) {
    const arr = [];
    for (const f of Array.from(files)) arr.push({ name: f.name, url: await photoToBase64(f) });
    setter(prev => ({ ...prev, [zoneId]: [...(prev[zoneId]||[]), ...arr] }));
  }
  function removePhoto(zoneId, idx, setter) {
    setter(prev => ({ ...prev, [zoneId]: prev[zoneId].filter((_,i) => i !== idx) }));
  }

  // ── Zone état ──
  function setZE(setter, zoneId, etat) { setter(prev => ({ ...prev, [zoneId]: { ...(prev[zoneId]||{}), etat } })); }
  function setZN(setter, zoneId, note) { setter(prev => ({ ...prev, [zoneId]: { ...(prev[zoneId]||{}), note } })); }

  // ── AI analyse une zone ──
  async function analyzeZone(zone) {
    if (!foundDossier) return;
    setAiLoading(prev => ({ ...prev, [zone.id]: true }));
    try {
      const depP = foundDossier.depart?.photos?.[zone.id] || [];
      const retP = retPhotos[zone.id] || [];
      if (!depP.length && !retP.length) {
        setAiResults(prev => ({ ...prev, [zone.id]: { resume: "Aucune photo disponible pour cette zone.", degats_suggeres: [], confiance: "faible" } }));
        return;
      }
      const result = await analyzeWithClaude(depP, retP, zone.label, tarifs, zone.id);
      setAiResults(prev => ({ ...prev, [zone.id]: result }));
      // Appliquer l'état suggéré
      if (result.etat_retour) setZE(setRetZones, zone.id, result.etat_retour);
      // Cocher les dégâts suggérés
      if (result.degats_suggeres?.length) {
        setRetDegats(prev => [...new Set([...prev, ...result.degats_suggeres])]);
      }
    } catch(e) {
      setAiResults(prev => ({ ...prev, [zone.id]: { resume: "Erreur d'analyse. Vérifiez votre connexion.", degats_suggeres: [], confiance: "faible" } }));
    } finally {
      setAiLoading(prev => ({ ...prev, [zone.id]: false }));
    }
  }

  // ── AI analyse toutes les zones ──
  async function analyzeAllZones() {
    setAiGlobalLoading(true);
    for (const zone of zones) {
      await analyzeZone(zone);
    }
    setAiGlobalLoading(false);
    setRetStep(2);
  }

  // ── Save départ ──
  async function saveDepart() {
    const data = {
      id: genId(), immat: depForm.immat, info: { ...depForm },
      depart: { zones: depZones, photos: depPhotos, date: depForm.date, horametre: depForm.horametre, agent: depForm.agent },
      retour: null, createdAt: new Date().toISOString()
    };
    await fbSaveDossier(data);
    setDossiers(prev => ({ ...prev, [data.immat]: data }));
    return data;
  }

  // ── Save retour ──
  async function saveRetour() {
    if (!foundDossier) return;
    const updated = {
      ...foundDossier,
      retour: { zones: retZones, photos: retPhotos, degats: retDegats, note: retNote, date: retForm.date, horametre: retForm.horametre, agent: retForm.agent, aiResults },
      updatedAt: new Date().toISOString()
    };
    await fbSaveDossier(updated);
    setDossiers(prev => ({ ...prev, [updated.immat]: updated }));
    setActiveDossier(updated);
    return updated;
  }

  // ── Admin zones ──
  async function saveZone() {
    if (!zoneForm.label.trim()) return;
    let updated;
    if (zoneEdit !== null) {
      updated = zones.map((z,i) => i === zoneEdit ? { ...z, label: zoneForm.label, icon: zoneForm.icon } : z);
    } else {
      const id = zoneForm.label.toLowerCase().replace(/[^a-z0-9]/g,"_").slice(0,18) + "_" + genId().slice(0,3).toLowerCase();
      updated = [...zones, { id, label: zoneForm.label, icon: zoneForm.icon }];
    }
    setZones(updated);
    await fbSaveConfig("zones", { data: updated });
    setZoneForm({ label:"", icon:"⟋" }); setZoneEdit(null);
    flash(zoneEdit !== null ? "Zone modifiée ✓" : "Zone ajoutée ✓");
  }

  async function deleteZone(idx) {
    const z = zones[idx];
    const uz = zones.filter((_,i) => i !== idx);
    const ut = tarifs.filter(t => t.zone !== z.id);
    setZones(uz); setTarifs(ut);
    await fbSaveConfig("zones", { data: uz });
    await fbSaveConfig("tarifs", { data: ut });
    flash("Zone supprimée ✓");
  }

  // ── Admin tarifs ──
  async function saveTarif() {
    if (!tarifForm.label.trim() || !tarifForm.zone || !tarifForm.prix) return;
    let updated;
    if (tarifEdit !== null) {
      updated = tarifs.map((t,i) => i === tarifEdit ? { ...t, label: tarifForm.label, zone: tarifForm.zone, prix: parseInt(tarifForm.prix) } : t);
    } else {
      const id = tarifForm.label.toLowerCase().replace(/[^a-z0-9]/g,"_").slice(0,18) + "_" + genId().slice(0,3).toLowerCase();
      updated = [...tarifs, { id, zone: tarifForm.zone, label: tarifForm.label, prix: parseInt(tarifForm.prix) }];
    }
    setTarifs(updated);
    await fbSaveConfig("tarifs", { data: updated });
    setTarifForm({ zone:"", label:"", prix:"" }); setTarifEdit(null);
    flash(tarifEdit !== null ? "Poste modifié ✓" : "Poste ajouté ✓");
  }

  async function deleteTarif(idx) {
    const updated = tarifs.filter((_,i) => i !== idx);
    setTarifs(updated);
    await fbSaveConfig("tarifs", { data: updated });
    flash("Poste supprimé ✓");
  }

  function flash(msg) { setAdminMsg(msg); setTimeout(() => setAdminMsg(""), 2500); }

  const totalRetenue = retDegats.reduce((s,id) => { const t = tarifs.find(t => t.id === id); return s + (t ? t.prix : 0); }, 0);
  const filteredDossiers = Object.values(dossiers).filter(d =>
    !searchQ || [d.immat, d.info?.client, d.info?.contrat].some(v => v?.toLowerCase().includes(searchQ.toLowerCase()))
  );

  function goHome() { setView("home"); setDepStep(0); setRetStep(0); setFoundDossier(null); setOpenZone(null); setSearchDone(false); setAiResults({}); }

  // ════════════════════════════════════════════════════════════════════════════
  return (
    <div style={{ minHeight:"100vh", background:"var(--bg)" }}>
      <style>{css}</style>

      {/* ── HEADER ── */}
      <div style={{ borderBottom:"1px solid var(--border)", padding:"14px 20px", display:"flex", justifyContent:"space-between", alignItems:"center", background:"var(--bg2)" }}>
        <div style={{ cursor:"pointer" }} onClick={goHome}>
          <div style={{ fontFamily:"'Share Tech Mono'", fontSize:18, color:"var(--gold)", letterSpacing:4 }}>NACELLE EXPERT</div>
          <div style={{ fontSize:10, letterSpacing:3, color:"var(--muted)", textTransform:"uppercase" }}>Expertise PEMP · Firebase + IA</div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <button className="btn btn-icon no-print" onClick={() => { setAdminOpen(true); setAdminAuthed(false); setAdminPwd(""); }}>⚙</button>
          {view === "home" && <>
            <button className="btn btn-outline btn-sm" onClick={() => { setView("retour"); setRetStep(0); setFoundDossier(null); setSearchSerie(""); setSearchDone(false); }}>Expertise Retour</button>
            <button className="btn btn-gold btn-sm" onClick={() => { setView("depart"); setDepStep(0); setDepForm({ immat:"",marque:"",modele:"",type:"",client:"",contrat:"",email:"",date:todayISO(),horametre:"",agent:"" }); setDepZones({}); setDepPhotos({}); }}>+ Nouveau départ</button>
          </>}
        </div>
      </div>

      <div style={{ maxWidth:840, margin:"0 auto", padding:"22px 16px" }}>

        {/* ════ HOME ════ */}
        {view === "home" && (
          <div className="fade-in">
            <div style={{ display:"flex", gap:10, marginBottom:18 }}>
              {[["Dossiers", Object.keys(dossiers).length, "var(--gold)"], ["Retours traités", Object.values(dossiers).filter(d=>d.retour).length, "#50c070"], ["En location", Object.values(dossiers).filter(d=>!d.retour).length, "#e05050"]].map(([l,n,c]) => (
                <div key={l} className="card" style={{ flex:1, textAlign:"center" }}>
                  <div style={{ fontFamily:"'Share Tech Mono'", fontSize:32, color:c }}>{n}</div>
                  <div style={{ fontSize:10, letterSpacing:2, color:"var(--muted)", textTransform:"uppercase" }}>{l}</div>
                </div>
              ))}
            </div>
            <div className="section-title">Dossiers</div>
            <input placeholder="Rechercher Immatriculation, client, contrat..." value={searchQ} onChange={e => setSearchQ(e.target.value)} style={{ marginBottom:10 }} />
            {loading && <div style={{ textAlign:"center", color:"var(--muted)", padding:40 }}>Connexion Firebase...</div>}
            {!loading && filteredDossiers.length === 0 && <div style={{ textAlign:"center", color:"var(--muted)", padding:32, border:"1px dashed var(--border)", fontSize:13 }}>Aucun dossier</div>}
            {filteredDossiers.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).map(d => (
              <div key={d.immat} className="dossier-card" style={{ marginBottom:6 }} onClick={() => { setActiveDossier(d); setView("rapport"); }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div style={{ display:"flex", gap:14, alignItems:"center", flexWrap:"wrap" }}>
                    <span className="mono" style={{ color:"var(--gold)", fontSize:14 }}>{d.immat}</span>
                    <span style={{ fontSize:13 }}>{d.info?.marque} {d.info?.modele}</span>
                    <span style={{ fontSize:12, color:"var(--muted)" }}>{d.info?.client}</span>
                  </div>
                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                    <span style={{ fontSize:11, color:"var(--muted)" }}>{d.depart?.date}</span>
                    <span className={`badge ${d.retour ? "badge-ok" : "badge-warn"}`}>{d.retour ? "Retour traité" : "En location"}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ════ DÉPART ════ */}
        {view === "depart" && (
          <div className="fade-in">
            {/* Steps */}
            <div className="step-row" style={{ display:"flex", gap:4, marginBottom:20, alignItems:"center" }}>
              {["Informations","État zones","Rapport"].map((s,i) => (
                <div key={i} style={{ display:"flex", alignItems:"center", gap:4 }}>
                  <div style={{ padding:"4px 12px", background: i===depStep ? "var(--gold)" : i<depStep ? "rgba(232,160,32,.2)" : "var(--bg3)", color: i===depStep ? "#080a0c" : i<depStep ? "var(--gold)" : "var(--muted)", fontSize:11, letterSpacing:1.5, textTransform:"uppercase", fontWeight:700 }}>{s}</div>
                  {i<2 && <div style={{ width:16, height:1, background:"var(--border2)" }}/>}
                </div>
              ))}
            </div>

            {depStep === 0 && (
              <div>
                <div className="section-title">Identification nacelle</div>
                <div className="card" style={{ marginBottom:14 }}>
                  <div className="g2" style={{ marginBottom:12 }}>
                    <div><label>Immatriculation *</label><input value={depForm.immat} onChange={e => setDepForm({...depForm, immat: e.target.value.toUpperCase()})} placeholder="NAC-2024-001"/></div>
                    <div><label>Type PEMP</label><input value={depForm.type} onChange={e => setDepForm({...depForm, type: e.target.value})} placeholder="Nacelle araignée, ciseaux..."/></div>
                  </div>
                  <div className="g2" style={{ marginBottom:12 }}>
                    <div><label>Marque</label><input value={depForm.marque} onChange={e => setDepForm({...depForm, marque: e.target.value})} placeholder="Haulotte, JLG, Manitou..."/></div>
                    <div><label>Modèle</label><input value={depForm.modele} onChange={e => setDepForm({...depForm, modele: e.target.value})} placeholder="HA 16 PX"/></div>
                  </div>
                  <div className="g3" style={{ marginBottom:12 }}>
                    <div><label>Client</label><input value={depForm.client} onChange={e => setDepForm({...depForm, client: e.target.value})} placeholder="Société / client"/></div>
                    <div><label>N° Contrat</label><input value={depForm.contrat} onChange={e => setDepForm({...depForm, contrat: e.target.value})} placeholder="CTR-2024-055"/></div>
                    <div><label>Email client</label><input type="email" value={depForm.email} onChange={e => setDepForm({...depForm, email: e.target.value})} placeholder="client@email.com"/></div>
                  </div>
                  <div className="g3">
                    <div><label>Date départ</label><input type="date" value={depForm.date} onChange={e => setDepForm({...depForm, date: e.target.value})}/></div>
                    <div><label>Horamètre (h)</label><input type="number" value={depForm.horametre} onChange={e => setDepForm({...depForm, horametre: e.target.value})} placeholder="1 240"/></div>
                    <div><label>Agent expert</label><input value={depForm.agent} onChange={e => setDepForm({...depForm, agent: e.target.value})} placeholder="Prénom Nom"/></div>
                  </div>
                </div>
                <div style={{ display:"flex", justifyContent:"space-between" }}>
                  <button className="btn btn-outline" onClick={goHome}>← Annuler</button>
                  <button className="btn btn-gold" disabled={!depForm.immat} onClick={() => setDepStep(1)}>Suivant →</button>
                </div>
              </div>
            )}

            {depStep === 1 && (
              <div>
                <div className="section-title">État des zones</div>
                {zones.map(zone => (
                  <div key={zone.id} className="zone-row">
                    <div className="zone-header" onClick={() => setOpenZone(openZone === zone.id ? null : zone.id)}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <span style={{ color:"var(--gold)", fontSize:18, width:24 }}>{zone.icon}</span>
                        <span style={{ fontWeight:600 }}>{zone.label}</span>
                      </div>
                      <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                        {depZones[zone.id]?.etat && <span className="etat-tag" style={{ background: ETAT_COLORS[depZones[zone.id].etat]+"22", color: ETAT_COLORS[depZones[zone.id].etat], border:`1px solid ${ETAT_COLORS[depZones[zone.id].etat]}44` }}>{depZones[zone.id].etat}</span>}
                        {depPhotos[zone.id]?.length > 0 && <span className="badge badge-ok">{depPhotos[zone.id].length} photo{depPhotos[zone.id].length>1?"s":""}</span>}
                        <span style={{ color:"var(--muted)" }}>{openZone === zone.id ? "▲" : "▼"}</span>
                      </div>
                    </div>
                    {openZone === zone.id && (
                      <div className="zone-body">
                        {zone.id === "tour_complet" ? (
                          <div>
                            <div style={{ fontSize:11, color:"var(--muted)", marginBottom:14, lineHeight:1.5 }}>
                              Photographiez la nacelle sous les 4 angles standards. Une photo par angle, en tournant autour de la machine.
                            </div>
                            {TOUR_ANGLES.map((angle, idx) => {
                              const key = `tour_complet_${angle.key}`;
                              const photo = depPhotos[key]?.[0];
                              return (
                                <div key={angle.key} style={{ marginBottom:14, padding:"12px 14px", border:"1px solid var(--border)", background:"var(--bg3)" }}>
                                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
                                    <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                                      <div style={{ width:24, height:24, background:"var(--gold)", color:"#080a0c", display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:700, flexShrink:0 }}>{idx+1}</div>
                                      <span style={{ fontWeight:600, fontSize:14, color:"var(--gold)" }}>{angle.label}</span>
                                    </div>
                                    {photo && <span className="badge badge-ok">✓ Photo ajoutée</span>}
                                  </div>
                                  <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                                    {photo ? (
                                      <div style={{ position:"relative" }}>
                                        <img src={photo.url} alt="" style={{ width:120, height:88, objectFit:"cover", border:"1px solid var(--border2)" }}/>
                                        <button className="btn btn-danger" onClick={() => removePhoto(key, 0, setDepPhotos)} style={{ position:"absolute", top:2, right:2, padding:"2px 5px", fontSize:10 }}>✕</button>
                                      </div>
                                    ) : (
                                      <div className="photo-add" style={{ width:120, height:88 }} onClick={async () => { const f = await pickFile({multiple:false}); if(f) addPhotos(f, key, setDepPhotos); }}>+</div>
                                    )}
                                    <div style={{ fontSize:11, color:"var(--muted)", lineHeight:1.6 }}>
                                      {angle.key === "av_droit" && "Positionnez-vous à l'avant droit de la nacelle, à environ 5m, capturez la machine en entier."}
                                      {angle.key === "av_gauche" && "Positionnez-vous à l'avant gauche de la nacelle, à environ 5m, capturez la machine en entier."}
                                      {angle.key === "ar_gauche" && "Positionnez-vous à l'arrière gauche de la nacelle, à environ 5m, capturez la machine en entier."}
                                      {angle.key === "ar_droit" && "Positionnez-vous à l'arrière droit de la nacelle, à environ 5m, capturez la machine en entier."}
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div>
                            <div className="g2" style={{ marginBottom:12 }}>
                              <div><label>État constaté</label>
                                <select value={depZones[zone.id]?.etat||""} onChange={e => setZE(setDepZones, zone.id, e.target.value)}>
                                  <option value="">-- Sélectionner --</option>
                                  {ETAT_OPTIONS.map(o => <option key={o}>{o}</option>)}
                                </select>
                              </div>
                              <div><label>Observation</label><input value={depZones[zone.id]?.note||""} onChange={e => setZN(setDepZones, zone.id, e.target.value)} placeholder="Détail..."/></div>
                            </div>
                            <label>Photos</label>
                            <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
                              {(depPhotos[zone.id]||[]).map((p,i) => (
                                <div key={i} style={{ position:"relative" }}>
                                  <img src={p.url} alt="" className="photo-thumb"/>
                                  <button className="btn btn-danger" onClick={() => removePhoto(zone.id, i, setDepPhotos)} style={{ position:"absolute", top:2, right:2, padding:"2px 4px", fontSize:9 }}>✕</button>
                                </div>
                              ))}
                              <div className="photo-add" onClick={async () => { const files = await pickFile({multiple:true}); if(files) addPhotos(files, zone.id, setDepPhotos); }}>+</div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                <div style={{ display:"flex", justifyContent:"space-between", marginTop:14 }}>
                  <button className="btn btn-outline" onClick={() => setDepStep(0)}>← Retour</button>
                  <button className="btn btn-gold" onClick={() => setDepStep(2)}>Prévisualiser →</button>
                </div>
              </div>
            )}

            {depStep === 2 && (
              <div>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                  <div className="section-title" style={{ marginBottom:0 }}>Rapport état départ</div>
                  <div style={{ display:"flex", gap:8 }}>
                    <button className="btn btn-outline btn-sm no-print" onClick={() => window.print()}>⬇ PDF</button>
                    <button className="btn btn-gold" onClick={async () => { await saveDepart(); goHome(); }} disabled={!depForm.immat}>✓ Valider & sauvegarder</button>
                  </div>
                </div>
                <div className="card" style={{ marginBottom:10 }}>
                  <div className="g3">
                    {[["Immatriculation",depForm.immat],["Véhicule",`${depForm.marque} ${depForm.modele}`],["Type",depForm.type],["Client",depForm.client],["Contrat",depForm.contrat],["Email",depForm.email],["Date",depForm.date],["Horamètre",depForm.horametre?depForm.horametre+" h":"—"],["Agent",depForm.agent]].map(([k,v]) => (
                      <div key={k} style={{ marginBottom:6 }}><div style={{ fontSize:9, letterSpacing:2, color:"var(--muted)", textTransform:"uppercase", marginBottom:2 }}>{k}</div><div style={{ fontSize:13, fontWeight:600 }}>{v||"—"}</div></div>
                    ))}
                  </div>
                </div>
                {zones.map(zone => {
                  const z = depZones[zone.id];
                  const photos = depPhotos[zone.id]||[];
                  // Pour tour_complet : récupérer toutes les photos des 4 angles
                  const tourPhotos = zone.id === "tour_complet"
                    ? TOUR_ANGLES.map(a => ({ angle: a, photo: depPhotos[`tour_complet_${a.key}`]?.[0] })).filter(x => x.photo)
                    : [];
                  const hasPhotos = zone.id === "tour_complet" ? tourPhotos.length > 0 : photos.length > 0;
                  return (
                    <div key={zone.id} style={{ marginBottom:5, border:"1px solid var(--border)", padding:"10px 14px", background:"var(--bg2)" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                          <span style={{ color:"var(--gold)" }}>{zone.icon}</span>
                          <span style={{ fontWeight:600 }}>{zone.label}</span>
                          {z?.note && <span style={{ fontSize:12, color:"var(--muted)" }}>— {z.note}</span>}
                        </div>
                        <div style={{ display:"flex", gap:8 }}>
                          {hasPhotos && <span className="badge badge-ok">{zone.id === "tour_complet" ? tourPhotos.length : photos.length} photo{(zone.id === "tour_complet" ? tourPhotos.length : photos.length)>1?"s":""}</span>}
                          {z?.etat ? <span className="etat-tag" style={{ background:ETAT_COLORS[z.etat]+"22", color:ETAT_COLORS[z.etat], border:`1px solid ${ETAT_COLORS[z.etat]}44` }}>{z.etat}</span> : <span style={{ fontSize:11, color:"var(--muted)" }}>{zone.id === "tour_complet" ? "" : "Non renseigné"}</span>}
                        </div>
                      </div>
                      {zone.id === "tour_complet" && tourPhotos.length > 0 && (
                        <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginTop:10 }}>
                          {tourPhotos.map(({angle, photo}) => (
                            <div key={angle.key} style={{ textAlign:"center" }}>
                              <img src={photo.url} alt="" className="photo-thumb"/>
                              <div style={{ fontSize:9, color:"var(--muted)", marginTop:3, letterSpacing:0.5 }}>{angle.label}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {zone.id !== "tour_complet" && photos.length > 0 && (
                        <div style={{ display:"flex", flexWrap:"wrap", gap:5, marginTop:8 }}>
                          {photos.map((p,i) => <img key={i} src={p.url} alt="" className="photo-thumb"/>)}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div className="no-print" style={{ marginTop:14 }}><button className="btn btn-outline" onClick={() => setDepStep(1)}>← Modifier</button></div>
              </div>
            )}
          </div>
        )}

        {/* ════ RETOUR ════ */}
        {view === "retour" && (
          <div className="fade-in">

            {retStep === 0 && (
              <div>
                <div className="section-title">Recherche dossier départ</div>
                <div className="card" style={{ marginBottom:14 }}>
                  <label>Immatriculation nacelle</label>
                  <div style={{ display:"flex", gap:8 }}>
                    <input value={searchSerie} onChange={e => { setSearchSerie(e.target.value.toUpperCase()); setSearchDone(false); }} placeholder="NAC-2024-001" style={{ flex:1 }} onKeyDown={e => { if(e.key==="Enter") { setFoundDossier(dossiers[searchSerie]||null); setSearchDone(true); }}}/>
                    <button className="btn btn-gold" onClick={() => { setFoundDossier(dossiers[searchSerie]||null); setSearchDone(true); }}>Rechercher</button>
                  </div>
                </div>
                {searchDone && !foundDossier && <div style={{ color:"#e05050", fontSize:13, padding:"10px 14px", border:"1px solid rgba(192,48,48,.3)", background:"rgba(192,48,48,.08)", marginBottom:14 }}>Aucun dossier pour « {searchSerie} »</div>}
                {foundDossier && (
                  <div>
                    <div className="card" style={{ marginBottom:14, border:"1px solid rgba(232,160,32,.3)" }}>
                      <div style={{ fontSize:10, letterSpacing:2, color:"var(--gold)", textTransform:"uppercase", marginBottom:10 }}>Dossier trouvé</div>
                      <div className="g3">
                        {[["Immatriculation",foundDossier.immat],["Véhicule",`${foundDossier.info?.marque} ${foundDossier.info?.modele}`],["Client",foundDossier.info?.client],["Contrat",foundDossier.info?.contrat],["Départ",foundDossier.depart?.date],["Horamètre départ",foundDossier.depart?.horametre?foundDossier.depart.horametre+" h":"—"]].map(([k,v]) => (
                          <div key={k}><div style={{ fontSize:9, letterSpacing:2, color:"var(--muted)", textTransform:"uppercase", marginBottom:2 }}>{k}</div><div style={{ fontSize:13, fontWeight:600 }}>{v||"—"}</div></div>
                        ))}
                      </div>
                      {foundDossier.retour && <div style={{ marginTop:10, padding:"8px 12px", background:"rgba(48,160,80,.1)", color:"#50c070", fontSize:12 }}>⚠ Dossier retour déjà existant — il sera écrasé.</div>}
                    </div>
                    <div className="card" style={{ marginBottom:14 }}>
                      <div className="g3">
                        <div><label>Date retour</label><input type="date" value={retForm.date} onChange={e => setRetForm({...retForm, date: e.target.value})}/></div>
                        <div><label>Horamètre retour (h)</label><input type="number" value={retForm.horametre} onChange={e => setRetForm({...retForm, horametre: e.target.value})} placeholder="1 380"/></div>
                        <div><label>Agent expert</label><input value={retForm.agent} onChange={e => setRetForm({...retForm, agent: e.target.value})} placeholder="Prénom Nom"/></div>
                      </div>
                    </div>
                    <div style={{ display:"flex", justifyContent:"space-between" }}>
                      <button className="btn btn-outline" onClick={() => { setFoundDossier(null); setSearchSerie(""); setSearchDone(false); }}>← Annuler</button>
                      <button className="btn btn-gold" onClick={() => { setRetZones({}); setRetPhotos({}); setRetDegats([]); setRetNote(""); setAiResults({}); setRetStep(1); }}>Démarrer expertise retour →</button>
                    </div>
                  </div>
                )}
                {!foundDossier && <div style={{ marginTop:8 }}><button className="btn btn-outline" onClick={goHome}>← Accueil</button></div>}
              </div>
            )}

            {retStep === 1 && foundDossier && (
              <div>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                  <div className="section-title" style={{ marginBottom:0 }}>État retour — zone par zone</div>
                  <button className="btn btn-ai btn-sm" disabled={aiGlobalLoading} onClick={analyzeAllZones}>
                    {aiGlobalLoading ? <span className="ai-thinking"><div className="ai-dot"/><div className="ai-dot"/><div className="ai-dot"/><span style={{ marginLeft:6 }}>Analyse en cours...</span></span> : "✦ Analyser tout avec l'IA"}
                  </button>
                </div>

                {zones.map(zone => {
                  const depZ = foundDossier.depart?.zones?.[zone.id];
                  const depP = foundDossier.depart?.photos?.[zone.id]||[];
                  const aiRes = aiResults[zone.id];
                  const isAiLoading = aiLoading[zone.id];
                  return (
                    <div key={zone.id} className="zone-row">
                      <div className="zone-header" onClick={() => setOpenZone(openZone === zone.id ? null : zone.id)}>
                        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                          <span style={{ color:"var(--gold)", fontSize:18, width:24 }}>{zone.icon}</span>
                          <span style={{ fontWeight:600 }}>{zone.label}</span>
                          {depZ?.etat && <span className="etat-tag" style={{ fontSize:10, opacity:.6, background:ETAT_COLORS[depZ.etat]+"11", color:ETAT_COLORS[depZ.etat], border:`1px solid ${ETAT_COLORS[depZ.etat]}33` }}>Départ: {depZ.etat}</span>}
                        </div>
                        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                          {aiRes && <span className="badge badge-ai">IA ✦</span>}
                          {isAiLoading && <span className="ai-thinking"><div className="ai-dot"/><div className="ai-dot"/><div className="ai-dot"/></span>}
                          {retZones[zone.id]?.etat && <span className="etat-tag" style={{ background:ETAT_COLORS[retZones[zone.id].etat]+"22", color:ETAT_COLORS[retZones[zone.id].etat], border:`1px solid ${ETAT_COLORS[retZones[zone.id].etat]}44` }}>{retZones[zone.id].etat}</span>}
                          <span style={{ color:"var(--muted)" }}>{openZone === zone.id ? "▲" : "▼"}</span>
                        </div>
                      </div>
                      {openZone === zone.id && (
                        <div className="zone-body">
                          {/* Résultat IA */}
                          {aiRes && (
                            <div className="ai-panel" style={{ marginBottom:14 }}>
                              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
                                <div style={{ fontSize:10, letterSpacing:2, color:"#a080f0", textTransform:"uppercase" }}>✦ Analyse IA — Confiance {aiRes.confiance}</div>
                              </div>
                              <div style={{ fontSize:13, color:"var(--text)", lineHeight:1.6, marginBottom:8 }}>{aiRes.resume}</div>
                              {aiRes.degats_suggeres?.length > 0 && (
                                <div style={{ fontSize:11, color:"#a080f0" }}>Dégâts cochés automatiquement : {aiRes.degats_suggeres.map(id => tarifs.find(t=>t.id===id)?.label).filter(Boolean).join(", ")}</div>
                              )}
                            </div>
                          )}

                          {/* Comparaison départ / retour */}
                          {zone.id === "tour_complet" ? (
                            <div>
                              {TOUR_ANGLES.map((angle, idx) => {
                                const key = `tour_complet_${angle.key}`;
                                const depPhoto = foundDossier.depart?.photos?.[key]?.[0];
                                const retPhoto = retPhotos[key]?.[0];
                                return (
                                  <div key={angle.key} style={{ marginBottom:12, border:"1px solid var(--border)", overflow:"hidden" }}>
                                    <div style={{ padding:"8px 12px", background:"var(--bg3)", fontSize:11, fontWeight:700, color:"var(--gold)", letterSpacing:1 }}>{idx+1}. {angle.label}</div>
                                    <div style={{ display:"flex", gap:2 }}>
                                      <div style={{ flex:1, padding:10, background:"var(--bg2)" }}>
                                        <div style={{ fontSize:9, letterSpacing:2, color:"var(--muted)", textTransform:"uppercase", marginBottom:6 }}>Départ</div>
                                        {depPhoto ? <img src={depPhoto.url} alt="" style={{ width:"100%", maxWidth:160, height:110, objectFit:"cover", border:"1px solid var(--border2)" }}/> : <div style={{ fontSize:12, color:"var(--muted)" }}>Pas de photo départ</div>}
                                      </div>
                                      <div style={{ flex:1, padding:10, background:"var(--bg2)", borderLeft:"1px solid var(--border)" }}>
                                        <div style={{ fontSize:9, letterSpacing:2, color:"var(--gold)", textTransform:"uppercase", marginBottom:6 }}>Retour</div>
                                        {retPhoto ? (
                                          <div style={{ position:"relative", display:"inline-block" }}>
                                            <img src={retPhoto.url} alt="" style={{ width:"100%", maxWidth:160, height:110, objectFit:"cover", border:"1px solid var(--border2)" }}/>
                                            <button className="btn btn-danger" onClick={() => removePhoto(key, 0, setRetPhotos)} style={{ position:"absolute", top:2, right:2, padding:"2px 5px", fontSize:9 }}>✕</button>
                                          </div>
                                        ) : (
                                          <div className="photo-add" style={{ width:120, height:88 }} onClick={async () => { const f = await pickFile({multiple:false}); if(f) addPhotos(f, key, setRetPhotos); }}>+</div>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                          <div style={{ display:"flex", gap:10, marginBottom:12 }}>
                            <div style={{ flex:1, background:"var(--bg3)", padding:10, border:"1px solid var(--border)" }}>
                              <div style={{ fontSize:9, letterSpacing:2, color:"var(--muted)", textTransform:"uppercase", marginBottom:6 }}>État départ</div>
                              {depZ?.etat ? <span className="etat-tag" style={{ background:ETAT_COLORS[depZ.etat]+"22", color:ETAT_COLORS[depZ.etat], border:`1px solid ${ETAT_COLORS[depZ.etat]}44` }}>{depZ.etat}</span> : <span style={{ fontSize:12, color:"var(--muted)" }}>—</span>}
                              {depZ?.note && <div style={{ fontSize:12, color:"var(--muted)", marginTop:4 }}>{depZ.note}</div>}
                              <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginTop:8 }}>{depP.map((p,i) => <img key={i} src={p.url} alt="" className="photo-thumb"/>)}</div>
                            </div>
                            <div style={{ flex:1, background:"var(--bg3)", padding:10, border:"1px solid var(--border)" }}>
                              <div style={{ fontSize:9, letterSpacing:2, color:"var(--gold)", textTransform:"uppercase", marginBottom:6 }}>État retour</div>
                              <select value={retZones[zone.id]?.etat||""} onChange={e => setZE(setRetZones, zone.id, e.target.value)} style={{ marginBottom:6 }}>
                                <option value="">-- Sélectionner --</option>
                                {ETAT_OPTIONS.map(o => <option key={o}>{o}</option>)}
                              </select>
                              <input value={retZones[zone.id]?.note||""} onChange={e => setZN(setRetZones, zone.id, e.target.value)} placeholder="Observation retour..." style={{ marginBottom:8 }}/>
                              <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                                {(retPhotos[zone.id]||[]).map((p,i) => (
                                  <div key={i} style={{ position:"relative" }}>
                                    <img src={p.url} alt="" className="photo-thumb"/>
                                    <button className="btn btn-danger" onClick={() => removePhoto(zone.id, i, setRetPhotos)} style={{ position:"absolute", top:2, right:2, padding:"2px 4px", fontSize:9 }}>✕</button>
                                  </div>
                                ))}
                                <div className="photo-add" style={{ width:64, height:48, fontSize:20 }} onClick={async () => { const f = await pickFile({multiple:true}); if(f) addPhotos(f, zone.id, setRetPhotos); }}>+</div>
                              </div>
                            </div>
                          </div>
                          )}

                          {zone.id !== "tour_complet" && (
                            <button className="btn btn-ai btn-sm" disabled={isAiLoading} onClick={() => analyzeZone(zone)}>
                              {isAiLoading ? "Analyse..." : "✦ Analyser cette zone avec l'IA"}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                <div style={{ display:"flex", justifyContent:"space-between", marginTop:14 }}>
                  <button className="btn btn-outline" onClick={() => setRetStep(0)}>← Retour</button>
                  <button className="btn btn-gold" onClick={() => setRetStep(2)}>Chiffrage →</button>
                </div>
              </div>
            )}

            {retStep === 2 && foundDossier && (
              <div>
                <div className="section-title">Chiffrage des dégâts</div>
                {Object.keys(aiResults).length > 0 && (
                  <div className="ai-panel" style={{ marginBottom:16 }}>
                    <div style={{ fontSize:10, letterSpacing:2, color:"#a080f0", textTransform:"uppercase", marginBottom:6 }}>✦ Dégâts pré-cochés par l'IA</div>
                    <div style={{ fontSize:12, color:"var(--muted)" }}>Vérifiez et ajustez ci-dessous. Vous pouvez cocher/décocher librement.</div>
                  </div>
                )}
                {zones.map(zone => {
                  const tz = tarifs.filter(t => t.zone === zone.id);
                  if (!tz.length) return null;
                  const aiSuggestedForZone = aiResults[zone.id]?.degats_suggeres || [];
                  return (
                    <div key={zone.id} style={{ marginBottom:14 }}>
                      <div style={{ fontSize:10, letterSpacing:3, color:"var(--muted)", textTransform:"uppercase", marginBottom:6, display:"flex", gap:8, alignItems:"center" }}>
                        <span style={{ color:"var(--gold)" }}>{zone.icon}</span>{zone.label}
                        {aiSuggestedForZone.length > 0 && <span className="badge badge-ai">IA: {aiSuggestedForZone.length} suggéré{aiSuggestedForZone.length>1?"s":""}</span>}
                      </div>
                      {tz.map(t => {
                        const isAiSuggested = aiSuggestedForZone.includes(t.id);
                        return (
                          <div key={t.id} className={`tarif-row ${retDegats.includes(t.id) ? "active" : ""} ${isAiSuggested ? "ai-suggest" : ""}`} onClick={() => setRetDegats(prev => prev.includes(t.id) ? prev.filter(d => d !== t.id) : [...prev, t.id])}>
                            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                              <div style={{ width:14, height:14, border:`1px solid ${retDegats.includes(t.id) ? "var(--gold)" : "var(--border2)"}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:10, color:"var(--gold)", flexShrink:0 }}>{retDegats.includes(t.id) ? "✓" : ""}</div>
                              <span style={{ fontSize:13 }}>{t.label}</span>
                              {isAiSuggested && <span style={{ fontSize:10, color:"#a080f0" }}>✦ IA</span>}
                            </div>
                            <span className="mono" style={{ color:"var(--gold)", fontSize:13 }}>{t.prix} €</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
                <div className="card" style={{ marginBottom:14 }}>
                  <label>Notes complémentaires</label>
                  <textarea value={retNote} onChange={e => setRetNote(e.target.value)} rows={3} placeholder="Observations, réserves..." style={{ resize:"vertical" }}/>
                </div>
                {retDegats.length > 0 && (
                  <div className="total-strip" style={{ marginBottom:14 }}>
                    <span style={{ fontSize:12, letterSpacing:2, textTransform:"uppercase", fontWeight:700 }}>Total retenue · {retDegats.length} poste{retDegats.length>1?"s":""}</span>
                    <span style={{ fontFamily:"'Share Tech Mono'", fontSize:30 }}>{totalRetenue.toLocaleString("fr-FR")} €</span>
                  </div>
                )}
                <div style={{ display:"flex", justifyContent:"space-between" }}>
                  <button className="btn btn-outline" onClick={() => setRetStep(1)}>← Retour</button>
                  <button className="btn btn-gold" onClick={async () => { const d = await saveRetour(); setActiveDossier(d); setView("rapport"); }}>Générer rapport →</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ════ RAPPORT ════ */}
        {view === "rapport" && activeDossier && (
          <div className="fade-in">
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
              <div className="section-title" style={{ marginBottom:0 }}>Rapport d'expertise</div>
              <div style={{ display:"flex", gap:8 }}>
                <button className="btn btn-outline btn-sm no-print" onClick={goHome}>← Dossiers</button>
                <button className="btn btn-gold btn-sm no-print" onClick={() => window.print()}>⬇ PDF</button>
              </div>
            </div>

            <div className="card" style={{ marginBottom:10 }}>
              <div className="g3">
                {[["Immatriculation",activeDossier.immat],["Véhicule",`${activeDossier.info?.marque} ${activeDossier.info?.modele}`],["Type",activeDossier.info?.type],["Client",activeDossier.info?.client],["Contrat",activeDossier.info?.contrat],["Email",activeDossier.info?.email],["Date départ",activeDossier.depart?.date],["Date retour",activeDossier.retour?.date||"—"],["Durée",activeDossier.depart?.date&&activeDossier.retour?.date?(()=>{const d=Math.round((new Date(activeDossier.retour.date)-new Date(activeDossier.depart.date))/864e5);return d+" jour"+(d>1?"s":"");})():"—"],["Horamètre départ",activeDossier.depart?.horametre?activeDossier.depart.horametre+" h":"—"],["Horamètre retour",activeDossier.retour?.horametre?activeDossier.retour.horametre+" h":"—"],["Heures utilisées",activeDossier.depart?.horametre&&activeDossier.retour?.horametre?(parseInt(activeDossier.retour.horametre)-parseInt(activeDossier.depart.horametre))+" h":"—"]].map(([k,v]) => (
                  <div key={k} style={{ marginBottom:6 }}><div style={{ fontSize:9, letterSpacing:2, color:"var(--muted)", textTransform:"uppercase", marginBottom:2 }}>{k}</div><div style={{ fontSize:13, fontWeight:600 }}>{v||"—"}</div></div>
                ))}
              </div>
            </div>

            <div style={{ fontSize:10, letterSpacing:3, color:"var(--gold)", textTransform:"uppercase", marginBottom:8, marginTop:14 }}>Comparaison départ / retour</div>
            {zones.map(zone => {
              const dep = activeDossier.depart?.zones?.[zone.id];
              const ret = activeDossier.retour?.zones?.[zone.id];
              const depP = activeDossier.depart?.photos?.[zone.id]||[];
              const retP = activeDossier.retour?.photos?.[zone.id]||[];
              const hasChange = dep?.etat !== ret?.etat && ret?.etat;
              const aiRes = activeDossier.retour?.aiResults?.[zone.id];
              return (
                <div key={zone.id} style={{ marginBottom:5, border:`1px solid ${hasChange?"rgba(192,48,48,.4)":"var(--border)"}`, overflow:"hidden" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 14px", background: hasChange ? "rgba(192,48,48,.06)" : "var(--bg3)" }}>
                    <span style={{ color:"var(--gold)" }}>{zone.icon}</span>
                    <span style={{ fontWeight:600, fontSize:14 }}>{zone.label}</span>
                    {hasChange && <span style={{ fontSize:11, color:"#e05050", marginLeft:"auto" }}>⚠ CHANGEMENT D'ÉTAT</span>}
                    {aiRes && <span className="badge badge-ai" style={{ marginLeft: hasChange ? 0 : "auto" }}>✦ IA</span>}
                  </div>
                  {aiRes?.resume && (
                    <div style={{ padding:"8px 14px", background:"rgba(96,64,192,.06)", borderBottom:"1px solid rgba(96,64,192,.2)", fontSize:12, color:"#a080f0" }}>✦ {aiRes.resume}</div>
                  )}
                  <div style={{ display:"flex", gap:2 }}>
                    {[{label:"DÉPART",z:dep,photos:depP},{label:"RETOUR",z:ret,photos:retP}].map(({label,z,photos}) => (
                      <div key={label} style={{ flex:1, padding:"10px 12px", background:"var(--bg2)", borderRight:label==="DÉPART"?"1px solid var(--border)":"none" }}>
                        <div style={{ fontSize:9, letterSpacing:2, color:"var(--muted)", textTransform:"uppercase", marginBottom:6 }}>{label}</div>
                        {z?.etat ? <span className="etat-tag" style={{ background:ETAT_COLORS[z.etat]+"22", color:ETAT_COLORS[z.etat], border:`1px solid ${ETAT_COLORS[z.etat]}44` }}>{z.etat}</span> : <span style={{ fontSize:12, color:"var(--muted)" }}>—</span>}
                        {z?.note && <div style={{ fontSize:12, color:"var(--muted)", marginTop:4 }}>{z.note}</div>}
                        <div style={{ display:"flex", flexWrap:"wrap", gap:4, marginTop:6 }}>{photos.map((p,i) => <img key={i} src={p.url} alt="" className="photo-thumb"/>)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {activeDossier.retour?.degats?.length > 0 && (
              <div style={{ marginTop:14 }}>
                <div style={{ fontSize:10, letterSpacing:3, color:"var(--gold)", textTransform:"uppercase", marginBottom:8 }}>Chiffrage retenue</div>
                <div className="card" style={{ marginBottom:10 }}>
                  {activeDossier.retour.degats.map(id => { const t = tarifs.find(t=>t.id===id); return t ? (
                    <div key={id} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid var(--border)", fontSize:13 }}>
                      <span>{t.label} <span style={{ fontSize:11, color:"var(--muted)" }}>· {zones.find(z=>z.id===t.zone)?.label}</span></span>
                      <span className="mono" style={{ color:"var(--gold)" }}>{t.prix} €</span>
                    </div>
                  ) : null; })}
                  <div className="total-strip" style={{ marginTop:12 }}>
                    <span style={{ fontSize:12, letterSpacing:2, textTransform:"uppercase", fontWeight:700 }}>TOTAL RETENUE</span>
                    <span style={{ fontFamily:"'Share Tech Mono'", fontSize:32 }}>{activeDossier.retour.degats.reduce((s,id)=>{const t=tarifs.find(t=>t.id===id);return s+(t?t.prix:0);},0).toLocaleString("fr-FR")} €</span>
                  </div>
                </div>
              </div>
            )}
            {!activeDossier.retour?.degats?.length && activeDossier.retour && (
              <div style={{ marginTop:12, padding:"14px 16px", border:"1px solid rgba(48,160,80,.3)", background:"rgba(48,160,80,.06)", color:"#50c070", fontSize:13 }}>✓ Aucun dégât constaté — nacelle rendue conforme</div>
            )}
            {activeDossier.retour?.note && <div className="card" style={{ marginTop:10 }}><div style={{ fontSize:9, letterSpacing:2, color:"var(--muted)", textTransform:"uppercase", marginBottom:6 }}>Notes</div><div style={{ fontSize:13, lineHeight:1.6, whiteSpace:"pre-wrap" }}>{activeDossier.retour.note}</div></div>}

            <div className="g2" style={{ marginTop:18 }}>
              {[["Expert départ",activeDossier.depart?.agent,activeDossier.depart?.date],["Expert retour",activeDossier.retour?.agent,activeDossier.retour?.date],["Client (accord état départ)",activeDossier.info?.client,""],["Client (accord retenue)",activeDossier.info?.client,""]].map(([l,n,d]) => (
                <div key={l} style={{ border:"1px solid var(--border)", padding:"12px 14px" }}>
                  <div style={{ fontSize:9, letterSpacing:2, color:"var(--muted)", textTransform:"uppercase", marginBottom:2 }}>{l}</div>
                  <div style={{ fontSize:12, marginBottom:28 }}>{n||"—"}{d?` · ${d}`:""}</div>
                  <div style={{ borderTop:"1px solid var(--border2)", paddingTop:4, fontSize:10, color:"var(--muted)" }}>Signature</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ════ MODAL ADMIN ════ */}
      {adminOpen && (
        <div className="modal-overlay" onClick={e => { if(e.target===e.currentTarget){setAdminOpen(false);setAdminAuthed(false);} }}>
          <div className="modal">
            {!adminAuthed ? (
              <div>
                <div style={{ fontFamily:"'Share Tech Mono'", fontSize:16, color:"var(--gold)", letterSpacing:3, marginBottom:20 }}>ACCÈS ADMIN</div>
                <label>Mot de passe</label>
                <input type="password" value={adminPwd} onChange={e => { setAdminPwd(e.target.value); setAdminPwdErr(false); }} onKeyDown={e => e.key==="Enter" && (adminPwd===ADMIN_PASSWORD ? (setAdminAuthed(true),setAdminPwd("")) : setAdminPwdErr(true))} placeholder="••••••••" autoFocus style={{ marginBottom:8 }}/>
                {adminPwdErr && <div style={{ color:"#e05050", fontSize:12, marginBottom:8 }}>Mot de passe incorrect</div>}
                <div style={{ display:"flex", justifyContent:"space-between", marginTop:14 }}>
                  <button className="btn btn-outline btn-sm" onClick={() => setAdminOpen(false)}>Annuler</button>
                  <button className="btn btn-gold btn-sm" onClick={() => adminPwd===ADMIN_PASSWORD ? (setAdminAuthed(true),setAdminPwd("")) : setAdminPwdErr(true)}>Accéder →</button>
                </div>
              </div>
            ) : (
              <div>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
                  <div style={{ fontFamily:"'Share Tech Mono'", fontSize:15, color:"var(--gold)", letterSpacing:3 }}>ADMINISTRATION</div>
                  <button className="btn btn-icon" onClick={() => { setAdminOpen(false); setAdminAuthed(false); }}>✕</button>
                </div>
                <div style={{ display:"flex", borderBottom:"1px solid var(--border)", marginBottom:18 }}>
                  {[["zones","Zones"],["tarifs","Postes tarifaires"]].map(([id,label]) => (
                    <div key={id} className={`tab ${adminTab===id?"active":""}`} onClick={() => { setAdminTab(id); setZoneEdit(null); setTarifEdit(null); }}>{label}</div>
                  ))}
                </div>
                {adminMsg && <div style={{ padding:"8px 12px", background:"rgba(48,160,80,.15)", color:"#50c070", border:"1px solid rgba(48,160,80,.3)", fontSize:13, marginBottom:14 }}>{adminMsg}</div>}

                {adminTab === "zones" && (
                  <div>
                    {zones.map((z,i) => (
                      <div key={z.id} className="admin-row">
                        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                          <span style={{ fontSize:18 }}>{z.icon}</span>
                          <span style={{ fontWeight:600 }}>{z.label}</span>
                          <span className="mono" style={{ fontSize:10, color:"var(--muted)" }}>{tarifs.filter(t=>t.zone===z.id).length} poste{tarifs.filter(t=>t.zone===z.id).length!==1?"s":""}</span>
                        </div>
                        <div style={{ display:"flex", gap:4 }}>
                          <button className="btn btn-icon" onClick={() => { setZoneEdit(i); setZoneForm({label:z.label,icon:z.icon}); }}>✏</button>
                          <button className="btn btn-icon" style={{ color:"var(--danger)" }} onClick={() => window.confirm(`Supprimer "${z.label}" ?`) && deleteZone(i)}>🗑</button>
                        </div>
                      </div>
                    ))}
                    <div style={{ marginTop:16, padding:14, border:"1px solid var(--border2)", background:"var(--bg3)" }}>
                      <div style={{ fontSize:11, letterSpacing:2, color:"var(--gold)", textTransform:"uppercase", marginBottom:10 }}>{zoneEdit!==null?"Modifier":"Nouvelle zone"}</div>
                      <div style={{ marginBottom:10 }}><label>Nom *</label><input value={zoneForm.label} onChange={e => setZoneForm({...zoneForm,label:e.target.value})} placeholder="Ex: Bras télescopique"/></div>
                      <label>Icône</label>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginTop:6, marginBottom:12 }}>
                        {ICONS.map(ic => <div key={ic} className={`icon-btn ${zoneForm.icon===ic?"sel":""}`} onClick={() => setZoneForm({...zoneForm,icon:ic})}>{ic}</div>)}
                      </div>
                      <div style={{ display:"flex", gap:8 }}>
                        {zoneEdit!==null && <button className="btn btn-outline btn-sm" onClick={() => { setZoneEdit(null); setZoneForm({label:"",icon:"⟋"}); }}>Annuler</button>}
                        <button className="btn btn-gold btn-sm" disabled={!zoneForm.label.trim()} onClick={saveZone}>{zoneEdit!==null?"Enregistrer":"Ajouter"}</button>
                      </div>
                    </div>
                  </div>
                )}

                {adminTab === "tarifs" && (
                  <div>
                    {zones.map(zone => {
                      const tz = tarifs.filter(t => t.zone === zone.id);
                      return (
                        <div key={zone.id} style={{ marginBottom:12 }}>
                          <div style={{ fontSize:10, letterSpacing:3, color:"var(--muted)", textTransform:"uppercase", marginBottom:6, display:"flex", gap:8, alignItems:"center" }}>
                            <span style={{ color:"var(--gold)" }}>{zone.icon}</span>{zone.label}
                          </div>
                          {tz.length === 0 && <div style={{ fontSize:12, color:"var(--muted)", padding:"8px 12px", border:"1px dashed var(--border)" }}>Aucun poste</div>}
                          {tz.map(t => {
                            const gi = tarifs.findIndex(x => x.id === t.id);
                            return (
                              <div key={t.id} className="admin-row">
                                <span style={{ fontSize:13 }}>{t.label}</span>
                                <div style={{ display:"flex", gap:10, alignItems:"center" }}>
                                  <span className="mono" style={{ color:"var(--gold)", fontSize:13 }}>{t.prix} €</span>
                                  <button className="btn btn-icon" onClick={() => { setTarifEdit(gi); setTarifForm({zone:t.zone,label:t.label,prix:String(t.prix)}); }}>✏</button>
                                  <button className="btn btn-icon" style={{ color:"var(--danger)" }} onClick={() => window.confirm(`Supprimer "${t.label}" ?`) && deleteTarif(gi)}>🗑</button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                    <div style={{ marginTop:16, padding:14, border:"1px solid var(--border2)", background:"var(--bg3)" }}>
                      <div style={{ fontSize:11, letterSpacing:2, color:"var(--gold)", textTransform:"uppercase", marginBottom:10 }}>{tarifEdit!==null?"Modifier":"Nouveau poste"}</div>
                      <div style={{ marginBottom:10 }}><label>Zone *</label>
                        <select value={tarifForm.zone} onChange={e => setTarifForm({...tarifForm,zone:e.target.value})}>
                          <option value="">-- Sélectionner --</option>
                          {zones.map(z => <option key={z.id} value={z.id}>{z.icon} {z.label}</option>)}
                        </select>
                      </div>
                      <div style={{ marginBottom:10 }}><label>Libellé *</label><input value={tarifForm.label} onChange={e => setTarifForm({...tarifForm,label:e.target.value})} placeholder="Ex: Fissure châssis"/></div>
                      <div style={{ marginBottom:12 }}><label>Prix € *</label><input type="number" value={tarifForm.prix} onChange={e => setTarifForm({...tarifForm,prix:e.target.value})} placeholder="250"/></div>
                      <div style={{ display:"flex", gap:8 }}>
                        {tarifEdit!==null && <button className="btn btn-outline btn-sm" onClick={() => { setTarifEdit(null); setTarifForm({zone:"",label:"",prix:""}); }}>Annuler</button>}
                        <button className="btn btn-gold btn-sm" disabled={!tarifForm.label.trim()||!tarifForm.zone||!tarifForm.prix} onClick={saveTarif}>{tarifEdit!==null?"Enregistrer":"Ajouter"}</button>
                      </div>
                    </div>
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
