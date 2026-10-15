const db = require('../db/postgres');
const { applyPriceVisibility } = require('./priceVisibility');
const { serializeProduct } = require('./serializeProduct');
const { toPublicMediaUrl } = require('./mediaUrl');
const { PUBLIC_FROM, PUBLIC_WHERE } = require('./publicProducts');
const { getMessagingSchema, NEWSLETTER_SUBJECT } = require('./messaging');

// Everything the customer's account dashboard shows — profile, inquiries
// with their items, saved items, the server-mirrored cart and the live
// catalog rows behind all of those SKUs — in ONE SQL statement.
//
// Every query to Supabase costs a ~150ms round trip (and ~1.2s when the pool
// has to open a connection), so the old page's chain of /auth/me ->
// /inquiries/mine (one query per inquiry) -> /saved-items took 2-4 seconds.
// The admin "Details" dialog reads the same snapshot, so the customer and
// the sales desk always see the same inquiries, statuses and saved items.
// Built per schema state: the thread columns/tables only exist once the
// messaging migration (lib/messaging.js) has been run.
function snapshotSql(schema) {
  const refCols = schema.inquiryRefs ? ', i.ref, i.note, i.updated_at' : '';
  const groupCols = schema.inquiryRefs ? ', i.ref, i.note, i.updated_at' : '';
  const threadCol = schema.inquiryThreads
    ? `, (SELECT COALESCE(json_agg(json_build_object('id', m.id, 'sender', m.sender, 'author', m.author_name,
                                                   'body', m.body, 'createdAt', m.created_at)
                                 ORDER BY m.created_at, m.id), '[]'::json)
           FROM inquiry_messages m WHERE m.inquiry_id = i.id) AS messages`
    : `, '[]'::json AS messages`;
  const inqOrder = schema.inquiryRefs ? 'COALESCE(inq.updated_at, inq.created_at) DESC, inq.id DESC' : 'inq.created_at DESC, inq.id DESC';
  const replySender = schema.contactReplies ? 'r.sender' : `'admin'`;
  return `
WITH me AS (
  SELECT * FROM customers WHERE id = $1
),
inq AS (
  SELECT i.id, i.channel, i.status, i.created_at${refCols}${threadCol},
         COALESCE(
           json_agg(json_build_object('sku', ii.sku, 'name', ii.name, 'qty', ii.qty, 'priceLabel', ii.price_label)
                    ORDER BY ii.id) FILTER (WHERE ii.id IS NOT NULL),
           '[]'::json) AS items
  FROM inquiries i LEFT JOIN inquiry_items ii ON ii.inquiry_id = i.id
  WHERE i.customer_id = $1
  GROUP BY i.id, i.channel, i.status, i.created_at${groupCols}
),
contact AS (
  -- The customer's own contact-form conversations: sent while signed in, or
  -- sent from their account email before signing in. Newsletter signups
  -- share the table but aren't conversations.
  SELECT cm.id, cm.subject, cm.message, cm.status, cm.created_at, cm.updated_at,
         (SELECT COALESCE(json_agg(json_build_object('id', r.id, 'sender', ${replySender}, 'author', r.admin_name,
                                                     'body', r.body, 'createdAt', r.created_at)
                                   ORDER BY r.created_at, r.id), '[]'::json)
            FROM contact_message_replies r WHERE r.message_id = cm.id) AS replies
  FROM contact_messages cm, me
  WHERE (cm.customer_id = me.id OR (cm.customer_id IS NULL AND lower(cm.email) = lower(me.email)))
    AND cm.subject <> '${NEWSLETTER_SUBJECT}'
),
saved AS (
  SELECT sku, name, price_label, product_type, created_at FROM saved_items WHERE customer_id = $1
),
cart AS (
  SELECT sku, name, price_label, qty, updated_at FROM cart_items WHERE customer_id = $1
),
skus AS (
  SELECT sku FROM saved
  UNION SELECT ii.sku FROM inquiry_items ii JOIN inquiries i ON i.id = ii.inquiry_id WHERE i.customer_id = $1
  UNION SELECT sku FROM cart
),
prods AS (
  SELECT p.*, c.name AS category_name, sc.name AS subcategory_name,
         (SELECT COALESCE(json_agg(json_build_object('id', m.id, 'kind', m.kind, 'url', m.url,
                                                     'sortOrder', m.sort_order, 'crop', m.crop)
                                   ORDER BY m.sort_order), '[]'::json)
            FROM product_media m WHERE m.product_id = p.id) AS media
  ${PUBLIC_FROM}
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN subcategories sc ON sc.id = p.subcategory_id
  WHERE ${PUBLIC_WHERE} AND p.sku IN (SELECT sku FROM skus)
)
SELECT
  (SELECT row_to_json(me) FROM me) AS me,
  (SELECT COALESCE(json_agg(inq ORDER BY ${inqOrder}), '[]'::json) FROM inq) AS inquiries,
  (SELECT COALESCE(json_agg(contact ORDER BY COALESCE(contact.updated_at, contact.created_at) DESC, contact.id DESC), '[]'::json) FROM contact) AS contact,
  (SELECT COALESCE(json_agg(saved ORDER BY saved.created_at DESC), '[]'::json) FROM saved) AS saved,
  (SELECT COALESCE(json_agg(cart ORDER BY cart.updated_at DESC), '[]'::json) FROM cart) AS cart,
  (SELECT COALESCE(json_agg(prods), '[]'::json) FROM prods) AS products,
  EXISTS (SELECT 1 FROM site_settings WHERE id = 1) AS has_settings,
  (SELECT price_mode FROM site_settings WHERE id = 1) AS price_mode,
  EXISTS (SELECT 1 FROM feature_flags WHERE key = 'prices') AS has_prices_flag,
  (SELECT enabled FROM feature_flags WHERE key = 'prices') AS prices_enabled
`;
}

