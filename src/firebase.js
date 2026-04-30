import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

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