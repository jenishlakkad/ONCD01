// Branded HTML emails (with plain-text twins) for every message the site
// sends: verification codes, contact / inquiry conversations, desk alerts
// and account updates.
//
// Email clients ignore <style> sheets and modern CSS, so the layout is a
// classic 600px table with inline styles only: it renders the same in
// Gmail (web/app), Outlook, Apple Mail and Yahoo, scales down on phones,
// and keeps the site's look (dark header, cream page, gold accents,
// Georgia headings). Anything a visitor typed is HTML-escaped.
const db = require('../db/postgres');
const { setSenderName } = require('./mailer');
const { customerCode } = require('./customerCode');

const C = {
  page: '#f3efe6', card: '#ffffff', ink: '#221f1c', muted: '#6b6459', line: '#e2dbcb',
  dark: '#201d18', gold: '#9c7a2e', goldLight: '#e0c583', goldTint: '#f8f1e1',
};
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";

// ── brand details (Admin > Settings), cached briefly ───────────────────────
let brandCache = { at: 0, value: null };
async function getBrand() {
  if (brandCache.value && Date.now() - brandCache.at < 60 * 1000) return brandCache.value;
  let s = {};
  try { s = (await db.get('SELECT * FROM site_settings WHERE id = 1')) || {}; } catch { /* defaults below */ }
  const value = {
    name: s.site_name || 'ONCD',
    email: s.support_email || s.inquiry_email || '',
    deskEmail: s.inquiry_email || s.support_email || '',
    phone: s.whatsapp_number || '',
    places: 'New York · Antwerp · Surat',
  };
  setSenderName(value.name);
  brandCache = { at: Date.now(), value };
  return value;
}

// ── small helpers ──────────────────────────────────────────────────────────
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Visitor text: escaped, line breaks kept.
function multiline(v) {
  return esc(String(v || '').replace(/\r\n/g, '\n').trim()).replace(/\n/g, '<br>');
}
function firstName(name) {
  const n = String(name || '').trim().split(/\s+/)[0];
  return n ? n.slice(0, 40) : '';
}
function greeting(name) {
  const f = firstName(name);
  return f ? `Hello ${f},` : 'Hello,';
}

const p = (html, style = '') => `<p style="margin:0 0 16px;font-family:${SANS};font-size:15px;line-height:1.6;color:${C.ink};${style}">${html}</p>`;
const small = (html, style = '') => `<p style="margin:0 0 12px;font-family:${SANS};font-size:13px;line-height:1.55;color:${C.muted};${style}">${html}</p>`;
const h1 = (html) => `<h1 class="oncd-h1" style="margin:0 0 18px;font-family:${SERIF};font-size:26px;line-height:1.25;font-weight:normal;color:${C.ink};">${html}</h1>`;
const kicker = (text) => `<div style="margin:0 0 10px;font-family:${SANS};font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;color:${C.gold};">${esc(text)}</div>`;
const spacer = (h) => `<div style="height:${h}px;line-height:${h}px;font-size:1px;">&nbsp;</div>`;

// Bulletproof button: a table cell with a background colour, so it shows as
// a button even in Outlook (which ignores padding on links).
function button(label, href) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 22px;"><tr>
    <td align="center" bgcolor="${C.gold}" style="border-radius:6px;background:${C.gold};">
      <a href="${esc(href)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${SANS};font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">${esc(label)}</a>
    </td></tr></table>`;
}

// The message someone wrote, set apart as a quote.
function quote(text, label) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;"><tr>
    <td style="border-left:3px solid ${C.gold};background:${C.goldTint};padding:14px 18px;border-radius:0 6px 6px 0;">
      ${label ? `<div style="font-family:${SANS};font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:bold;color:${C.gold};margin-bottom:6px;">${esc(label)}</div>` : ''}
      <div style="font-family:${SANS};font-size:15px;line-height:1.6;color:${C.ink};">${multiline(text)}</div>
    </td></tr></table>`;
}

