// ============================================================================
// MONEY — integer rupiah only. No floating point arithmetic is ever used for
// amounts: prices, markups, tax and balances are integers (1 IDR = 1 unit).
// PostgreSQL stores numeric(18,2); the API accepts/returns integer strings.
// ============================================================================

export const MAX_AMOUNT = 1_000_000_000; // 1 miliar rupiah, guard rail

export class MoneyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MoneyError';
    this.code = 'INVALID_AMOUNT';
  }
}

/** Parse a user/API supplied amount into an integer rupiah value. */
export function parseRupiah(value, { min = 0, max = MAX_AMOUNT, field = 'amount' } = {}) {
  if (value === null || value === undefined || value === '') {
    throw new MoneyError(`${field} wajib diisi`);
  }
  let n;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MoneyError(`${field} tidak valid`);
    n = value;
  } else if (typeof value === 'string') {
    const cleaned = value.replace(/[\s.]/g, '').replace(/,/g, '.');
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) throw new MoneyError(`${field} tidak valid`);
    n = Number(cleaned);
  } else {
    throw new MoneyError(`${field} tidak valid`);
  }
  if (!Number.isFinite(n)) throw new MoneyError(`${field} tidak valid`);
  const rounded = Math.round(n);
  if (Math.abs(n - rounded) > 0.000001) throw new MoneyError(`${field} maksimal 2 desimal`);
  if (!Number.isSafeInteger(rounded)) throw new MoneyError(`${field} di luar batas aman`);
  if (rounded < min) throw new MoneyError(`${field} minimal ${min}`);
  if (rounded > max) throw new MoneyError(`${field} maksimal ${max}`);
  return rounded;
}

