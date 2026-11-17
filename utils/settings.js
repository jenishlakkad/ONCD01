// Public site settings (site identity + inquiry contact channels), admin-managed
// via AdminSettings.dc.html. Used so contact buttons/links always reflect the
// current WhatsApp/email/LINE/Skype values instead of hardcoded ones.
export async function fetchPublicSettings() {
  try {
    const res = await fetch('/api/settings/public', { credentials: 'same-origin' });
    const json = await res.json();
    if (!res.ok) throw new Error();
    // Remembered so the next page shows the real contact details at once
    // (pages read this synchronously for their first paint).
    try { localStorage.setItem('oncd_public_settings_v1', JSON.stringify(json.data || {})); } catch {}
    return json.data;
  } catch {
    try {
      const cached = JSON.parse(localStorage.getItem('oncd_public_settings_v1') || 'null');
      if (cached) return cached;
    } catch {}
    return { siteName: 'ONCD', supportEmail: '', whatsapp: '', inquiryEmail: '', lineId: '', skypeId: '', priceMode: 'approved' };
  }
}