// Label / value rows (contact details, account details).
function details(rows) {
  const list = rows.filter((r) => r && r[1]);
  if (!list.length) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border:1px solid ${C.line};border-radius:8px;border-collapse:separate;">
    ${list.map(([label, value, href], i) => `<tr>
      <td style="padding:10px 14px;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${SANS};font-size:13px;color:${C.muted};width:34%;vertical-align:top;">${esc(label)}</td>
      <td style="padding:10px 14px;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${SANS};font-size:14px;color:${C.ink};vertical-align:top;">${href ? `<a href="${esc(href)}" style="color:${C.gold};text-decoration:none;">${esc(value)}</a>` : esc(value)}</td>
    </tr>`).join('')}
  </table>`;
}

// The pieces an inquiry is about.
function itemsTable(items, ref) {
  if (!items || !items.length) return '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;border:1px solid ${C.line};border-radius:8px;border-collapse:separate;">
    <tr><td colspan="2" style="padding:10px 14px;background:${C.page};border-radius:8px 8px 0 0;font-family:${SANS};font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:bold;color:${C.muted};">
      Your inquiry${ref ? ` · <span style="color:${C.gold};">${esc(ref)}</span>` : ''}</td></tr>
    ${items.map((it) => `<tr>
      <td style="padding:11px 14px;border-top:1px solid ${C.line};font-family:${SANS};vertical-align:top;">
        <div style="font-family:${SERIF};font-size:15px;color:${C.ink};">${esc(it.name || it.sku)}</div>
        ${it.name && it.name !== it.sku ? `<div style="font-size:12px;color:${C.muted};margin-top:2px;">SKU ${esc(it.sku)}</div>` : ''}
      </td>
      <td align="right" style="padding:11px 14px;border-top:1px solid ${C.line};font-family:${SANS};font-size:13px;color:${C.muted};white-space:nowrap;vertical-align:top;">× ${esc(it.qty || 1)}</td>
    </tr>`).join('')}
  </table>`;
}

