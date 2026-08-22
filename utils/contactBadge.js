// Shared "new contact messages" count for the admin sidebar badge — imported
// identically by every Admin*.dc.html page (same pattern as utils/adminAuth.js).

export async function fetchNewContactCount() {
  try {
    const res = await fetch('/api/admin/contact/new-count', { credentials: 'same-origin' });
    if (!res.ok) return 0;
    const json = await res.json();
    return json.data && typeof json.data.count === 'number' ? json.data.count : 0;
  } catch {
    return 0;
  }
}
