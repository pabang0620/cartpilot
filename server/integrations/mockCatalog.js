// Offline catalog used when CHANNEL3_API_KEY is missing.
// Shape follows the Channel3 search response (products[].offers[].price).

const img = (seed) => `https://picsum.photos/seed/${seed}/320/320`

const raw = [
  ['c3m-chair-01', 'Helinox Chair One Ultralight Camping Chair', 'Helinox', 'camping', 109.95, 'rei.com', 129.95, 'backcountry.com', ['2 lb', 'holds 320 lb', 'packs to 14 in']],
  ['c3m-chair-02', 'REI Co-op Flexlite Camp Dreamer Chair', 'REI Co-op', 'camping', 99.95, 'rei.com', null, null, ['high back', 'holds 300 lb', '2 lb 14 oz']],
  ['c3m-chair-03', 'Coleman Portable Quad Camping Chair with Cooler', 'Coleman', 'camping', 34.99, 'walmart.com', 39.99, 'amazon.com', ['built-in 4-can cooler', 'holds 325 lb', '9.5 lb']],
  ['c3m-chair-04', 'ALPS Mountaineering King Kong Chair', 'ALPS Mountaineering', 'camping', 79.99, 'amazon.com', 84.99, 'dickssportinggoods.com', ['holds 800 lb', 'oversized', '13 lb']],
  ['c3m-chair-05', 'Kijaro Dual Lock Portable Camping Chair', 'Kijaro', 'camping', 44.99, 'target.com', 49.99, 'amazon.com', ['locks open and closed', 'holds 300 lb', '8 lb']],
  ['c3m-chair-06', 'GCI Outdoor Freestyle Rocker Chair', 'GCI Outdoor', 'camping', 74.95, 'amazon.com', 79.99, 'rei.com', ['rocking motion', 'holds 250 lb', '12 lb']],
  ['c3m-tent-01', 'Big Agnes Copper Spur HV UL2 Tent', 'Big Agnes', 'camping', 549.95, 'rei.com', 499.95, 'moosejaw.com', ['2 person', '3 lb 2 oz', 'freestanding']],
  ['c3m-tent-02', 'Coleman Sundome 4-Person Tent', 'Coleman', 'camping', 89.99, 'walmart.com', 99.99, 'amazon.com', ['4 person', '10 min setup', 'weathertec']],
  ['c3m-lantern-01', 'BioLite AlpenGlow 500 Lantern', 'BioLite', 'camping', 79.95, 'biolite.com', 79.95, 'rei.com', ['500 lumens', 'USB rechargeable', 'multicolor']],
  ['c3m-cooler-01', 'YETI Roadie 24 Hard Cooler', 'YETI', 'camping', 250.0, 'yeti.com', 250.0, 'dickssportinggoods.com', ['24 qt', 'holds ice for days', 'bear resistant']],
  ['c3m-office-01', 'Steelcase Series 1 Office Chair', 'Steelcase', 'office', 495.0, 'steelcase.com', 429.0, 'amazon.com', ['adjustable lumbar', '12 year warranty', 'mesh back']],
  ['c3m-office-02', 'HON Ignition 2.0 Mesh Task Chair', 'HON', 'office', 279.0, 'staples.com', 259.99, 'amazon.com', ['mesh back', 'synchro tilt', 'adjustable arms']],
  ['c3m-office-03', 'FlexiSpot E7 Standing Desk 55x28', 'FlexiSpot', 'office', 399.99, 'flexispot.com', 379.99, 'amazon.com', ['dual motor', 'holds 355 lb', 'memory presets']],
  ['c3m-office-04', 'BenQ ScreenBar Monitor Light', 'BenQ', 'office', 109.0, 'bestbuy.com', 99.0, 'amazon.com', ['no screen glare', 'auto dimming', 'USB powered']],
  ['c3m-kitchen-01', 'Lodge 12 Inch Cast Iron Skillet', 'Lodge', 'kitchen', 29.9, 'amazon.com', 34.99, 'target.com', ['pre-seasoned', 'oven safe', 'made in USA']],
  ['c3m-kitchen-02', 'Instant Pot Duo 7-in-1 6 Quart', 'Instant Pot', 'kitchen', 89.99, 'bestbuy.com', 79.95, 'amazon.com', ['pressure cooker', 'slow cooker', '6 qt']],
  ['c3m-kitchen-03', 'OXO Good Grips 3-Piece Mixing Bowl Set', 'OXO', 'kitchen', 39.99, 'oxo.com', 34.99, 'target.com', ['non-slip base', 'dishwasher safe', 'stackable']],
  ['c3m-kitchen-04', 'Fellow Stagg EKG Electric Kettle', 'Fellow', 'kitchen', 165.0, 'fellowproducts.com', 165.0, 'williams-sonoma.com', ['variable temp', 'pour-over spout', '0.9 L']],
  ['c3m-audio-01', 'Sony WH-1000XM5 Wireless Headphones', 'Sony', 'audio', 399.99, 'bestbuy.com', 328.0, 'amazon.com', ['noise cancelling', '30 hr battery', 'multipoint']],
  ['c3m-audio-02', 'JBL Flip 6 Portable Bluetooth Speaker', 'JBL', 'audio', 129.95, 'jbl.com', 99.95, 'target.com', ['IP67 waterproof', '12 hr battery', 'PartyBoost']],
  ['c3m-audio-03', 'Anker Soundcore Space Q45 Headphones', 'Anker', 'audio', 149.99, 'amazon.com', 129.99, 'walmart.com', ['adaptive ANC', '50 hr battery', 'LDAC']],
  ['c3m-audio-04', 'Ultimate Ears WONDERBOOM 4 Speaker', 'Ultimate Ears', 'audio', 99.99, 'ultimateears.com', 79.99, 'bestbuy.com', ['floats', 'drop proof', 'outdoor boost']],
  ['c3m-camp-07', 'Therm-a-Rest Z Lite SOL Sleeping Pad', 'Therm-a-Rest', 'camping', 59.95, 'rei.com', 54.95, 'amazon.com', ['closed cell foam', '14 oz', 'reflective']],
  ['c3m-camp-08', 'Jetboil Flash Cooking System', 'Jetboil', 'camping', 129.95, 'rei.com', 119.95, 'amazon.com', ['boils in 100 s', '1 L', 'push button igniter']],
]

export const MOCK_PRODUCTS = raw.map(([id, title, brand, category, p1, d1, p2, d2, features]) => {
  const offers = [{ url: `https://${d1}/product/${id}`, domain: d1, price: { price: p1, currency: 'USD' }, availability: 'InStock', condition: 'new' }]
  if (p2 && d2) {
    offers.push({ url: `https://${d2}/product/${id}`, domain: d2, price: { price: p2, currency: 'USD' }, availability: 'InStock', condition: 'new' })
  }
  return {
    id,
    title,
    description: `${title}. ${features.join(', ')}.`,
    brands: [{ id: `brand-${brand.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name: brand }],
    images: [{ url: img(id), cleaned_url: null, is_main_image: true }],
    category: { slug: category, title: category },
    key_features: features,
    offers,
  }
})