// The verification code: big, spaced, easy to read and to copy.
function codeBox(code, minutes) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:6px auto 10px;"><tr>
    <td align="center" style="background:${C.goldTint};border:1px solid ${C.goldLight};border-radius:10px;padding:18px 30px;">
      <div style="font-family:'Courier New',Courier,monospace;font-size:34px;letter-spacing:10px;font-weight:bold;color:${C.ink};padding-left:10px;">${esc(code)}</div>
    </td></tr></table>
    <p style="margin:0 0 22px;text-align:center;font-family:${SANS};font-size:13px;color:${C.muted};">This code expires in ${minutes} minutes and can be used once.</p>`;
}

// ── the frame every email shares ───────────────────────────────────────────
function layout({ brand, origin, preheader, body, footerNote }) {
  const site = origin || '';
  const contact = [
    brand.email ? `<a href="mailto:${esc(brand.email)}" style="color:${C.goldLight};text-decoration:none;">${esc(brand.email)}</a>` : '',
    brand.phone ? `<span style="color:#cfc7b8;">${esc(brand.phone)}</span>` : '',
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(brand.name)}</title>
<style>
  @media only screen and (max-width:480px){
    .oncd-pad{padding:28px 20px 16px !important;}
    .oncd-h1{font-size:23px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};">${esc(preheader || '')}&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page};">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
      <tr><td align="center" bgcolor="${C.dark}" style="background:${C.dark};border-radius:12px 12px 0 0;padding:26px 24px;">
        ${site ? `<a href="${esc(site)}/Home.dc.html" target="_blank" style="text-decoration:none;">` : ''}<span style="font-family:${SERIF};font-size:24px;letter-spacing:6px;color:#f8f4f4;font-weight:bold;">${esc(brand.name.toUpperCase())}</span>${site ? '</a>' : ''}
        <div style="font-family:${SANS};font-size:10px;letter-spacing:3px;color:${C.goldLight};margin-top:6px;text-transform:uppercase;">Diamonds · Jewelry · Gemstones</div>
      </td></tr>
      <tr><td class="oncd-pad" bgcolor="${C.card}" style="background:${C.card};padding:36px 36px 22px;border-left:1px solid ${C.line};border-right:1px solid ${C.line};">
        ${body}
      </td></tr>
      <tr><td bgcolor="${C.dark}" style="background:${C.dark};border-radius:0 0 12px 12px;padding:22px 28px;" align="center">
        <div style="font-family:${SANS};font-size:12px;line-height:1.7;color:#cfc7b8;">
          ${contact ? `${contact}<br>` : ''}${esc(brand.places)}
        </div>
        ${site ? `<div style="font-family:${SANS};font-size:12px;margin-top:8px;">
          <a href="${esc(site)}/Diamonds.dc.html" style="color:${C.goldLight};text-decoration:none;">Diamonds</a> &nbsp;·&nbsp;
          <a href="${esc(site)}/Jewelry.dc.html" style="color:${C.goldLight};text-decoration:none;">Jewelry</a> &nbsp;·&nbsp;
          <a href="${esc(site)}/Gemstones.dc.html" style="color:${C.goldLight};text-decoration:none;">Gemstones</a> &nbsp;·&nbsp;
          <a href="${esc(site)}/Contact.dc.html" style="color:${C.goldLight};text-decoration:none;">Contact</a>
        </div>` : ''}
      </td></tr>
      <tr><td align="center" style="padding:16px 20px 0;font-family:${SANS};font-size:11px;line-height:1.6;color:#9a9182;">
        ${footerNote ? `${footerNote}<br>` : ''}© ${new Date().getFullYear()} ${esc(brand.name)}. All rights reserved.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// Plain-text twin (shown by clients that don't render HTML, and used by
// spam filters to judge the message).
function textOf(brand, lines) {
  return [...lines.filter((l) => l !== null && l !== undefined), '', '—', brand.name, [brand.email, brand.phone].filter(Boolean).join(' · ')]
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── templates ──────────────────────────────────────────────────────────────
const OTP_COPY = {
  register: { title: 'Verify your email', kicker: 'Account verification', lead: 'Use this code to verify your email and finish creating your trade account.', subject: 'verification code' },
  reset: { title: 'Reset your password', kicker: 'Password reset', lead: 'Use this code to reset the password for your account.', subject: 'password reset code' },
  change: { title: 'Confirm your new password', kicker: 'Password change', lead: 'Use this code to confirm the password change you started in your account.', subject: 'password change code' },
  admin_reset: { title: 'Reset your admin password', kicker: 'Admin password reset', lead: 'Use this code to reset the password for your admin account.', subject: 'admin reset code' },
};

// The code is in the subject, so it can be read straight from the phone's
// notification without opening the email.
async function otpEmail({ purpose, code, minutes = 10, name, origin }) {
  const brand = await getBrand();
  const c = OTP_COPY[purpose] || OTP_COPY.register;
  const body = [
    kicker(c.kicker), h1(c.title), p(esc(greeting(name))), p(esc(c.lead)),
    codeBox(code, minutes),
    small(`Didn't ask for this? You can safely ignore this email — nothing changes without the code. Never share it with anyone; ${esc(brand.name)} will never ask you for it.`),
  ].join('');
  return {
    subject: `${code} is your ${brand.name} ${c.subject}`,
    html: layout({ brand, origin, preheader: `Your code is ${code}. It expires in ${minutes} minutes.`, body }),
    text: textOf(brand, [greeting(name), '', c.lead, '', `Your code: ${code}`, `It expires in ${minutes} minutes and can be used once.`, '', "Didn't ask for this? Ignore this email — nothing changes without the code."]),
  };
}

