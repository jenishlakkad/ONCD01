// Shared helpers for the single-item "Inquire" popup (product cards +
// product detail pages). Pure functions over a raw serialized product row
// (see server/lib/serializeProduct.js) — no DOM/state here, the popup's
// state/markup lives per-page next to the existing Inquiry Cart drawer.

export function inquiryTitle(p) {
  if (!p) return '';
  if (p.type === 'diamond') {
    return `${p.weightCarat || ''}ct ${p.shape || ''} Diamond`.replace(/\s+/g, ' ').trim();
  }
  if (p.type === 'jewelry') {
    return p.stoneName ? `${p.stoneName} Piece` : (p.category ? p.category.name : p.sku);
  }
  return p.title || p.sku;
}

export function inquirySpecRows(p) {
  if (!p) return [];
  if (p.type === 'diamond') {
    return [
      ['Weight', p.weightCarat ? `${p.weightCarat} ct` : null],
      ['Shape', p.shape],
      ['Color', p.color],
      ['Clarity', p.clarity],
      ['Measurements', p.measurements],
      ['Certificate', [p.certificateAuthority, p.certificateNumber].filter(Boolean).join(' ') || null],
    ].filter(([, value]) => value).map(([label, value]) => ({ label, value }));
  }
  if (p.type === 'jewelry') {
    return [
      ['Metal', [p.goldColor, p.metal].filter(Boolean).join(' ') || null],
      ['Purity', p.goldPurity],
      ['Gold Weight', p.goldWeightGrams ? `${p.goldWeightGrams} g` : null],
      ['Center Stone', p.stoneName],
      ['Stone Weight', p.weightCarat ? `${p.weightCarat} ct` : null],
    ].filter(([, value]) => value).map(([label, value]) => ({ label, value }));
  }
  return [];
}

export function inquiryPriceLabel(p) {
  if (!p) return '';
  return p.priceVisible ? '$' + Number(p.totalPrice).toLocaleString() : (p.priceLabel || 'Price on request');
}

export function inquiryMessage(p, note) {
  if (!p) return '';
  const title = inquiryTitle(p);
  const specLine = inquirySpecRows(p).map((r) => r.value).join(', ');
  const priceLabel = inquiryPriceLabel(p);
  const lines = [
    "Hello, I'd like to inquire about the following item:",
    '',
    `${p.sku} — ${title}${specLine ? ' (' + specLine + ')' : ''} — ${priceLabel}`,
  ];
  if (note && note.trim()) {
    lines.push('', 'Message from customer:', note.trim());
  }
  return lines.join('\n');
}
