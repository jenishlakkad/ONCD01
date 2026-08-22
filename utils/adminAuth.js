// Shared helpers for AdminXxx.dc.html pages: session check + logout.
// Mirrors the dynamic-import pattern utils/cart.js already uses.

export async function fetchAdminSession() {
  try {
    const res = await fetch('/api/admin/auth/me', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data;
  } catch {
    return null;
  }
}

export async function logoutAdmin() {
  try {
    await fetch('/api/admin/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    /* ignore network error, still redirect */
  }
  window.location.href = 'AdminLogin.dc.html';
}
