import { config, modes } from '../config.js'
import { MOCK_PRODUCTS } from './mockCatalog.js'
import { isOutage, degrade } from '../fallback.js'

const BASE_URL = 'https://api.trychannel3.com/v1'
const STOP_WORDS = new Set(['a', 'an', 'the', 'for', 'and', 'with', 'of', 'to', 'in', 'on', 'under', 'i', 'need', 'want', 'some'])

// Channel3 docs show the offer price as price.price; older pages show price.amount.
export function offerPrice(offer) {
  const value = offer?.price?.price ?? offer?.price?.amount
  return typeof value === 'number' ? value : Number(value)
}

export function bestOffer(product) {
  const offers = (product.offers || []).filter((o) => o.availability !== 'OutOfStock' && Number.isFinite(offerPrice(o)))
  const usd = offers.filter((o) => (o.price?.currency || 'USD') === 'USD')
  const pool = usd.length ? usd : offers
  return pool.sort((a, b) => offerPrice(a) - offerPrice(b))[0] || null
}

async function channel3Fetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { 'x-api-key': config.channel3Key, 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Channel3 ${res.status}: ${body.slice(0, 300)}`)
  }
  return res.json()
}

function mockSearch({ query, minPrice, maxPrice, limit }) {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP_WORDS.has(w))
  const scored = MOCK_PRODUCTS.map((p) => {
    const text = `${p.title} ${p.description} ${p.category.slug}`.toLowerCase()
    const score = words.reduce((sum, w) => sum + (text.includes(w.replace(/s$/, '')) ? 1 : 0), 0)
    return { p, score }
  })
    .filter(({ p, score }) => {
      const offer = bestOffer(p)
      if (!offer || score === 0) return false
      const price = offerPrice(offer)
      if (maxPrice != null && price > maxPrice) return false
      if (minPrice != null && price < minPrice) return false
      return true
    })
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(({ p }) => p)
}

export async function searchProducts({ query, minPrice, maxPrice, limit = 8 }, userId) {
  if (modes.channel3 === 'mock') return mockSearch({ query, minPrice, maxPrice, limit })
  const filters = { availability: ['InStock', 'LimitedAvailability'] }
  if (minPrice != null || maxPrice != null) {
    filters.price = {}
    if (minPrice != null) filters.price.min_price = minPrice
    if (maxPrice != null) filters.price.max_price = maxPrice
  }
  try {
    const data = await channel3Fetch('/search', {
      method: 'POST',
      headers: userId ? { 'x-user-id': userId } : {},
      body: JSON.stringify({ query, filters, limit }),
    })
    return data.products || []
  } catch (err) {
    if (!isOutage(err)) throw err
    degrade('channel3', err)
    return mockSearch({ query, minPrice, maxPrice, limit })
  }
}

export async function getProduct(productId) {
  const local = MOCK_PRODUCTS.find((p) => p.id === productId)
  if (modes.channel3 === 'mock' || local) {
    if (!local) throw new Error(`Product ${productId} not found`)
    return local
  }
  try {
    return await channel3Fetch(`/products/${encodeURIComponent(productId)}`)
  } catch (err) {
    if (!isOutage(err)) throw err
    degrade('channel3', err)
    throw new Error('Channel3 is unavailable right now; search again to get products from the backup catalog.')
  }
}

// Compact view for the model and the UI. Prices here come from Channel3, never from the LLM.
export function summarizeProduct(product) {
  const offer = bestOffer(product)
  return {
    product_id: product.id,
    title: product.title,
    brand: product.brands?.[0]?.name || null,
    price: offer ? offerPrice(offer) : null,
    currency: offer?.price?.currency || 'USD',
    retailer: offer?.domain || null,
    offer_count: (product.offers || []).length,
    url: offer?.url || null,
    image: product.images?.find((i) => i.is_main_image)?.cleaned_url || product.images?.[0]?.cleaned_url || product.images?.[0]?.url || null,
    key_features: (product.key_features || []).slice(0, 4),
  }
}
