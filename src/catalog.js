// Factory price lists that can be loaded as "on order" inventory in one step.

// Destiny Homes / Cavco Moultrie, GA — dealer quote dated 10-1-26.
// cost = invoice + freight + fees (as quoted); priceHV / priceHM = the margin-vs-volume
// sheet's High Volume and High Margin prices; max21 = 21st Mortgage's max sale price.
// Width, length and bedrooms come from the model code (e.g. LY32663A = 32 x 66, 3 bedrooms).
const CAVCO_MOULTRIE_2026 = {
  key: 'cavco-moultrie-2026-10',
  label: 'Destiny Homes / Cavco Moultrie quote (10-1-26)',
  manufacturer: 'Destiny Homes (Cavco Moultrie)',
  year: 2026,
  freight: { double: 9850, single: 4925 },
  fees: { double: 710, single: 405 },
  models: [
    { name: 'Reece', model: 'LY32663A', type: 'double', cost: 129105, priceHV: 144105, priceHM: 151105, max21: 215377, featured: true },
    { name: 'Maverick', model: 'LY28563A', type: 'double', cost: 100171, priceHV: 115171, priceHM: 122171, max21: 171977, featured: true },
    { name: 'LY32764C', model: 'LY32764C', type: 'double', cost: 138094, priceHV: 153094, priceHM: 160094, max21: 228861 },
    { name: 'Retreat', model: 'LY16642A', type: 'single', cost: 79876, priceHV: 87876, priceHM: 91876, max21: 137399, featured: true },
    { name: 'Satilla', model: 'LY32764D', type: 'double', cost: 153050, priceHV: 168050, priceHM: 175050, max21: 251296 },
    { name: 'Edge', model: 'EZ32764B', type: 'double', cost: 126617, priceHV: 141617, priceHM: 148617, max21: 211645 },
    { name: 'Iron Ranch', model: 'IH28563A', type: 'double', cost: 80978, priceHV: 95978, priceHM: 102978, max21: 143187, featured: true },
    { name: 'Iron Ranch', model: 'IH16763A', type: 'single', cost: 63034, priceHV: 71034, priceHM: 75034, max21: 112136 },
    { name: 'Providence', model: 'PV32583A', type: 'double', cost: 104474, priceHV: 119474, priceHM: 126474, max21: 178431 },
    { name: 'Providence', model: 'PV32764A', type: 'double', cost: 130327, priceHV: 145327, priceHM: 152327, max21: 217211 },
    { name: 'King', model: 'TE32764B', type: 'double', cost: 156395, priceHV: 171395, priceHM: 178395, max21: 256313, featured: true },
  ],
};

const CATALOGS = { [CAVCO_MOULTRIE_2026.key]: CAVCO_MOULTRIE_2026 };

function parseModelCode(code) {
  const m = /^[A-Z]{2}(\d{2})(\d{2})(\d)/.exec(code);
  if (!m) return {};
  return { width_ft: Number(m[1]), length_ft: Number(m[2]), bedrooms: Number(m[3]) };
}

const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

// Inventory rows for a catalog, ready to insert.
function catalogHomes(catalog) {
  return catalog.models.map((m) => {
    const dims = parseModelCode(m.model);
    const freight = catalog.freight[m.type];
    const fees = catalog.fees[m.type];
    const wide = m.type === 'double' ? 'double-wide' : 'single-wide';
    const title = m.name === m.model ? m.model : `${m.name} ${m.model}`;
    return {
      stock_number: `ORD-${m.model}`,
      manufacturer: catalog.manufacturer,
      model: title,
      year: catalog.year,
      home_type: m.type === 'double' ? 'Double-wide' : 'Single-wide',
      bedrooms: dims.bedrooms ?? null,
      bathrooms: 2,
      width_ft: dims.width_ft ?? null,
      length_ft: dims.length_ft ?? null,
      square_feet: null,
      price: m.priceHV,
      invoice_cost: m.cost - freight - fees,
      freight_cost: freight,
      other_cost: fees,
      listing: 'order',
      featured: m.featured ? 1 : 0,
      web_description:
        `The ${m.name} is a ${dims.bedrooms || ''}-bedroom ${wide} built by Destiny Homes in Moultrie, Georgia. ` +
        'Order it with the colors and options you want, and we handle delivery and setup.',
      notes:
        `Factory order model from the ${catalog.label}. High Volume price ${money(m.priceHV)} (list), ` +
        `High Margin price ${money(m.priceHM)}, 21st Mortgage max price ${money(m.max21)}. ` +
        'Bathrooms and size come from the model code; check the floor plan before quoting.',
    };
  });
}

module.exports = { CATALOGS, CAVCO_MOULTRIE_2026, catalogHomes, parseModelCode };
