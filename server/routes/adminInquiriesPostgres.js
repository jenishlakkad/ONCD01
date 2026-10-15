const express = require('express');
const db = require('../db/postgres');
const { asyncRoute, ApiError } = require('../middleware/errorHandler');
const requireAdmin = require('../middleware/requireAdminPostgres');
const requirePermission = require('../middleware/requirePermission');
const { writeAudit } = require('../lib/auditPostgres');
const { sendMail } = require('../lib/mailer');
const { toPublicMediaUrl } = require('../lib/mediaUrl');
const {
  MESSAGING_MIGRATION_SQL, INQUIRY_STATUSES, getMessagingSchema, updateInquiryStatus, cleanBody, siteOrigin, inquiryLabel,
} = require('../lib/messaging');

// The sales desk's Inquiries inbox (AdminInquiries.dc.html): every inquiry
// from customers and guests, the items asked about, and the conversation
// with the customer. Customer communication is one permission area, so this
// uses the same 'contact' permission as Contact Messages.

const router = express.Router();
router.use(requireAdmin, requirePermission('contact', 'manage'));

const LIST_LIMIT = 500;
const CHANNEL_LABELS = { whatsapp: 'WhatsApp', email: 'Email', line: 'LINE', skype: 'Skype' };

const idOf = (v) => (/^\d+$/.test(String(v)) ? String(v) : null);

router.get('/', asyncRoute(async (req, res) => {
  const schema = await getMessagingSchema();
  const refCols = schema.inquiryRefs ? 'i.ref, i.note, i.updated_at,' : 'NULL AS ref, NULL AS note, NULL AS updated_at,';
  const threadCols = schema.inquiryThreads
    ? `(SELECT COUNT(*) FROM inquiry_messages m WHERE m.inquiry_id = i.id) AS message_count,
       (SELECT json_build_object('sender', m.sender, 'body', left(m.body, 180), 'createdAt', m.created_at)
          FROM inquiry_messages m WHERE m.inquiry_id = i.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message`
    : '0 AS message_count, NULL::json AS last_message';
  const activity = schema.inquiryRefs ? 'COALESCE(i.updated_at, i.created_at)' : 'i.created_at';
  const [rows, counts] = await Promise.all([
    db.all(
      `SELECT i.id, i.channel, i.status, i.created_at, ${refCols}
              i.customer_id, c.full_name, c.company_name, c.email, c.mobile, i.guest_name, i.guest_email,
              COUNT(ii.id) AS item_count,
              COALESCE(json_agg(json_build_object('sku', ii.sku, 'name', ii.name, 'qty', ii.qty) ORDER BY ii.id)
                       FILTER (WHERE ii.id IS NOT NULL), '[]'::json) AS items,
              ${threadCols}
       FROM inquiries i
       LEFT JOIN customers c ON c.id = i.customer_id
       LEFT JOIN inquiry_items ii ON ii.inquiry_id = i.id
       GROUP BY i.id, c.id
       ORDER BY ${activity} DESC, i.id DESC
       LIMIT ${LIST_LIMIT}`
    ),
    db.all('SELECT status, COUNT(*) AS n FROM inquiries GROUP BY status'),
  ]);
  const byStatus = { pending: 0, replied: 0, closed: 0 };
  for (const r of counts) byStatus[r.status] = Number(r.n);
  res.json({
    data: {
      inquiries: rows.map((r) => ({
        id: Number(r.id), ref: r.ref, channel: r.channel, status: r.status, note: r.note || '',
        createdAt: r.created_at, updatedAt: r.updated_at || r.created_at,
        customer: r.customer_id ? {
          id: Number(r.customer_id), name: r.full_name, company: r.company_name || '', email: r.email, mobile: r.mobile || '',
        } : null,
        guest: r.customer_id ? null : { name: r.guest_name || '', email: r.guest_email || '' },
        itemCount: Number(r.item_count),
        items: (r.items || []).slice(0, 4),
        messageCount: Number(r.message_count),
        lastMessage: r.last_message || null,
      })),
      counts: { ...byStatus, all: byStatus.pending + byStatus.replied + byStatus.closed },
      limit: LIST_LIMIT,
      messaging: { inquiryThreads: schema.inquiryThreads },
      schemaReady: schema.ready,
      migrationSql: schema.ready ? null : MESSAGING_MIGRATION_SQL,
    },
  });
}));

