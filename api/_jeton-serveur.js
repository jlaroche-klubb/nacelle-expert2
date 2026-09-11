// 🔐 Jeton Firebase « serveur » pour appeler les fonctions Delta VO protégées
// (/api/photo-orientation, /api/lire-devis…) depuis les fonctions Nacelle Expert.
// Le serveur n'a pas d'utilisateur connecté : il fabrique un jeton du projet
// nacelle-expert pour un compte technique (custom token → ID token via
// Identity Toolkit). La clé web est celle du front (publique) ; aucune
// variable Vercel à ajouter. Fichier préfixé « _ » : pas un endpoint.

const NE_WEB_API_KEY = "AIzaSyCmo1rTFoy1KnUc1rh_QVMtutwLguKnGb8";
const UID_SERVEUR = "serveur-nacelle-expert";
let cache = { token: "", expire: 0 };

export const DELTA_VO_API = "https://delta-vo.vercel.app/api";

export async function jetonServeur(admin, usage = "serveur") {
  if (cache.token && Date.now() < cache.expire) return cache.token;
  const custom = await admin.auth().createCustomToken(UID_SERVEUR, { service: usage });
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${NE_WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: custom, returnSecureToken: true }),
    }
  );
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.idToken) throw new Error("jeton serveur indisponible (" + r.status + ")");
  // ID token valable 1 h : gardé 50 min
  cache = { token: j.idToken, expire: Date.now() + 50 * 60 * 1000 };
  return j.idToken;
}
