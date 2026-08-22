// Builds the "View Certificate" link for a product. The admin's Certificate
// Website field is a URL *prefix* — everything up to and including the
// query-string key the lab's verify tool expects (e.g.
// "https://www.gia.edu/report-check?reportno=" or
// "https://www.igi.org/Verify-Your-Report/?r=") — and this just appends the
// Certificate # to the end of it, so one field covers any lab without the
// site needing to know each lab's URL format.
export function certificateLink(website, number) {
  const site = (website || '').trim();
  if (!site) return null;
  const num = number == null ? '' : String(number).trim();
  return site + encodeURIComponent(num);
}
