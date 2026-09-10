// 🔐 Contrôle du RÔLE après vérification du jeton Firebase — Nacelle Expert.
// La connexion Google est ouverte à tous (compte « en attente ») : un jeton
// valide ne suffit donc pas pour envoyer des emails au nom de Delta Services.
// Fichier préfixé « _ » : non exposé comme endpoint Vercel.

const ROLES_DEFAUT = ["expert", "admin", "superadmin"];

/**
 * Vérifie `Authorization: Bearer <idToken>` puis lit users/{uid}.role.
 * Renvoie { uid, email, role } ou null après avoir répondu 401/403.
 */
export async function exigerRole(admin, req, res, roles = ROLES_DEFAUT) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) { res.status(401).json({ error: "Non authentifié" }); return null; }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch {
    res.status(401).json({ error: "Jeton invalide ou expiré" });
    return null;
  }
  let role = "";
  try {
    const snap = await admin.firestore().collection("users").doc(decoded.uid).get();
    role = snap.exists ? String(snap.data().role || "") : "";
  } catch (e) {
    console.error("Lecture du rôle impossible :", e);
  }
  if (!roles.includes(role)) {
    res.status(403).json({ error: "Droits insuffisants (compte en attente d'approbation ou rôle non autorisé)" });
    return null;
  }
  return { uid: decoded.uid, email: decoded.email || "", role };
}

/** Clé d'accès d'un rapport : lue sur le dossier, créée si absente (anciens dossiers). */
export async function cleRapport(admin, immat) {
  const ref = admin.firestore().collection("dossiers").doc(String(immat || "").toUpperCase().trim());
  const snap = await ref.get();
  if (!snap.exists) return { cle: "", dossier: null };
  const d = snap.data();
  let cle = d.rapport_token || "";
  if (!cle) {
    const { randomBytes } = await import("crypto");
    cle = randomBytes(24).toString("hex");
    await ref.set({ rapport_token: cle, rapport_token_created: new Date().toISOString() }, { merge: true });
  }
  return { cle, dossier: d };
}

/** Lien complet du rapport (avec clé) pour les emails. */
export function lienRapport(appUrl, immat, cle) {
  return `${appUrl}/api/rapport/${encodeURIComponent(immat)}${cle ? `?cle=${encodeURIComponent(cle)}` : ""}`;
}
