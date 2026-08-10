/**
 * AliExpress product-page recipe for `tb harvest --recipe`.
 *
 * A recipe is plain JS evaluated in the page; its value is the record written
 * to the output file. This one exists as the reference example because
 * AliExpress has two traps worth encoding:
 *
 * 1. THE TEASER PRICE. Most listings show a huge "$0.99 — New shoppers save
 *    $12.96" banner. That $0.99 is a one-time first-order promo, not the
 *    product's price. Recording it as cost silently poisons every margin
 *    calculation downstream. When the teaser is present the struck-through
 *    original is the real number.
 * 2. Class names are CSS-module hashed (price-default--current--F8OlYIo), so
 *    match on the stable prefix, never the full name.
 *
 * Requires a headful session — headless gets an empty shell:
 *   tb open https://www.aliexpress.us --visible -n ali --new
 *   tb harvest urls.txt --recipe src/recipes/aliexpress.js --out products.jsonl --settle
 */
(() => {
  const q = (s) => document.querySelector(s);
  const txt = (el) => (el ? (el.innerText || "").trim() : null);
  const og = (p) => {
    const m = document.querySelector(`meta[property="og:${p}"]`);
    return m ? m.content : null;
  };
  const body = document.body ? document.body.innerText : "";
  const num = (s) => {
    const m = (s || "").match(/([0-9][0-9,]*\.?[0-9]*)/);
    return m ? m[1].replace(/,/g, "") : null;
  };
  const grab = (re) => {
    const m = body.match(re);
    return m ? m[1] : null;
  };

  const current = txt(q('[class*="price-default--current--"]'));
  const original = txt(q('[class*="price-default--original--"]'));
  // "New shoppers save $X" = first-order-only promo; the struck price is real.
  const teaser = /new shopper/i.test(body.slice(0, 4000));
  const cost = teaser && original ? num(original) : num(current) || num(original);

  return {
    url: location.href,
    title: (og("title") || txt(q("h1")) || document.title || "")
      .replace(/\s*[-|]\s*AliExpress.*$/i, "")
      .trim(),
    image: og("image"),
    cost,
    price_current: current,
    price_original: original,
    teaser,
    sold:
      txt(q('[class*="--sold--"]')) ||
      (body.match(/[0-9][0-9,.]*[KkMm]?\+?\s*sold/i) || [null])[0],
    rating: grab(/([0-5]\.[0-9])\s*\n/),
    ratings_count: grab(/([0-9][0-9,]*)\s*ratings/i),
    reviews: grab(/([0-9][0-9,]*)\s*Reviews/i),
    delivery: grab(
      /Delivery:\s*([A-Za-z]{3}\s*[0-9]{1,2}\s*-\s*[0-9]{1,2}|[A-Za-z]{3}\s*[0-9]{1,2})/i,
    ),
    free_shipping: /free shipping/i.test(body.slice(0, 3500)),
  };
})()
