// Shared admin sidebar badges — imported identically by every Admin*.dc.html
// page (same pattern as utils/adminAuth.js). One request returns both:
// unread contact messages and inquiries awaiting the desk's reply.

export async function fetchInboxCounts() {
  try {
    const res = await fetch('/api/admin/contact/new-count', { credentials: 'same-origin' });
    if (!res.ok) return { contact: 0, inquiries: 0 };
    const json = await res.json();
    const d = json.data || {};
    return { contact: Number(d.count) || 0, inquiries: Number(d.inquiries) || 0 };
  } catch {
    return { contact: 0, inquiries: 0 };
  }
}

export async function fetchNewContactCount() {
  return (await fetchInboxCounts()).contact;
}