async function passwordChangedEmail({ name, origin, admin }) {
  const brand = await getBrand();
  const where = admin ? 'admin account' : 'account';
  const loginUrl = `${origin}/${admin ? 'AdminLogin' : 'Login'}.dc.html`;
  const body = [
    kicker('Security notice'), h1('Your password was changed'), p(esc(greeting(name))),
    p(`The password for your ${brand.name} ${where} was just changed. You can sign in with the new password from now on.`),
    button('Sign in', loginUrl),
    small(`Wasn't you? Reset your password right away from the sign-in page and let us know${brand.email ? ` at <a href="mailto:${esc(brand.email)}" style="color:${C.gold};">${esc(brand.email)}</a>` : ''}.`),
  ].join('');
  return {
    subject: `Your ${brand.name} password was changed`,
    html: layout({ brand, origin, preheader: `The password for your ${where} was just changed.`, body }),
    text: textOf(brand, [greeting(name), '', `The password for your ${brand.name} ${where} was just changed.`, `Sign in: ${loginUrl}`, '', "Wasn't you? Reset your password from the sign-in page right away and contact us."]),
  };
}

// "Your customer ID is 100047 — quote it whenever you contact us."
function customerIdLine(code) {
  return code ? p(`Your customer ID is <strong>${esc(code)}</strong> — please quote it whenever you contact us.`) : '';
}

async function registrationReceivedEmail({ name, origin, customerCode }) {
  const brand = await getBrand();
  const body = [
    kicker('Application received'), h1('Thank you for registering'), p(esc(greeting(name))),
    p(`Your email is verified and your trade account application is now with our team. We review every application personally — usually within one business day — and we'll email you as soon as your account is approved.`),
    customerIdLine(customerCode),
    p('Once approved you can sign in to see trade pricing, save pieces, and send and track inquiries in one place.'),
    button('Browse the collection', `${origin}/Home.dc.html`),
  ].join('');
  return {
    subject: `We've received your ${brand.name} trade application`,
    html: layout({ brand, origin, preheader: "Your email is verified — we'll let you know as soon as your account is approved.", body }),
    text: textOf(brand, [greeting(name), '', 'Your email is verified and your trade account application is with our team.', "We review every application — usually within one business day — and will email you once it's approved.", customerCode ? `Your customer ID: ${customerCode}` : null, '', `Browse the collection: ${origin}/Home.dc.html`]),
  };
}

async function accountApprovedEmail({ name, origin, customerCode }) {
  const brand = await getBrand();
  const body = [
    kicker('Account approved'), h1('Welcome — your account is ready'), p(esc(greeting(name))),
    p(`Good news: your ${brand.name} trade account has been approved. Sign in to see trade pricing, save pieces to your shortlist and send inquiries straight to our sales desk.`),
    customerIdLine(customerCode),
    button('Sign in to your account', `${origin}/Login.dc.html`),
    small(`Questions? Just reply to this email${brand.phone ? ` or message us on WhatsApp at ${esc(brand.phone)}` : ''}.`),
  ].join('');
  return {
    subject: `Your ${brand.name} trade account is approved`,
    html: layout({ brand, origin, preheader: 'Sign in to see trade pricing and send inquiries.', body }),
    text: textOf(brand, [greeting(name), '', `Your ${brand.name} trade account has been approved.`, customerCode ? `Your customer ID: ${customerCode}` : null, `Sign in: ${origin}/Login.dc.html`]),
  };
}

async function accountRejectedEmail({ name, origin }) {
  const brand = await getBrand();
  const body = [
    kicker('Application update'), h1('About your trade application'), p(esc(greeting(name))),
    p(`Thank you for your interest in ${brand.name}. After reviewing your application we're unable to open a trade account at this time.`),
    p('If you think we may have missed something — for example your company details — please get in touch and we will gladly take another look.'),
    button('Contact our team', `${origin}/Contact.dc.html`),
  ].join('');
  return {
    subject: `Your ${brand.name} trade application`,
    html: layout({ brand, origin, preheader: 'An update on your trade account application.', body }),
    text: textOf(brand, [greeting(name), '', `Thank you for your interest in ${brand.name}. We're unable to open a trade account at this time.`, `If you think we missed something, contact us: ${origin}/Contact.dc.html`]),
  };
}

