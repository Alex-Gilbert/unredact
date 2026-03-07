// @ts-check
/// <reference path="types.js" />

const DB_NAME = 'unredact-db';
const DB_VERSION = 1;

/** @type {IDBDatabase|null} */
let db = null;

/**
 * Open (or create) the database. Caches the connection.
 * @returns {Promise<IDBDatabase>}
 */
export async function openDb() {
    if (db) return db;
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const d = /** @type {IDBOpenDBRequest} */ (e.target).result;
            if (!d.objectStoreNames.contains('documents')) {
                d.createObjectStore('documents', { keyPath: 'docId', autoIncrement: true });
            }
            if (!d.objectStoreNames.contains('pages')) {
                d.createObjectStore('pages', { keyPath: ['docId', 'pageNum'] });
            }
            if (!d.objectStoreNames.contains('solutions')) {
                const store = d.createObjectStore('solutions', { keyPath: ['docId', 'pageNum', 'redactionId'] });
                store.createIndex('docId', 'docId', { unique: false });
            }
            if (!d.objectStoreNames.contains('fonts')) {
                d.createObjectStore('fonts', { keyPath: 'fontId' });
            }
            if (!d.objectStoreNames.contains('settings')) {
                d.createObjectStore('settings', { keyPath: 'key' });
            }
        };
        req.onsuccess = () => { db = req.result; resolve(db); };
        req.onerror = () => reject(req.error);
    });
}

// --- Documents ---

/** @param {{ name: string, pageCount: number }} doc */
export async function saveDocument(doc) {
    const d = await openDb();
    return new Promise((resolve, reject) => {
        const tx = d.transaction('documents', 'readwrite');
        const store = tx.objectStore('documents');
        const req = store.add({ ...doc, createdAt: Date.now() });
        req.onsuccess = () => resolve(req.result); // returns auto-generated docId
        req.onerror = () => reject(req.error);
    });
}

/** @param {number} docId */
export async function getDocument(docId) {
    const d = await openDb();
    return new Promise((resolve, reject) => {
        const tx = d.transaction('documents', 'readonly');
        const req = tx.objectStore('documents').get(docId);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function listDocuments() {
    const d = await openDb();
    return new Promise((resolve, reject) => {
        const tx = d.transaction('documents', 'readonly');
        const req = tx.objectStore('documents').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** @param {number} docId */
export async function deleteDocument(docId) {
    const d = await openDb();
    return new Promise((resolve, reject) => {
        const tx = d.transaction(['documents', 'pages', 'solutions'], 'readwrite');
        tx.objectStore('documents').delete(docId);
        // Also delete all pages and solutions for this doc
        const pageStore = tx.objectStore('pages');
        const solStore = tx.objectStore('solutions');
        const solIdx = solStore.index('docId');

        // Delete pages by cursor (compound key means we can't just delete by docId)
        const pageCursor = pageStore.openCursor();
        pageCursor.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
                if (cursor.value.docId === docId) cursor.delete();
                cursor.continue();
            }
        };

        const solCursor = solIdx.openCursor(IDBKeyRange.only(docId));
        solCursor.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) { cursor.delete(); cursor.continue(); }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// --- Pages ---

/**
 * @param {number} docId
 * @param {number} pageNum
 * @param {object} data - { imageBlob?, ocrLines?, redactions?, fonts? }
 */
export async function savePage(docId, pageNum, data) {
    const d = await openDb();
    return new Promise((resolve, reject) => {
        const tx = d.transaction('pages', 'readwrite');
        const store = tx.objectStore('pages');
        const req = store.put({ docId, pageNum, ...data });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

/**
 * @param {number} docId
 * @param {number} pageNum
 */
export async function getPage(docId, pageNum) {
    const d = await openDb();
    return new Promise((resolve, reject) => {
        const tx = d.transaction('pages', 'readonly');
        const req = tx.objectStore('pages').get([docId, pageNum]);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Update a single field on a page record (merge, don't overwrite).
 * @param {number} docId
 * @param {number} pageNum
 * @param {string} field
 * @param {*} value
 */
export async function updatePageField(docId, pageNum, field, value) {
    const d = await openDb();
    return new Promise((resolve, reject) => {
        const tx = d.transaction('pages', 'readwrite');
        const store = tx.objectStore('pages');
        const getReq = store.get([docId, pageNum]);
        getReq.onsuccess = () => {
            const existing = getReq.result || { docId, pageNum };
            existing[field] = value;
            const putReq = store.put(existing);
            putReq.onsuccess = () => resolve();
            putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
    });
}

// --- Solutions ---

/**
 * @param {number} docId
 * @param {number} pageNum
 * @param {string} redactionId
 * @param {object} solution
 */
export async function saveSolution(docId, pageNum, redactionId, solution) {
    const d = await openDb();
    return new Promise((resolve, reject) => {
        const tx = d.transaction('solutions', 'readwrite');
        const req = tx.objectStore('solutions').put({ docId, pageNum, redactionId, ...solution });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

// --- Settings ---

/**
 * @param {string} key
 * @returns {Promise<*>}
 */
export async function getSetting(key) {
    const d = await openDb();
    return new Promise((resolve, reject) => {
        const tx = d.transaction('settings', 'readonly');
        const req = tx.objectStore('settings').get(key);
        req.onsuccess = () => resolve(req.result?.value ?? null);
        req.onerror = () => reject(req.error);
    });
}

/**
 * @param {string} key
 * @param {*} value
 */
export async function setSetting(key, value) {
    const d = await openDb();
    return new Promise((resolve, reject) => {
        const tx = d.transaction('settings', 'readwrite');
        const req = tx.objectStore('settings').put({ key, value });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

// --- Fonts ---

/**
 * @param {string} fontId
 * @param {string} name
 * @param {Blob} blob
 */
export async function saveUserFont(fontId, name, blob) {
    const d = await openDb();
    return new Promise((resolve, reject) => {
        const tx = d.transaction('fonts', 'readwrite');
        const req = tx.objectStore('fonts').put({ fontId, name, blob, source: 'user' });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
    });
}

export async function getUserFonts() {
    const d = await openDb();
    return new Promise((resolve, reject) => {
        const tx = d.transaction('fonts', 'readonly');
        const req = tx.objectStore('fonts').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
