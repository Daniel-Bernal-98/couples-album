import { firebaseConfig } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, query, orderBy, onSnapshot, addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getBytes
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-storage.js";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);

export const fs = {
  doc, getDoc, setDoc, collection, query, orderBy, onSnapshot, addDoc, serverTimestamp
};

export const st = {
  ref, uploadBytes, getBytes
};