const toMessage = (m) => ({ id: Number(m.id), sender: m.sender, author: m.author || '', body: m.body, createdAt: m.createdAt });

function publicCustomer(c) {
  const { password_hash, ...rest } = c;
  return { ...rest, id: Number(rest.id) };
}

// Same trimming as the homepage feed: a dashboard card only ever needs the
// cover photo and (for hover preview) the first video.
function trimMedia(media) {
  const list = Array.isArray(media) ? media : [];
  const image = list.find((m) => m.kind === 'image' && m.url);
  const video = list.find((m) => m.kind === 'video' && m.url);
  return [image, video].filter(Boolean).map((m) => ({
    id: Number(m.id),
    kind: m.kind,
    url: toPublicMediaUrl(m.url),
    sortOrder: m.sortOrder,
    crop: m.crop ? JSON.parse(m.crop) : null,
  }));
}

// row_to_json hands timestamps back as strings and numerics as JSON numbers;
// serializeProduct/applyPriceVisibility only reshape and mask, so the raw
// json row can go straight through them like a pg row would.
function serializeProducts(rows, priceContext) {
  const out = {};
  for (const row of rows) {
    const masked = applyPriceVisibility(row, priceContext.mode, priceContext.viewer, priceContext.pricesEnabled);
    out[row.sku] = serializeProduct({ ...masked, id: Number(row.id) }, {
      category: row.category_id ? { id: Number(row.category_id), name: row.category_name } : null,
      subcategory: row.subcategory_id ? { id: Number(row.subcategory_id), name: row.subcategory_name } : null,
      media: trimMedia(row.media),
    });
  }
  return out;
}

// Returns null when the customer doesn't exist. Prices are masked exactly as
// the storefront masks them for THIS customer, so the admin view shows what
// the customer sees.
async function loadAccountSnapshot(customerId) {
  const schema = await getMessagingSchema();
  const row = await db.get(snapshotSql(schema), [customerId]);
  if (!row || !row.me) return null;
  const me = publicCustomer(row.me);
  const priceContext = {
    mode: row.has_settings ? row.price_mode : 'approved',
    viewer: { type: 'customer', status: me.status },
    pricesEnabled: !row.has_prices_flag || !!row.prices_enabled,
  };
  return {
    me,
    inquiries: row.inquiries.map((i) => ({
      id: Number(i.id), ref: i.ref || null, channel: i.channel, status: i.status,
      note: i.note || '', createdAt: i.created_at, updatedAt: i.updated_at || i.created_at,
      items: i.items, messages: (i.messages || []).map(toMessage),
    })),
    contactMessages: row.contact.map((c) => ({
      id: Number(c.id), subject: c.subject, message: c.message, status: c.status,
      createdAt: c.created_at, updatedAt: c.updated_at || c.created_at, replies: (c.replies || []).map(toMessage),
    })),
    // What the UI may offer: replying in a thread needs the migration.
    messaging: { inquiryThreads: schema.inquiryThreads, contactReplies: schema.contactReplies },
    saved: row.saved.map((s) => ({
      sku: s.sku, name: s.name, priceLabel: s.price_label, productType: s.product_type, createdAt: s.created_at,
    })),
    cart: row.cart.map((c) => ({
      sku: c.sku, name: c.name, priceLabel: c.price_label, qty: c.qty, updatedAt: c.updated_at,
    })),
    // Keyed by SKU; only products a visitor could open right now. A SKU that
    // is missing here was hidden, archived or removed since it was saved or
    // inquired about.
    products: serializeProducts(row.products, priceContext),
  };
}

module.exports = { loadAccountSnapshot, publicCustomer };
