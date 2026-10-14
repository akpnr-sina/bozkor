import type { ContractNature } from "./types";

// Only product (supply) tenders enter the system: services, consulting,
// software and works do not (team decision, 14 October 2026; SPEC section 1).

/** CPV division of software packages, which count as supplies but are out of scope. */
const SOFTWARE_DIVISION = "48";

/** CPV divisions 03 to 44 are goods, 45 is works, 50 and above are services. */
function natureFromCpv(cpv: string): ContractNature | null {
  const division = Number(cpv.slice(0, 2));
  if (!Number.isInteger(division)) return null;
  if (division === 45) return "works";
  if (division >= 50) return "services";
  return "goods";
}

/**
 * Whether a tender is in scope: its main nature is goods (or, when the notice
 * does not say, its main CPV is a goods code) and it is not a software package.
 */
export function isProductScope(nature: ContractNature | null, cpvMain: string | null): boolean {
  if (cpvMain?.startsWith(SOFTWARE_DIVISION)) return false;
  const effective = nature ?? (cpvMain ? natureFromCpv(cpvMain) : null);
  return effective === "goods";
}
