// BOZKOR's product taxonomy for scoring (docs/qualification-policy-v1.md
// part III). The facts stage classifies each lot into one of these codes; the
// policy engine reads the priority. Keep prompts/facts.v1.md in step: a test
// checks every code appears there.

export const PRODUCT_CATEGORIES = {
  // Priority 1: core industrial sourcing.
  METAL_HARDWARE: { priority: 1, label: "Metal parçalar ve genel endüstriyel hırdavat" },
  PIPES_FITTINGS: { priority: 1, label: "Borular, bağlantı parçaları ve endüstriyel malzemeler" },
  FURNITURE_STORAGE: { priority: 1, label: "Mobilya ve metal depolama ürünleri" },
  PACKAGING_CONSUMABLES: { priority: 1, label: "Ambalaj ve temel sarf ürünleri" },
  // Priority 2: suitable with additional validation.
  TEXTILES_WORKWEAR: { priority: 2, label: "Tekstil ve iş kıyafeti" },
  ELECTRICAL_LIGHTING: { priority: 2, label: "Elektrik ve aydınlatma ürünleri" },
  BASIC_EQUIPMENT: { priority: 2, label: "Temel endüstriyel ekipman" },
  // Priority 3: opportunistic or strategic.
  COMPLEX_GENERATORS: { priority: 3, label: "Karmaşık jeneratörler" },
  SAFETY_CRITICAL_MACHINERY: { priority: 3, label: "Güvenlik açısından kritik makine ve ekipman" },
  MEDICAL_SPECIALISED: { priority: 3, label: "Uzmanlık gerektiren tıbbi ürünler" },
  COMPLEX_ELECTRONICS: { priority: 3, label: "Karmaşık elektronik" },
  OEM_AUTOMOTIVE_PARTS: { priority: 3, label: "Orijinal (OEM) araç parçaları" },
  HIGH_VALUE_COMMODITIES: { priority: 3, label: "Yüksek değerli emtia" },
  LARGE_PREFAB_STRUCTURES: { priority: 3, label: "Büyük prefabrik yapılar" },
  SITE_INSTALLED_SYSTEMS: { priority: 3, label: "Sahada kapsamlı kurulum gerektiren ürünler" },
  // Outside the preferred list: not rejected, but no category bonus.
  OTHER_GOODS: { priority: 4, label: "Tercih listesi dışındaki mallar" },
} as const;

export type ProductCategory = keyof typeof PRODUCT_CATEGORIES;
export const PRODUCT_CATEGORY_CODES = Object.keys(PRODUCT_CATEGORIES) as [ProductCategory, ...ProductCategory[]];
