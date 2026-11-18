// Storefront presentation of a product's offer (sale badge, sale price,
// struck-through original, countdown). Loaded as a plain <script> before
// support.js so every page's template logic can call it synchronously:
//   const o = window.oncdOffer(product[, { price, salePrice }]);
// The server (server/lib/offers.js) has already decided WHICH offer applies
// and computed every sale price; this file only formats. `product.offer` is
// null when nothing applies; its prices are null when the viewer can't see
// prices (they still get the badge — "log in to see your offer price").
(function () {
  var money = function (n) { return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }); };
  var DAY = 86400000;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // "Ends in 2d 4h" inside a week, "Ends 31 Dec" further out, '' if open-ended.
  function endsText(endsAt, now) {
    if (!endsAt) return '';
    var end = new Date(endsAt).getTime();
    var left = end - (now || Date.now());
    if (!(left > 0)) return 'Offer ended';
    if (left < 7 * DAY) {
      var d = Math.floor(left / DAY);
      var h = Math.floor((left % DAY) / 3600000);
      var m = Math.floor((left % 3600000) / 60000);
      if (d > 0) return 'Ends in ' + d + 'd ' + h + 'h';
      if (h > 0) return 'Ends in ' + h + 'h ' + m + 'm';
      return 'Ends in ' + Math.max(1, m) + 'm';
    }
    var e = new Date(end);
    return 'Ends ' + e.getDate() + ' ' + MONTHS[e.getMonth()];
  }

  // Live countdown parts for the product page (last 72 hours only).
  function countdown(endsAt, now) {
    if (!endsAt) return null;
    var left = new Date(endsAt).getTime() - (now || Date.now());
    if (!(left > 0) || left > 3 * DAY) return null;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var s = Math.floor(left / 1000);
    return {
      days: pad(Math.floor(s / 86400)), hours: pad(Math.floor((s % 86400) / 3600)),
      minutes: pad(Math.floor((s % 3600) / 60)), seconds: pad(s % 60),
    };
  }

  // opts.price / opts.salePrice: a jewelry metal variation's own prices.
  function view(p, opts) {
    opts = opts || {};
    var offer = (p && p.offer) || null;
    var visible = !!(p && p.priceVisible);
    var hasVariantPrice = opts.price !== undefined && opts.price !== null;
    var base = hasVariantPrice ? Number(opts.price) : (p && p.totalPrice != null ? Number(p.totalPrice) : null);
    var perCarat = !hasVariantPrice && base == null && p && p.pricePerCarat != null;
    if (perCarat) base = Number(p.pricePerCarat);
    var sale = null;
    if (offer && visible) {
      if (hasVariantPrice) sale = opts.salePrice != null ? Number(opts.salePrice) : null;
      else if (perCarat) sale = offer.salePricePerCarat != null ? Number(offer.salePricePerCarat) : null;
      else sale = offer.salePrice != null ? Number(offer.salePrice) : null;
    }
    var suffix = perCarat ? '/ct' : '';
    var onSale = sale != null && base != null && sale < base;
    var regular = visible && base != null ? money(base) + suffix : ((p && p.priceLabel) || 'Price on request');
    var nowLabel = onSale ? money(sale) + suffix : regular;
    var wasLabel = onSale ? money(base) + suffix : '';
    var savings = onSale ? base - sale : null;
    var badge = offer ? offer.badge : '';
    var label = offer && offer.label ? offer.label : '';
    var ends = offer ? endsText(offer.endsAt, opts.now) : '';
    var soon = !!(offer && offer.endsAt && new Date(offer.endsAt).getTime() - (opts.now || Date.now()) < 3 * DAY);
    // Shown under the price on cards: the offer's name and/or its end.
    var note = [label, ends].filter(Boolean).join(' · ');
    var lockedNote = '';
    if (offer && !visible) lockedNote = p.priceCta === 'login' ? 'Log in to see your ' + badge.toLowerCase() + ' price' : badge + ' on this piece';
    return {
      hasOffer: !!offer,
      onSale: onSale,
      locked: !!offer && !visible,
      badge: badge,
      label: label,
      nowLabel: nowLabel,
      wasLabel: wasLabel,
      savings: savings,
      saveLabel: onSale ? 'You save ' + money(savings) + suffix + (offer.type === 'percent' ? ' (' + offer.badge.replace(' OFF', '') + ')' : '') : '',
      endsText: ends,
      endingSoon: soon,
      note: offer ? (visible ? note : (lockedNote + (ends ? ' · ' + ends : ''))) : '',
      priceClass: onSale ? 'is-sale' : '',
      // What the cart / inquiry stores, so the admin sees the quoted offer.
      cartLabel: onSale ? money(sale) + suffix + ' (' + badge + (label ? ' · ' + label : '') + ', was ' + money(base) + suffix + ')' : regular,
      // Sorting / filtering helpers.
      sortPrice: visible && base != null ? (onSale ? sale : base) : Infinity,
      discountRank: offer ? (offer.type === 'percent' ? Number(offer.value) : (base ? (Number(offer.value) / base) * 100 : 0.01)) : 0,
    };
  }

  window.oncdOffer = view;
  window.oncdOfferEndsText = endsText;
  window.oncdOfferCountdown = countdown;
})();
