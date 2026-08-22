// Applies admin-managed SEO meta (AdminSeo.dc.html) to the live public page.
export async function applySeo(pageKey) {
  try {
    const res = await fetch(`/api/seo/${encodeURIComponent(pageKey)}`, { credentials: 'same-origin' });
    const json = await res.json();
    if (!res.ok) return;
    const { metaTitle, metaDescription } = json.data || {};
    if (metaTitle) document.title = metaTitle;
    if (metaDescription) {
      let tag = document.querySelector('meta[name="description"]');
      if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute('name', 'description');
        document.head.appendChild(tag);
      }
      tag.setAttribute('content', metaDescription);
    }
  } catch {
    /* non-critical, leave default title */
  }
}
