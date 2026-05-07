// src/firebase.js
// ─────────────────────────────────────────────────────────────────────────────
// Configuration Firebase avec Authentication
// ─────────────────────────────────────────────────────────────────────────────

import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyCmo1rTFoy1KnUc1rh_QVMtutwLguKnGb8",
  authDomain: "nacelle-expert.firebaseapp.com",
  projectId: "nacelle-expert",
  storageBucket: "nacelle-expert.firebasestorage.app",
  messagingSenderId: "839235044652",
  appId: "1:839235044652:web:ad99f43eae0527239b1889"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();
