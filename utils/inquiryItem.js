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

// *word* is the shared bold convention on WhatsApp and Skype (their compose
// boxes render single-asterisk-wrapped text as bold). LINE and plain-text
// email don't render it, but it still reads fine there as plain emphasis
// markers, so one message format works unchanged across all four channels.
function bold(text) {
  return `*${text}*`;
}

// customer is the shape returned by GET /api/auth/me (server/routes/auth.js
// publicCustomer()) - id, full_name, email, mobile, etc. - or null/undefined
// for a guest (guests can only ever reach this via the Email channel, which
// doesn't require a section explaining who they are).
export function inquiryMessage(p, note, customer) {
  if (!p) return '';
  const title = inquiryTitle(p);
  const priceLabel = inquiryPriceLabel(p);

  const lines = [
    "Hello, I'd like to inquire about the following item:",
    '',
    bold('PRODUCT DETAILS'),
    `SKU: ${p.sku}`,
    `Item: ${bold(title)}`,
  ];
  for (const row of inquirySpecRows(p)) {
    lines.push(`${row.label}: ${row.value}`);
  }
  lines.push(`Price: ${bold(priceLabel)}`);

  if (customer && customer.id) {
    lines.push(
      '',
      bold('CUSTOMER DETAILS'),
      `Customer ID: ${customer.id}`,
      `Name: ${bold(customer.full_name || '')}`,
      `Email: ${customer.email || ''}`,
    );
    if (customer.mobile) lines.push(`Phone: ${customer.mobile}`);
    if (customer.company_name) lines.push(`Company: ${customer.company_name}`);
  }

  if (note && note.trim()) {
    lines.push('', bold('MESSAGE'), note.trim());
  }

  return lines.join('\n');
}
