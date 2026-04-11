import { firebaseConfig } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getFirestore,
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, orderBy, onSnapshot, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getBytes, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-storage.js";

// NEW: auth (anonymous)
import {
  getAuth, signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const storage = getStorage(app);

// NEW: exported auth + helper
export const auth = getAuth(app);

let _signedIn = false;
/**
 * Ensures this browser session is authenticated (anonymous) so Storage rules
 * can require request.auth != null for writes/deletes.
 */
export async function ensureAnonAuth() {
  if (_signedIn) return;
  await signInAnonymously(auth);
  _signedIn = true;
}

export const fs = {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, orderBy, onSnapshot, addDoc, serverTimestamp
};

export const st = {
  ref, uploadBytes, getBytes, deleteObject
};
