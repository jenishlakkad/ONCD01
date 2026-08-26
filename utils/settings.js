// Public site settings (site identity + inquiry contact channels), admin-managed
// via AdminSettings.dc.html. Used so contact buttons/links always reflect the
// current WhatsApp/email/LINE/Skype values instead of hardcoded ones.
export async function fetchPublicSettings() {
  try {
    const res = await fetch('/api/settings/public', { credentials: 'same-origin' });
    const json = await res.json();
    if (!res.ok) throw new Error();
    return json.data;
  } catch {
    return { siteName: 'ONCD', supportEmail: '', whatsapp: '', inquiryEmail: '', lineId: '', skypeId: '', priceMode: 'approved' };
  }
}