async function loadInquiry(id, schema) {
  const row = await db.get(
    `SELECT i.id, i.channel, i.status, i.created_at, ${schema.inquiryRefs ? 'i.ref, i.note, i.updated_at,' : 'NULL AS ref, NULL AS note, NULL AS updated_at,'}
            i.customer_id, i.guest_name, i.guest_email,
            c.full_name, c.company_name, c.business_type, c.email, c.mobile, c.country, c.city, c.status AS customer_status,
            (SELECT COUNT(*) FROM inquiries o WHERE o.customer_id = i.customer_id AND o.id <> i.id) AS other_inquiries,
            (SELECT COUNT(*) FROM contact_messages cm WHERE cm.customer_id = i.customer_id) AS contact_count
     FROM inquiries i LEFT JOIN customers c ON c.id = i.customer_id
     WHERE i.id = $1`,
    [id]
  );
  if (!row) return null;
  const [items, messages] = await Promise.all([
    // Items with what the catalog says about them NOW, so the desk can see
    // at a glance if a piece was sold/hidden since the inquiry came in.
    db.all(
      `SELECT ii.sku, ii.name, ii.qty, ii.price_label AS "priceLabel",
              p.type, p.status AS product_status, p.visibility, COALESCE(pt.enabled, FALSE) AS type_enabled,
              (SELECT m.url FROM product_media m WHERE m.product_id = p.id AND m.kind = 'image' ORDER BY m.sort_order LIMIT 1) AS image
       FROM inquiry_items ii
       LEFT JOIN products p ON p.sku = ii.sku
       LEFT JOIN product_types pt ON pt.key = p.type
       WHERE ii.inquiry_id = $1 ORDER BY ii.id`,
      [id]
    ),
    schema.inquiryThreads
      ? db.all(
        `SELECT id, sender, author_name AS author, body, emailed, created_at AS "createdAt"
         FROM inquiry_messages WHERE inquiry_id = $1 ORDER BY created_at, id`,
        [id]
      )
      : Promise.resolve([]),
  ]);
  return {
    id: Number(row.id), ref: row.ref, channel: row.channel, channelLabel: CHANNEL_LABELS[row.channel] || row.channel,
    status: row.status, note: row.note || '', createdAt: row.created_at, updatedAt: row.updated_at || row.created_at,
    customer: row.customer_id ? {
      id: Number(row.customer_id), name: row.full_name, company: row.company_name || '', businessType: row.business_type || '',
      email: row.email, mobile: row.mobile || '', location: [row.city, row.country].filter(Boolean).join(', '),
      status: row.customer_status, otherInquiries: Number(row.other_inquiries), contactMessages: Number(row.contact_count),
    } : null,
    guest: row.customer_id ? null : { name: row.guest_name || '', email: row.guest_email || '' },
    items: items.map((it) => ({
      sku: it.sku, name: it.name || it.sku, qty: it.qty, priceLabel: it.priceLabel || '', type: it.type || null,
      image: it.image ? toPublicMediaUrl(it.image) : null,
      // live = a visitor could open it on the storefront right now
      availability: !it.type ? 'deleted'
        : it.product_status === 'active' && it.visibility === 'visible' && it.type_enabled ? 'live'
          : it.product_status !== 'active' ? it.product_status : 'hidden',
    })),
    messages: messages.map((m) => ({ ...m, id: Number(m.id) })),
  };
}

router.get('/:id', asyncRoute(async (req, res) => {
  const id = idOf(req.params.id);
  const schema = await getMessagingSchema();
  const inquiry = id && await loadInquiry(id, schema);
  if (!inquiry) throw new ApiError(404, 'Inquiry not found.');
  res.json({ data: { ...inquiry, messaging: { inquiryThreads: schema.inquiryThreads } } });
}));

router.put('/:id', asyncRoute(async (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!INQUIRY_STATUSES.includes(status)) throw new ApiError(400, 'Status must be pending, replied or closed.');
  const updated = await updateInquiryStatus({ id: req.params.id, status, actor: req.adminUser.full_name });
  if (!updated) throw new ApiError(404, 'Inquiry not found.');
  res.json({ data: updated });
}));

// The desk's reply: stored in the thread (the customer sees it in their
// dashboard), marks the inquiry Replied, and — unless switched off — emails
// it to the customer with a link back to the conversation.
router.post('/:id/messages', asyncRoute(async (req, res) => {
  const schema = await getMessagingSchema();
  if (!schema.inquiryThreads) throw new ApiError(409, 'Run the messaging setup SQL first (see the banner on the Inquiries page).');
  const id = idOf(req.params.id);
  const inquiry = id && await loadInquiry(id, schema);
  if (!inquiry) throw new ApiError(404, 'Inquiry not found.');
  const body = cleanBody((req.body || {}).message);
  if (!body) throw new ApiError(400, 'Write a reply before sending.');
  const wantsEmail = (req.body || {}).email !== false;
  const to = inquiry.customer ? inquiry.customer.email : inquiry.guest.email;

  const message = await db.transaction(async (client) => {
    const r = await client.query(
      `INSERT INTO inquiry_messages (inquiry_id, sender, author_name, body) VALUES ($1, 'admin', $2, $3)
       RETURNING id, sender, author_name AS author, body, emailed, created_at AS "createdAt"`,
      [inquiry.id, req.adminUser.full_name, body]
    );
    await client.query("UPDATE inquiries SET status = 'replied', updated_at = NOW() WHERE id = $1", [inquiry.id]);
    return r.rows[0];
  });

  let emailed = false;
  if (wantsEmail && to) {
    const itemsLine = inquiry.items.map((it) => `• ${it.name} (SKU ${it.sku}) × ${it.qty}`).join('\n');
    const link = inquiry.customer
      ? `\n\nView and reply to this conversation in your account:\n${siteOrigin(req)}/Dashboard.dc.html?tab=inquiries&inquiry=${inquiry.id}`
      : '';
    const result = await sendMail({
      to,
      subject: `Re: your inquiry ${inquiryLabel(inquiry)} — ONCD`,
      text: `${body}\n\n— ${req.adminUser.full_name}, ONCD sales desk\n\nYour inquiry ${inquiryLabel(inquiry)}:\n${itemsLine}${link}`,
    });
    emailed = !result.error;
    if (emailed) await db.query('UPDATE inquiry_messages SET emailed = TRUE WHERE id = $1', [message.id]);
  }

  await writeAudit({
    actor: req.adminUser.full_name, action: `Replied to inquiry ${inquiryLabel(inquiry)}`,
    target: inquiry.customer ? inquiry.customer.name : (inquiry.guest.name || inquiry.guest.email || 'Guest'), module: 'Inquiries',
  });
  res.status(201).json({ data: { message: { ...message, id: Number(message.id), emailed }, status: 'replied', emailed, emailTo: wantsEmail ? to || null : null } });
}));

module.exports = router;
