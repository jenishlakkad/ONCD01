// <otp-input> — the 6-box verification-code field used everywhere a code
// is entered (registration, forgot password, change password, admin reset).
//
// One real <input> sits over six display boxes, so everything a normal
// field does keeps working: paste a whole code (even "123 456" or
// "Code: 123456"), iOS/Android "From Messages / Mail" autofill
// (autocomplete="one-time-code"), backspace, select-all, screen readers.
//
// Events (bubble): 'otp-change' {detail: value} on every edit and
//                  'otp-complete' {detail: value} once all digits are in.
// Attributes: length (default 6), invalid (red + shake), disabled.
// Properties/methods: value, clear(), focus().
//
// Also exports small helpers the code screens share.

const CSS = `
:host{display:block;width:100%;max-width:360px;margin:0 auto;}
.wrap{position:relative;}
.boxes{display:grid;grid-template-columns:repeat(var(--n),minmax(0,1fr));gap:clamp(6px,2vw,10px);}
.box{height:clamp(48px,13vw,58px);display:flex;align-items:center;justify-content:center;border:1.5px solid var(--color-divider,#e2dbcb);border-radius:10px;background:#fff;
  font-family:var(--font-heading,Georgia,serif);font-size:clamp(22px,6vw,28px);color:var(--color-text,#221f1c);transition:border-color .15s,box-shadow .15s,background .15s;}
.box.filled{border-color:var(--color-accent-400,#cba85a);background:var(--color-accent-100,#f3e9d2);}
:host(:focus-within) .box.active{border-color:var(--color-accent,#9c7a2e);box-shadow:0 0 0 3px rgba(156,122,46,.18);}
.caret{width:2px;height:26px;background:var(--color-accent,#9c7a2e);animation:blink 1s step-end infinite;display:none;}
:host(:focus-within) .box.active .caret{display:block;}
@keyframes blink{50%{opacity:0;}}
input{position:absolute;inset:0;width:100%;height:100%;opacity:0;border:0;padding:0;margin:0;font-size:16px;color:transparent;background:transparent;caret-color:transparent;
  letter-spacing:2em;cursor:text;-webkit-appearance:none;appearance:none;}
:host([invalid]) .box{border-color:#c0392b;background:#fdf1ef;}
:host([invalid]) .boxes{animation:shake .35s ease;}
@keyframes shake{20%,60%{transform:translateX(-5px);}40%,80%{transform:translateX(5px);}}
:host([disabled]) .box{opacity:.55;}
:host([disabled]) input{cursor:default;}
@media (prefers-reduced-motion:reduce){:host([invalid]) .boxes{animation:none;}.caret{animation:none;}}
`;

class OtpInput extends HTMLElement {
  static get observedAttributes() { return ['length', 'disabled']; }

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open', delegatesFocus: true });
    root.innerHTML = `<style>${CSS}</style><div class="wrap"><div class="boxes" aria-hidden="true"></div>
      <input type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" spellcheck="false" aria-label="Verification code"></div>`;
    this._boxes = root.querySelector('.boxes');
    this._input = root.querySelector('input');
    this._input.addEventListener('input', () => this._onInput());
    this._input.addEventListener('keyup', () => this._render());
    this._input.addEventListener('click', () => this._render());
    this._input.addEventListener('focus', () => this._render());
    this._build();
  }

  get length() { return Math.max(4, Math.min(8, parseInt(this.getAttribute('length'), 10) || 6)); }

  attributeChangedCallback(name) {
    if (name === 'length') this._build();
    if (name === 'disabled') this._input.disabled = this.hasAttribute('disabled');
  }

  connectedCallback() {
    this._input.disabled = this.hasAttribute('disabled');
    this._input.setAttribute('maxlength', String(this.length));
    if (this.hasAttribute('autofocus')) setTimeout(() => this.focus(), 60);
  }

  _build() {
    const n = this.length;
    this._boxes.style.setProperty('--n', n);
    this._boxes.innerHTML = Array.from({ length: n }, () => '<div class="box"><span class="d"></span><span class="caret"></span></div>').join('');
    this._input.setAttribute('maxlength', String(n));
    this._input.setAttribute('aria-label', `${n}-digit verification code`);
    this._render();
  }

  _onInput() {
    const n = this.length;
    const digits = this._input.value.replace(/\D/g, '').slice(0, n);
    if (digits !== this._input.value) this._input.value = digits;
    this.removeAttribute('invalid');
    this._render();
    this.dispatchEvent(new CustomEvent('otp-change', { detail: digits, bubbles: true, composed: true }));
    if (digits.length === n && digits !== this._lastComplete) {
      this._lastComplete = digits;
      this.dispatchEvent(new CustomEvent('otp-complete', { detail: digits, bubbles: true, composed: true }));
    }
    if (digits.length < n) this._lastComplete = '';
  }

  _render() {
    const v = this._input.value;
    const n = this.length;
    const active = Math.min(v.length, n - 1);
    [...this._boxes.children].forEach((box, i) => {
      box.querySelector('.d').textContent = v[i] || '';
      box.classList.toggle('filled', !!v[i]);
      box.classList.toggle('active', i === active);
    });
  }

  get value() { return this._input.value; }
  set value(v) {
    this._input.value = String(v || '').replace(/\D/g, '').slice(0, this.length);
    this._lastComplete = '';
    this._render();
  }
  clear() { this.value = ''; }
  focus() { try { this._input.focus({ preventScroll: true }); } catch { this._input.focus(); } }
  // Shows the error state; cleared automatically when the user types again.
  markInvalid() {
    this.removeAttribute('invalid');
    void this.offsetWidth; // restart the shake
    this.setAttribute('invalid', '');
  }
}

if (window.customElements && !customElements.get('otp-input')) customElements.define('otp-input', OtpInput);

// "j•••@gmail.com" — enough to recognise the address on screen.
export function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  if (!domain) return email || '';
  const shown = user.length <= 2 ? user[0] : user.slice(0, 2);
  return `${shown}${'•'.repeat(Math.max(2, Math.min(5, user.length - shown.length)))}@${domain}`;
}

// A one-tap way into the right webmail for common providers.
export function inboxFor(email) {
  const domain = String(email || '').split('@')[1] || '';
  const d = domain.toLowerCase();
  if (d === 'gmail.com' || d === 'googlemail.com') return { label: 'Open Gmail', href: 'https://mail.google.com/mail/u/0/#search/in%3Aanywhere+newer_than%3A1h' };
  if (/^(outlook|hotmail|live|msn)\./.test(d)) return { label: 'Open Outlook', href: 'https://outlook.live.com/mail/0/' };
  if (/^yahoo\./.test(d) || d === 'ymail.com') return { label: 'Open Yahoo Mail', href: 'https://mail.yahoo.com/' };
  if (d === 'icloud.com' || d === 'me.com' || d === 'mac.com') return { label: 'Open iCloud Mail', href: 'https://www.icloud.com/mail' };
  if (d === 'proton.me' || d === 'protonmail.com') return { label: 'Open Proton Mail', href: 'https://mail.proton.me/' };
  return null;
}

// "0:27" for a countdown.
export function formatWait(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