/** Convert a PostgreSQL numeric (string|number) to a safe integer. */
export function fromDbAmount(value) {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** Apply a basis-point markup (1500 bps = 15%). */
export function applyBps(amount, bps) {
  if (!Number.isInteger(amount) || amount < 0) throw new MoneyError('amount harus integer >= 0');
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new MoneyError('markup tidak valid');
  return Math.round((amount * bps) / 10000);
}

/**
 * Compute the final customer price from the supplier price.
 * total = supplier + markup + tax, all integers, rounded half-up at each step.
 *
 * Kept for callers that only have a percentage; `resolvePrice` below is the
 * full engine (fixed markup, category override, minimum margin, rounding).
 */
export function composePrice({ supplierPrice, markupBps = 0, taxBps = 0 }) {
  const supplier = parseRupiah(supplierPrice, { min: 0, max: MAX_AMOUNT, field: 'harga supplier' });
  const markup = applyBps(supplier, markupBps);
  const base = supplier + markup;
  const tax = applyBps(base, taxBps);
  return {
    supplierPrice: supplier,
    markupAmount: markup,
    taxAmount: tax,
    totalPrice: supplier + markup + tax
  };
}

// ============================================================================
// PRICING ENGINE — the single place that decides what a customer pays.
//
//   customer price = supplier price
//                  + markup (percentage, fixed, or both)
//                  + tax
//   then optionally rounded to a friendly step.
//
// Rules, in precedence order for the percentage component:
//   service override  >  category override  >  policy default
// A minimum margin (absolute rupiah) is always enforced on top. The result
// carries `rule` and `adjustments` so every quote can be audited later.
// ============================================================================

export const ROUNDING_MODES = Object.freeze(['none', 'nearest', 'up', 'down']);

const clampInt = (value, min, max, fallback) => {
  const n = Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** Coerce whatever is stored in app_settings into a complete, safe policy. */
export function normalisePricingPolicy(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const rounding = source.rounding && typeof source.rounding === 'object' ? source.rounding : {};
  const categoryBps = {};
  if (source.category_bps && typeof source.category_bps === 'object') {
    for (const [key, value] of Object.entries(source.category_bps)) {
      const clean = String(key).trim().slice(0, 40);
      if (!clean) continue;
      const bps = Number(value);
      if (!Number.isFinite(bps)) continue;
      categoryBps[clean] = clampInt(bps, 0, 10000, 0);
    }
  }
  return {
    default_markup_bps: clampInt(source.default_markup_bps, 0, 10000, 1500),
    fixed_markup: clampInt(source.fixed_markup, 0, MAX_AMOUNT, 0),
    min_margin: clampInt(source.min_margin, 0, MAX_AMOUNT, 0),
    tax_bps: clampInt(source.tax_bps, 0, 10000, 0),
    tax_label: String(source.tax_label ?? 'PPN').slice(0, 20),
    rounding: {
      mode: ROUNDING_MODES.includes(rounding.mode) ? rounding.mode : 'none',
      step: clampInt(rounding.step, 1, 100000, 1)
    },
    category_bps: categoryBps
  };
}

function roundToStep(value, step, mode) {
  if (mode === 'none' || step <= 1) return value;
  switch (mode) {
    case 'up':
      return Math.ceil(value / step) * step;
    case 'down':
      return Math.floor(value / step) * step;
    default:
      return Math.round(value / step) * step;
  }
}

/**
 * Resolve the customer price for one offer.
 *
 * @param {object} input
 * @param {number|string} input.supplierPrice  what the supplier charges, rupiah
 * @param {object} [input.policy]              pricing_policy from app_settings
 * @param {number|null} [input.serviceMarkupBps] services.markup_bps override
 * @param {string|null} [input.category]       supplier app id, used for category_bps
 * @param {number} [input.quantity=1]          multiplier for the rounded steps
 * @returns {{supplierPrice:number, markupBps:number, markupAmount:number, taxAmount:number,
 *            totalPrice:number, rule:string, adjustments:string[], taxLabel:string}}
 */
export function resolvePrice({ supplierPrice, policy, serviceMarkupBps = null, category = null, quantity = 1 }) {
  const supplier = parseRupiah(supplierPrice, { min: 0, max: MAX_AMOUNT, field: 'harga supplier' });
  const p = normalisePricingPolicy(policy);
  const qty = Math.max(1, clampInt(quantity, 1, 100, 1));
  const adjustments = [];

  let markupBps;
  let rule;
  if (Number.isInteger(serviceMarkupBps) && serviceMarkupBps >= 0 && serviceMarkupBps <= 10000) {
    markupBps = serviceMarkupBps;
    rule = 'service';
  } else if (category && Object.prototype.hasOwnProperty.call(p.category_bps, category)) {
    markupBps = p.category_bps[category];
    rule = `category:${category}`;
  } else {
    markupBps = p.default_markup_bps;
    rule = 'default';
  }

  const base = supplier * qty;
  let markupAmount = applyBps(base, markupBps);
  if (p.fixed_markup > 0) {
    markupAmount += p.fixed_markup * qty;
    adjustments.push(`fixed:${p.fixed_markup}`);
  }
  if (p.min_margin > 0 && markupAmount < p.min_margin * qty) {
    markupAmount = p.min_margin * qty;
    adjustments.push(`min_margin:${p.min_margin}`);
  }

  const taxAmount = applyBps(base + markupAmount, p.tax_bps);
  let totalPrice = base + markupAmount + taxAmount;

  if (p.rounding.mode !== 'none' && p.rounding.step > 1) {
    const target = roundToStep(totalPrice, p.rounding.step, p.rounding.mode);
    const delta = target - totalPrice;
    // Never let rounding eat the margin below zero.
    if (markupAmount + delta >= 0) {
      markupAmount += delta;
      totalPrice = target;
      adjustments.push(`rounding:${p.rounding.mode}:${p.rounding.step}`);
    }
  }

  // The database enforces total = supplier + markup + tax; keep it exact.
  if (totalPrice !== base + markupAmount + taxAmount) {
    markupAmount = totalPrice - base - taxAmount;
  }
  if (markupAmount < 0) {
    markupAmount = 0;
    totalPrice = base + taxAmount;
  }

  return {
    supplierPrice: base,
    markupBps,
    markupAmount,
    taxAmount,
    totalPrice,
    taxLabel: p.tax_label,
    rule,
    adjustments
  };
}

/** Human-readable explanation for the admin panel. */
export function describePricing(policy) {
  const p = normalisePricingPolicy(policy);
  return [
    `Persentase default ${(p.default_markup_bps / 100).toFixed(2)}% dari harga supplier`,
    p.fixed_markup > 0 ? `ditambah markup tetap ${formatRupiah(p.fixed_markup)}` : null,
    p.min_margin > 0 ? `margin minimum ${formatRupiah(p.min_margin)}` : null,
    p.tax_bps > 0 ? `pajak ${p.tax_label} ${(p.tax_bps / 100).toFixed(2)}%` : null,
    p.rounding.mode === 'none' ? null : `dibulatkan ke ${p.rounding.mode} kelipatan ${p.rounding.step}`,
    Object.keys(p.category_bps).length
      ? `override kategori: ${Object.entries(p.category_bps).map(([k, v]) => `${k}=${(v / 100).toFixed(2)}%`).join(', ')}`
      : null
  ].filter(Boolean).join(', ');
}

const formatter = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});
const numberFormatter = new Intl.NumberFormat('id-ID');

export function formatRupiah(amount) {
  return formatter.format(fromDbAmount(amount));
}

export function formatNumber(n) {
  return numberFormatter.format(Number(n) || 0);
}

/** Format without the currency symbol, for compact UI badges. */
export function formatRupiahPlain(amount) {
  return numberFormatter.format(fromDbAmount(amount));
}

export function toDbAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new MoneyError('amount tidak valid');
  return amount.toFixed(2);
}