// To the sales desk: someone verified their email and is waiting for approval.
async function newApplicationDeskEmail({ customer, origin }) {
  const brand = await getBrand();
  const c = customer;
  const url = `${origin}/AdminUsers.dc.html?customer=${encodeURIComponent(c.id)}`;
  const body = [
    kicker('New trade application'), h1(`${esc(c.full_name)} is waiting for approval`),
    p('A new account was created and its email address is verified. Review it in User Approval.'),
    details([
      ['Customer ID', customerCode(c.id)],
      ['Name', c.full_name], ['Company', c.company_name], ['Business type', c.business_type],
      ['Email', c.email, `mailto:${c.email}`], ['Mobile', c.mobile],
      ['Location', [c.city, c.state, c.country].filter(Boolean).join(', ')], ['Website', c.website, c.website && /^https?:\/\//i.test(c.website) ? c.website : null],
    ]),
    c.message ? quote(c.message, 'Their message') : '',
    button('Review in User Approval', url),
  ].join('');
  return {
    subject: `New trade application: ${c.full_name}${c.company_name ? ` (${c.company_name})` : ''} · ID ${customerCode(c.id)}`,
    html: layout({ brand, origin, preheader: `${c.full_name} verified their email and is waiting for approval.`, body }),
    text: textOf(brand, [`New trade application from ${c.full_name}${c.company_name ? ` (${c.company_name})` : ''}.`, `Customer ID: ${customerCode(c.id)}`, `Email: ${c.email}`, c.mobile ? `Mobile: ${c.mobile}` : null, `Location: ${[c.city, c.state, c.country].filter(Boolean).join(', ')}`, c.message ? `\nMessage:\n${c.message}` : null, '', `Review: ${url}`]),
  };
}

// To the sales desk: a contact-form message. Reply-To is the visitor, so
// "Reply" in Gmail answers them directly.
async function contactDeskEmail({ id, fullName, email, phone, subject, message, isCustomer, customerCode: code, origin }) {
  const brand = await getBrand();
  const url = `${origin}/AdminContact.dc.html?id=${encodeURIComponent(id)}`;
  const body = [
    kicker(isCustomer ? 'Contact form · registered customer' : 'Contact form'), h1(esc(subject)),
    details([['From', fullName], ['Customer ID', code], ['Email', email, `mailto:${email}`], ['Phone', phone, `tel:${String(phone).replace(/[^\d+]/g, '')}`]]),
    quote(message, 'Message'),
    button('Open in Contact Messages', url),
    small('Tip: reply in Contact Messages so the conversation is saved and the customer can follow it in their account.'),
  ].join('');
  return {
    subject: `New message: ${subject} — ${fullName}`,
    html: layout({ brand, origin, preheader: `${fullName}: ${String(message).slice(0, 90)}`, body }),
    text: textOf(brand, [`New contact message from ${fullName} <${email}>`, code ? `Customer ID: ${code}` : null, phone ? `Phone: ${phone}` : null, `Subject: ${subject}`, '', message, '', `Open: ${url}`]),
  };
}

// To the visitor: confirmation that the message arrived. Deliberately does
// NOT repeat what they typed (so the form can't be used to send arbitrary
// text to someone else's address).
async function contactAckEmail({ id, fullName, origin, isCustomer }) {
  const brand = await getBrand();
  const body = [
    kicker('Message received'), h1('Thanks — we have your message'), p(esc(greeting(fullName))),
    p(`Your message reached the ${brand.name} sales desk. We reply within one business day, by email${isCustomer ? ' and in your account' : ''}.`),
    details([['Reference', `#${id}`]]),
    isCustomer ? button('View in your account', `${origin}/Dashboard.dc.html?tab=messages&message=${encodeURIComponent(id)}`) : button('Browse the collection', `${origin}/Home.dc.html`),
    brand.phone ? small(`Need us sooner? Message us on WhatsApp at ${esc(brand.phone)}.`) : '',
  ].join('');
  return {
    subject: `We've received your message — ${brand.name}`,
    html: layout({ brand, origin, preheader: 'We reply within one business day.', body, footerNote: 'You are receiving this because this address was entered in our contact form.' }),
    text: textOf(brand, [greeting(fullName), '', `Your message reached the ${brand.name} sales desk (reference #${id}). We reply within one business day.`]),
  };
}

// To the customer: the desk answered their contact message.
async function contactReplyEmail({ id, name, subject, body: reply, adminName, accountUrl, origin }) {
  const brand = await getBrand();
  const body = [
    kicker('Reply from our sales desk'), h1(`Re: ${esc(subject)}`), p(esc(greeting(name))),
    quote(reply, adminName ? `${adminName} · ${brand.name}` : brand.name),
    accountUrl ? button('View & reply in your account', accountUrl) : small('You can reply directly to this email.'),
  ].join('');
  return {
    subject: `Re: ${subject}`,
    html: layout({ brand, origin, preheader: String(reply).slice(0, 110), body }),
    text: textOf(brand, [greeting(name), '', reply, '', adminName ? `— ${adminName}, ${brand.name}` : null, accountUrl ? `\nView and reply in your account: ${accountUrl}` : null]),
  };
}

// To the customer: the desk answered an inquiry.
async function inquiryReplyEmail({ name, ref, body: reply, adminName, items, accountUrl, origin }) {
  const brand = await getBrand();
  const body = [
    kicker(`Inquiry ${ref}`), h1('A reply to your inquiry'), p(esc(greeting(name))),
    quote(reply, adminName ? `${adminName} · ${brand.name} sales desk` : `${brand.name} sales desk`),
    itemsTable(items, ref),
    accountUrl ? button('View & reply in your account', accountUrl) : small('You can reply directly to this email.'),
  ].join('');
  return {
    subject: `Re: your inquiry ${ref} — ${brand.name}`,
    html: layout({ brand, origin, preheader: String(reply).slice(0, 110), body }),
    text: textOf(brand, [greeting(name), '', reply, '', adminName ? `— ${adminName}, ${brand.name} sales desk` : null, '', `Your inquiry ${ref}:`, ...(items || []).map((it) => `• ${it.name} (SKU ${it.sku}) × ${it.qty}`), accountUrl ? `\nView and reply in your account: ${accountUrl}` : null]),
  };
}

// To the sales desk: a customer answered in their account (inquiry thread
// or contact conversation).
async function customerReplyDeskEmail({ kind, who, company, email, code, label, body: reply, adminUrl, origin }) {
  const brand = await getBrand();
  const what = kind === 'inquiry' ? `inquiry ${label}` : `“${label}”`;
  const body = [
    kicker(kind === 'inquiry' ? `Inquiry ${label}` : 'Contact conversation'), h1(`${esc(who)} replied`),
    small(`${esc(who)}${code ? ` · Customer ID ${esc(code)}` : ''}${company ? ` · ${esc(company)}` : ''}${email ? ` · <a href="mailto:${esc(email)}" style="color:${C.gold};text-decoration:none;">${esc(email)}</a>` : ''} — on ${esc(what)}`),
    quote(reply, 'New message'),
    button('Open the conversation', adminUrl),
  ].join('');
  return {
    subject: kind === 'inquiry' ? `New message on inquiry ${label} from ${who}` : `Re: ${label} (reply from ${who})`,
    html: layout({ brand, origin, preheader: `${who}: ${String(reply).slice(0, 100)}`, body }),
    text: textOf(brand, [`${who}${company ? ` (${company})` : ''}${code ? ` · Customer ID ${code}` : ''} wrote on ${what}:`, '', reply, '', `Open the conversation: ${adminUrl}`]),
  };
}

module.exports = {
  getBrand, otpEmail, passwordChangedEmail, registrationReceivedEmail, accountApprovedEmail, accountRejectedEmail,
  newApplicationDeskEmail, contactDeskEmail, contactAckEmail, contactReplyEmail, inquiryReplyEmail, customerReplyDeskEmail,
};
