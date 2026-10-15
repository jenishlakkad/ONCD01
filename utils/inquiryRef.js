// Inquiry reference numbers (e.g. "ONCD-7K3Q9A") that tie the message a
// customer sends on WhatsApp / Email / LINE / Skype to the inquiry stored
// for the sales desk and shown in the customer's account.
//
// The reference has to be in the outgoing message text, and that text is
// built before the customer clicks a channel button — so it's chosen up
// front, per set of items: the same cart (same SKUs and quantities) keeps
// the same reference until it goes 30 minutes unused. A repeated click therefore re-sends the
// same reference and the server treats it as the same inquiry instead of
// creating a duplicate. The note typed with the message is remembered the
// same way so submitInquiry() can store it alongside.

const KEY = 'oncd_inquiry_refs_v1';
const TTL_MS = 30 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I look-alikes
const notes = new Map();

export function itemsSignature(items) {
  return (items || []).map((i) => `${i.sku}:${Number(i.qty) || 1}`).sort().join('|');
}

function randomRef() {
  let out = '';
  try {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  } catch {
    for (let i = 0; i < 6; i++) out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return `ONCD-${out}`;
}

function readStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function refFor(items) {
  const sig = itemsSignature(items);
  if (!sig) return '';
  const now = Date.now();
  const store = readStore();
  for (const k of Object.keys(store)) if (!store[k] || now - store[k].at > TTL_MS) delete store[k];
  // Sliding window: every render of the message keeps it alive, so the
  // reference in an already-built link can't expire before the click.
  store[sig] = { ref: store[sig] ? store[sig].ref : randomRef(), at: now };
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch {}
  return store[sig].ref;
}

export function rememberNote(items, note) {
  notes.set(itemsSignature(items), String(note || '').trim());
}

export function pendingFor(items) {
  return { ref: refFor(items), note: notes.get(itemsSignature(items)) || '' };
}
