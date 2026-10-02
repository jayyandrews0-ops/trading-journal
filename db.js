// Promise-based IndexedDB wrapper for the "trading-journal" database.

const DB_NAME = 'trading-journal';
const DB_VERSION = 2;
const STORE = 'trades';
const ANNOTATIONS = 'annotations';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('date', 'date', { unique: false });
        store.createIndex('symbol', 'symbol', { unique: false });
      }
      if (!db.objectStoreNames.contains(ANNOTATIONS)) {
        // user annotations for live MT5 positions, keyed by positionId
        db.createObjectStore(ANNOTATIONS, { keyPath: 'positionId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function getAll() {
  return open().then((db) =>
    reqToPromise(db.transaction(STORE, 'readonly').objectStore(STORE).getAll()));
}

export function get(id) {
  return open().then((db) =>
    reqToPromise(db.transaction(STORE, 'readonly').objectStore(STORE).get(id)));
}

// add() or put(): returns the stored id.
export function put(trade) {
  return open().then((db) =>
    reqToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).put(trade)));
}

export function remove(id) {
  return open().then((db) =>
    reqToPromise(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id)));
}

/* ---- annotations (live positions) ---- */

export function getAllAnnotations() {
  return open().then((db) =>
    reqToPromise(db.transaction(ANNOTATIONS, 'readonly').objectStore(ANNOTATIONS).getAll()));
}

export function putAnnotation(a) {
  return open().then((db) =>
    reqToPromise(db.transaction(ANNOTATIONS, 'readwrite').objectStore(ANNOTATIONS).put(a)));
}

export function removeAnnotation(positionId) {
  return open().then((db) =>
    reqToPromise(db.transaction(ANNOTATIONS, 'readwrite').objectStore(ANNOTATIONS).delete(positionId)));
}
