// Brand from the SKU name. Order matters (e.g. "CDM SILK OREO" is Silk, "FIVE STAR OREO" is 5 Star).
const RULES = [
  [['SILK'], 'Silk'],
  [['CELEBRATION'], 'Celebrations'],
  [['BOURNVILLE'], 'Bournville'],
  [['BOURNVITA'], 'Bournvita'],
  [['FIVE STAR', '5STAR', '5 STAR'], '5 Star'],
  [['FUSE'], 'Fuse'],
  [['CDM', 'DAIRY MILK'], 'Dairy Milk'],
  [['OREO'], 'Oreo'],
  [['GEMS'], 'Gems'],
  [['PERK'], 'Perk'],
  [['TANG'], 'Tang'],
  [['CHOCLAIRS', 'CHOCOLAIRS'], 'Choclairs'],
  [['CHOCOBAKES', 'CENTREFIL', 'CB CENTRE'], 'Chocobakes'],
  [['TEMPTATION'], 'Temptations'],
  [['NUTTIES'], 'Nutties'],
  [['HALLS'], 'Halls'],
  [['LOTUS'], 'Lotus Biscoff'],
  [['COCOA POWDER', 'HOT CHOCOLATE'], 'Cocoa & Hot Choc'],
];

export function brandOf(name) {
  const n = String(name || '').toUpperCase();
  for (const [keys, brand] of RULES) if (keys.some(k => n.includes(k))) return brand;
  return 'Other';
}
