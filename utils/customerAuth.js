// Shared helper for customer-facing pages: session check + logout, plus a
// non-sensitive localStorage hint so nav bars can render the correct
// logged-in/guest branch on first paint instead of flashing guest UI while
// the real session check is in flight.

const HINT_KEY = 'aurum_session_hint';
// Dashboard.dc.html's last-seen account snapshot (instant paint on revisit).
// Personal data, so it goes whenever the session does.
const ACCOUNT_CACHE_KEY = 'oncd_account_cache_v1';

// Read synchronously in page state initializers, e.g.:
//   customer: hasSessionHint() ? {} : null
// This is only a paint hint, never a security boundary — the real check is
// always fetchCustomerSession() / the server session.
export function hasSessionHint() {
  try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; }
}

// Called right after a successful login. A cached dashboard from an earlier
// session on this device may belong to a different account, so it's dropped.
export function setSessionHint() {
  try { localStorage.setItem(HINT_KEY, '1'); localStorage.removeItem(ACCOUNT_CACHE_KEY); } catch {}
}

export async function fetchCustomerSession() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) {
      try { localStorage.removeItem(HINT_KEY); localStorage.removeItem(ACCOUNT_CACHE_KEY); } catch {}
      return null;
    }
    const json = await res.json();
    return json.data;
  } catch {
    return null;
  }
}

export async function logoutCustomer() {
  try {
    const { clearCart } = await import('./cart.js');
    clearCart();
  } catch {
    /* ignore */
  }
  try { localStorage.removeItem('aurum_session_hint'); localStorage.removeItem(ACCOUNT_CACHE_KEY); } catch {}
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    /* ignore network error, still redirect */
  }
  window.location.href = 'Home.dc.html';
}
