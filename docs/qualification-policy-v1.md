# BOZKOR – Tender Qualification & Opportunity Scoring Requirements

Initial BOZKOR procurement qualification policy (v1, provided by the team on 15 October 2026). The scoring engine in `src/policy/` implements this document; see SPEC section 7.

## 1. Business Context: What BOZKOR Actually Does

BOZKOR is a cross-border industrial sourcing, supply and procurement business operating through two companies:

- **BOZKOR LTD (United Kingdom):** Intended to participate in suitable UK and international public tenders, enter into supply contracts, and coordinate international procurement.
- **BOZKOR Türkiye:** Intended to develop relationships with Turkish manufacturers, support sourcing, quality control, exports and international trading activities.

Our core business model is to identify international procurement opportunities, source suitable products from Turkish manufacturers or authorised distributors, and supply these products to public or private buyers at a commercial margin.

We are generally **not the manufacturer**.

However, we can work with manufacturers through supply agreements, authorised distribution, subcontracting, joint bidding or other legally permitted arrangements.

### Our competitive advantage

Our main advantage is not ownership of factories or warehouses.

It is our ability to:

1. Identify relevant international purchasing requirements.
2. Find Turkish manufacturers capable of meeting them.
3. Validate technical, regulatory and commercial compatibility.
4. Obtain competitive manufacturer quotations.
5. Coordinate shipping, quality assurance and delivery.
6. Manage the buyer's contract and commercial relationship.

The internal platform should help us perform this process faster, more accurately and at lower operational cost.

### Current business constraints

We are an early-stage company.

Our financial and operational situation should be used to calibrate the scoring system:

- Approximately €25,000 total available cash capital.
- A portion should be protected as an emergency and administrative reserve.
- An indicative initial allocation is €17,000 for contracts, €5,000 reserve and €3,000 setup expenses. These are configurable planning figures, not fixed legal restrictions.
- We do not currently operate a large warehouse network.
- We do not have an established network of technicians in every destination country.
- We do not yet possess a substantial portfolio of completed public procurement contracts.
- We cannot assume access to bank credit, trade finance, letters of credit or manufacturer credit unless confirmed.
- Money available to our Turkish company must not automatically be treated as available liquidity in our UK company.
- We are building a manufacturer database in parallel with the tender discovery engine.

The initial goal is to win and profitably execute our first international supply contracts, build references and expand gradually.

**The platform must optimise for executable, profitable opportunities, not simply for the largest tender values or the highest number of discovered tenders.**

---

# PART I – FIVE REAL TENDERS THAT WERE UNSUITABLE

These are actual procurement opportunities we previously reviewed.

Use them as negative examples and regression test cases.

The purpose is not to ban their product categories permanently. The purpose is to understand why these particular contracts were unsuitable for BOZKOR at its current stage.

## Example 1: Bulgaria – Tyres, Rims and Technical Services

**Tender:** TED 702149-2026
**Buyer:** Tundzha State Hunting Enterprise, Bulgaria
**Estimated value:** €24,100 excluding VAT
**Contract duration:** 24 months
**Contract type:** Supplies, divided into three lots.

### What the buyer wanted

The contract covered tyres and rims for passenger vehicles, trucks, tractors and forestry/agricultural machinery.

However, the buyer also required related technical services, including tyre fitting, removal, balancing, repairs and vulcanisation.

The tender's qualification criteria referenced the availability of appropriate technical equipment, including tyre-changing and balancing equipment and vehicle-lifting facilities.

### Why we rejected it

Although tyres and rims are products that can be sourced from Türkiye, this was not a straightforward international goods supply contract.

It effectively required access to a local technical service operation in Bulgaria throughout a 24-month period.

The entire estimated value was only €24,100.

Even a hypothetical 20% contribution margin across the whole contract would produce only €4,820 over two years, before any costs not already accounted for.

Establishing and managing a Bulgarian service partnership for such a limited contract value was commercially unattractive.

### System lesson

A tender classified as `Supplies` can contain substantial mandatory service obligations.

The system must examine the description, qualification criteria, technical requirements and draft contract.

It must not rely only on CPV codes or procurement type.

### Proposed rule

`LOCAL_SERVICE_REQUIRED + NO_VERIFIED_SERVICE_PARTNER + LOW_VALUE_MULTIYEAR_CONTRACT`

**Decision: COMMERCIAL NO-BID**

If a verified local partner already exists and the contract economics justify the partnership, the system may reopen the opportunity.

This is a commercial rejection, not necessarily a legal prohibition.

---

## Example 2: Bulgaria – Vehicle Spare Parts

**Tender:** TED 634842-2026
**Buyer:** Razlog State Forestry Enterprise, Bulgaria
**Estimated value:** €25,000 excluding VAT
**Duration:** 24 months
**Main CPV:** 34300000 – Parts and accessories for vehicles.

### What the buyer wanted

The buyer sought vehicle spare parts for its fleet over a two-year contract period.

The award criterion was the lowest price. Submission documents were in Bulgarian.

The notice indicated electronic ordering.

### Why we rejected it

The nominal contract size initially looked appropriate for BOZKOR.

However, €25,000 spread across 24 months represents an average of approximately €1,042 monthly revenue if purchases were evenly distributed.

This is not necessarily a single consolidated order.

Repeated orders may require:

- Maintaining access to many different spare parts.
- Handling low-volume shipments.
- Responding rapidly to local fleet requirements.
- Managing returns and incorrect parts.
- Competing against established Bulgarian vehicle-parts distributors.

The tender did not provide enough evidence to conclude that a local warehouse was legally mandatory. Nevertheless, the commercial structure strongly favoured established local suppliers.

### System lesson

**Contract duration, order frequency and delivery structure matter more than nominal contract value.**

A €25,000 contract delivered in one shipment can be attractive.

A €25,000 contract requiring many small shipments over 24 months can be unattractive.

### Proposed rule

`LOW_CONTRACT_VALUE + LONG_DURATION + REPEATED_SMALL_ORDERS + HIGH_LOCAL_FULFILMENT_FRICTION`

**Decision: LOW PRIORITY / COMMERCIAL NO-BID**

Do not reject all spare-parts tenders.

Prefer fixed quantities, clearly identified part numbers and one or two consolidated deliveries.

---

## Example 3: United Kingdom – Breathing Air Compressor Replacement

**Tender:** Find a Tender 096535-2026
**Buyer:** Corserv Solutions Ltd
**Location:** Cornwall Airport
**Estimated value:** £25,000 excluding VAT.

### What the buyer wanted

A high-pressure breathing-air compressor suitable for filling firefighters' breathing apparatus cylinders.

Requirements included:

- Maximum filling pressure of 300 bar.
- Minimum free air delivery of 320 litres/minute.
- Compliance with BS EN 12021 breathing-air quality requirements.
- Installation or connection to the existing filling arrangement.
- Commissioning and testing.
- Operator training.
- UK-based technical support.
- Warranty obligations.

### Why we rejected it

The contract value was almost ideal.

However, the product was safety-critical, technically specialised and accompanied by commissioning, training and local servicing requirements.

BOZKOR could potentially source the equipment from a manufacturer, but we did not have a verified UK technical service partner ready to undertake those responsibilities.

There was also insufficient preparation time.

### System lesson

**An attractive contract value cannot compensate for unfulfilled technical or operational obligations.**

A £25,000 goods tender can be substantially more difficult than a £50,000 tender for standard industrial materials.

### Proposed rule

`SAFETY_CRITICAL_EQUIPMENT + COMMISSIONING_REQUIRED + LOCAL_AFTERSALES_SUPPORT_REQUIRED`

**Decision: NEEDS CERTIFIED OEM + LOCAL SERVICE PARTNER**

If the required technical services cannot be secured before the deadline:

**Decision: NO-BID**

This does not mean every generator, compressor or industrial machine tender should be rejected.

The system must distinguish between supply-only contracts and contracts containing installation, commissioning or maintenance.

---

## Example 4: Lithuania – Defence Agency Generator Procurement

**Tender:** TED 711554-2026
**Buyer:** Lithuanian Defence Resources Agency
**CPV:** 31120000 – Generators
**Contract duration:** 36 months
**Lots:** Six.

### What the buyer wanted

Six generator categories:

| Lot | Product | Minimum–maximum quantity |
|---|---|---|
| 1 | Portable 6 kW generators | 70–91 |
| 2 | Portable 10 kW generators | 369–479 |
| 3 | Trailer-mounted 20 kW generators | 49–63 |
| 4 | Trailer-mounted 50 kW generators | 38–49 |
| 5 | Trailer-mounted 100 kW generators | 97–126 |
| 6 | Trailer-mounted 200 kW generators | 57–74 |

The initial TED notice did not disclose the full commercial and technical complexity.

Those requirements became clear only after examining the additional procurement documents.

### Critical qualification requirements

The buyer required documented previous generator deliveries over the applicable reference period.

The required historical delivery values included approximately:

- Lot 1: €98,467.
- Lot 2: €649,609.
- Lot 3: €405,493.
- Lot 4: €374,214.
- Lot 5: €1,432,902.
- Lot 6: €1,085,955.

There were also specific technical requirements, servicing and spare-parts obligations, and substantial delivery quantities.

The terms permitted certain forms of reliance on other entities' capacities, subject to requirements concerning those entities' actual performance of the relevant work.

### Why we rejected it

BOZKOR does not independently satisfy the historical generator-delivery requirements.

The contract also creates very substantial financing and after-sales obligations.

For example, the first required delivery in Lot 2 involved 153 generators.

Even a competitive manufacturer would need to provide significant operational and potentially financial support.

The deadline was also too close to build and document a compliant partnership from scratch.

### System lesson

This is one of the most important examples for our platform.

A tender may have:

- A relevant CPV code.
- A strong Turkish manufacturing base.
- International participation eligibility.
- Clear demand for physical goods.

But still be commercially or legally impractical for BOZKOR because of qualification and performance requirements.

**The system must read the actual qualification documents, not only the public tender notice.**

### Proposed rule

`MANDATORY_PAST_PERFORMANCE + BOZKOR_DOES_NOT_MEET + NO_ELIGIBLE_PARTNER_CAPACITY_AVAILABLE`

**Decision: QUALIFICATION NO-BID**

If an eligible manufacturer can lawfully provide the necessary capacity through a permitted structure, the opportunity can be reassessed.

However, a manufacturer's catalogue, generic authorisation letter or unrelated experience must never be treated as sufficient proof of qualification.

The manufacturer must meet the actual qualification conditions, and the proposed reliance arrangement must comply with the tender documents.

---

## Example 5: Malta – Street Lighting Installation

**Tender:** TED 599159-2026
**Buyer:** Għargħur Local Council, Malta
**Estimated value:** €14,000
**Product:** Energy-efficient, low-light-pollution street lighting.

### What the buyer wanted

The contract included the supply of street lighting equipment, but installation of bracket-mounted luminaires was also part of the scope.

### Why we rejected it

Turkey has a competitive LED and electrical lighting manufacturing sector.

The actual product category was therefore relevant.

However, the contract involved on-site installation in Malta.

This would require an appropriate local installation arrangement, potentially including electrical contractor qualifications and site-specific safety responsibilities.

For a contract worth approximately €14,000, those obligations could consume most of the commercial margin.

The deadline had also passed when we reviewed it.

### System lesson

**Relevant product category does not equal relevant contract.**

A supply-only LED tender may be highly suitable.

An LED supply-and-installation tender in an overseas market may be unsuitable.

### Proposed rule

`SUPPLIES_NOTICE + MANDATORY_INSTALLATION + NO_LOCAL_PARTNER + LOW_TOTAL_VALUE`

**Decision: COMMERCIAL NO-BID**

For an already expired deadline:

**Decision: EXPIRED / ARCHIVE**

Keep the product category in the matching system for future supply-only opportunities.

---

# PART II – WHAT AN IDEAL BOZKOR TENDER LOOKS LIKE

## 1. The Ideal Tender Profile

Our ideal first-stage public procurement opportunity is:

**An internationally accessible, low-complexity contract for clearly specified industrial or commercial goods that can be sourced from an existing Turkish manufacturer and delivered in one or two shipments without substantial installation, servicing or long-term operational obligations.**

### Preferred parameters

| Parameter | Preferred condition |
|---|---|
| Contract value | €15,000–35,000 or equivalent |
| Contract type | Supplies / Goods |
| Quantity | Clearly defined |
| Delivery pattern | One or two consolidated shipments |
| Contract duration | Preferably 1–6 months |
| Manufacturer | Existing Turkish production capability |
| Product specifications | Clear enough to identify compliant products |
| Product certification | Already available from manufacturer |
| Installation | None or minimal |
| Maintenance | None or limited, manageable warranty |
| After-sales service | Preferably no mandatory local service centre |
| Historical references | None or demonstrably achievable via permitted partner reliance |
| Geographic access | UK or Turkish supplier legally eligible |
| Commercial margin | Preferably at least 15–20% after direct costs |
| Financing | Peak funding requirement within confirmed financing capacity |
| Tender language | English preferred; other languages allowed if manageable |
| Submission deadline | Sufficient time for sourcing, validation and documents |
| Buyer payment | Defined acceptance and payment terms |
| Supplier payment | Compatible with available liquidity |

These are preferences and commercial screening criteria, not universal mandatory rules.

A tender outside one parameter can still be excellent if the other conditions compensate.

## 2. Contract Value Segmentation

Do not simply reject every tender above €35,000.

The system should distinguish five segments.

### Segment A – Micro Opportunities

**Below €5,000**

Generally low commercial priority.

Only attractive when:

- Supplier already exists.
- Product is standard and available.
- Quotation preparation takes little time.
- Delivery is straightforward.
- Absolute profit justifies the work.

These should enter a `FAST QUOTE` queue rather than require full research.

### Segment B – Small Opportunities

**€5,000–15,000**

Potentially useful for gaining first customers and transaction experience.

We should prioritise standard industrial goods, short lead times and low administrative costs.

### Segment C – Core Target

**€15,000–35,000**

Our preferred first-stage public procurement size.

This range is large enough to offer meaningful contribution margin but may still be manageable with current capital, depending on supplier terms and cash flow.

### Segment D – Expansion Opportunities

**€35,000–60,000**

Conditionally attractive.

Require stronger financial validation, supplier payment terms, customer milestones or separately committed trade finance.

Do not reject solely because the contract exceeds €35,000.

### Segment E – Large Opportunities

**€60,000 and above**

Treat as strategic or partnership opportunities unless confirmed financing and manufacturer support make direct supply feasible.

Contracts above €75,000–100,000 will generally require additional diligence.

Very large contracts may be suitable for a commission, consortium or manufacturer-led model, but should not be treated as ordinary self-financed supply opportunities.

### Critical distinction

**Contract value is not the same as required capital.**

For instance:

- A €50,000 contract with buyer advance payments and 60-day manufacturer credit may be feasible.
- A €20,000 contract with 100% supplier prepayment and late customer payment may be unattractive.

The system must calculate actual peak cash exposure before deciding.

---

# PART III – PREFERRED PRODUCT CATEGORIES

## Priority 1 – Core Industrial Sourcing

These are our highest-priority categories.

### A. Metal components and general industrial hardware

Examples:

- Bolts, nuts, screws, washers.
- Fasteners and fittings.
- Hinges and metal brackets.
- Precision-machined metal components.
- Stainless steel components.
- Springs.
- Bushings and couplings.
- Shafts and gears.
- Metal enclosures.
- Fabricated metal structures.
- Basic industrial mechanical components.

Why suitable:

Türkiye has relevant manufacturing capabilities, custom production may be possible, and many products can be shipped internationally without installation.

However, highly safety-critical, unusually precise or OEM-restricted components require additional engineering validation.

### B. Pipes, fittings and industrial materials

Examples:

- HDPE pipes.
- Steel pipes.
- Drainage components.
- Pipe fittings.
- Valves.
- Hoses.
- Rubber seals.
- Gaskets.
- Plastic industrial components.

Why suitable:

Products may be sourced from existing Turkish manufacturers with clear specifications.

Main risks include freight volume, pressure ratings, certification, dimensional tolerances and delivery conditions.

### C. Furniture and metal storage products

Examples:

- Office furniture.
- School furniture.
- Outdoor seating.
- Tables.
- Metal cabinets.
- Lockers.
- Shelving.
- Industrial storage systems.
- Archive cabinets.

Why suitable:

Competitive manufacturing and relatively understandable technical requirements.

Avoid tenders with substantial bespoke installation, local assembly, maintenance or unreasonable warranty requirements unless adequately supported.

### D. Packaging and basic manufactured consumables

Examples:

- Archive boxes.
- Storage boxes.
- Plastic containers.
- Commercial bins.
- Basic packaging products.
- Sacks.
- Bags.
- Other standard manufactured supplies.

Why suitable:

Products can often be supplied in consolidated shipments.

Specialised archival, medical or food-contact products may have stricter material and testing requirements.

---

## Priority 2 – Suitable with Additional Validation

### E. Textiles and workwear

Examples:

- Uniforms.
- Industrial workwear.
- T-shirts.
- Towels.
- Bags.
- Work trousers.
- Commercial textile products.
- Basic protective clothing.

Strong Turkish manufacturing potential.

Important risks:

- Fabric specifications.
- Colour consistency.
- Sizing.
- Brand/customisation.
- Sample approval.
- Product testing.
- Large minimum order quantities.
- Long-term replenishment obligations.

PPE products must be checked against applicable product safety legislation and certification requirements.

### F. Electrical and lighting products

Examples:

- Cables.
- Cable accessories.
- Electrical connectors.
- Basic distribution components.
- LED luminaires.
- Industrial lighting fixtures.
- Certain battery and power components.

Important risks:

- Electrical safety.
- EMC.
- Product marking.
- Required declarations and certificates.
- Warranty.
- Installation or commissioning.

Prefer supply-only contracts.

### G. Basic industrial equipment

Examples:

- Small portable generators.
- Industrial filters.
- Non-specialised pumps.
- Selected tools.
- Basic mechanical equipment.

These are potentially attractive only when technical compliance, warranty and service arrangements can be demonstrated.

Do not treat industrial machinery as automatically equivalent to simple industrial consumables.

---

## Priority 3 – Opportunistic / Strategic

These should be monitored but not receive the same priority as our core categories.

- Complex generators.
- Safety-critical machinery.
- Specialised medical products.
- Complex electronics.
- Original-equipment automotive parts.
- High-value commodities.
- Large prefabricated structures.
- Products involving extensive site installation.
- Long-term equipment maintenance contracts.

These may be attractive with a verified specialist manufacturer, sufficient margin and a workable delivery/financing structure.

They should not consume most of our initial sourcing budget.

---

# PART IV – WHAT WE WANT TO AVOID

The system must recognise these risk patterns.

## 1. Mandatory Local Installation

Examples:

- Electrical installation.
- On-site equipment assembly.
- Civil works.
- Mechanical commissioning.
- Specialist system integration.

**Default:** Negative operational score.

If installation is mandatory and no qualified partner exists, classify as `NEEDS LOCAL PARTNER`.

If the deadline makes obtaining a partner impossible, classify as `NO-BID`.

Do not automatically reject minor assembly or basic furniture setup if it can be outsourced economically.

## 2. Mandatory Local Maintenance and Repair

Examples:

- 24/7 technical support.
- Emergency repairs within hours.
- Mandatory in-country service centre.
- Periodic servicing.
- Call-out obligations.
- Two-year local maintenance schedules.

**Default:** Strong negative indicator.

The system must calculate the likely cost and practical availability of these services.

## 3. Long-Term, Low-Value Supply Contracts

Examples:

- €20,000 spread across 24 months.
- Repeated small deliveries.
- Unpredictable spare-parts orders.
- Low-value framework agreements with no guaranteed minimum.

These can be economically unattractive even where the product category is suitable.

The system must evaluate:

- Total contract value.
- Guaranteed minimum purchase value.
- Number of expected shipments.
- Estimated revenue per delivery.
- Cost per shipment.
- Minimum order quantities.
- Inventory requirements.
- Contract administration time.

**36-month duration alone is not a rejection criterion.**

The delivery and commitment structure must be analysed.

## 4. Restrictive Brand or OEM Requirements

Examples:

- Only one original brand accepted.
- Approved-source manufacturer required.
- No equivalent products permitted.
- Specific historical supplier approval required.

Do not automatically reject brand-specific tenders.

If we can source genuine products from an authorised distributor and satisfy the tender terms, participation may be possible.

However:

`MANDATORY_APPROVED_SOURCE + NO_AUTHORISED_SUPPLY_CHANNEL + NO_ALTERNATIVES`

should lead to `NO-BID` if that obstacle is confirmed and cannot be resolved in time.

Counterfeit or unverifiable-origin components are never an acceptable sourcing solution.

## 5. Mandatory Certifications We Cannot Satisfy

Certification requirements must be separated into:

1. **Bidder-level certifications:** Must be held by BOZKOR or another qualifying entity as permitted by the tender.
2. **Manufacturer-level certifications:** May be satisfied by an eligible producer.
3. **Product-level certifications:** Must relate to the actual product/model supplied.
4. **Project-specific approvals:** May require additional tests or independent approval.

Do not automatically reject tenders merely because CE, ISO, EN, UKCA or another standard is mentioned.

Determine exactly who must hold the certification, whether it applies to the product and whether manufacturer documentation is accepted.

If mandatory compliance cannot be demonstrated, the tender cannot advance to final bid approval.

## 6. Mandatory Past Performance

Newly established BOZKOR does not have extensive historical public-contract references.

The system must extract any requirements concerning:

- Previous contract values.
- Number of comparable deliveries.
- Relevant reference periods.
- Required product category.
- Minimum turnover.
- Previous public procurement experience.

It must also determine whether reliance on another entity, subcontracting or consortium participation is legally accepted.

Do not assume a manufacturer reference automatically qualifies BOZKOR.

## 7. Special Export Controls and Restricted Products

For our initial stage, avoid prioritising controlled defence articles, weapons, ammunition, military-specific restricted equipment and products requiring complex export authorisations.

We may consider additional regulated categories in the future, but should not assume the company currently holds all required permits.

A defence ministry purchasing ordinary commercial goods is not automatically disqualifying.

A regulated product and a defence-sector buyer are different concepts.

## 8. Overly Complex Logistics

Examples:

- Multi-country delivery requiring separate import arrangements.
- Many individual delivery points.
- Frequent emergency shipments.
- Large, unusually bulky items with very low value.
- Cold-chain or perishable goods.
- Products requiring specialist handling.
- DDP arrangements without a verified importer/customs solution.

These are negative indicators, not automatic rejections.

If the logistics can be managed profitably through a verified provider, the opportunity remains eligible.

---

# PART V – HOW THE SOFTWARE SHOULD MAKE DECISIONS

## 1. Never Use One Score Alone

I want the system to calculate three separate scores.

### A. Opportunity Fit Score

Question:

**How closely does this opportunity match BOZKOR's business model?**

Examples of relevant factors:

- Product category.
- Turkish manufacturing advantage.
- Product standardisation.
- Delivery structure.
- Geographic access.
- Contract complexity.

### B. Bid Readiness Score

Question:

**Can BOZKOR submit a credible, compliant bid with its current resources and available time?**

Factors:

- Tender documents available.
- Eligibility confirmed.
- Manufacturer identified.
- Required certifications verified.
- Qualification conditions satisfied.
- Quotation obtained.
- Submission documents prepared.
- Deadline feasibility.

### C. Commercial Viability Score

Question:

**Can the contract be executed profitably and financed without unacceptable risk?**

Factors:

- Actual landed cost.
- Manufacturer pricing.
- Payment schedule.
- Peak cash requirement.
- Logistics.
- Warranty reserves.
- Expected contribution margin.
- Downside sensitivity.

A high Opportunity Fit Score does not automatically mean we should bid.

A tender can have a fit score of 90/100 and still be `NO-BID` because of mandatory historical references or unavailable financing.

---

## 2. Preliminary 100-Point Scoring Model

Use this weighting structure as the initial scoring policy.

| Dimension | Weight |
|---|---:|
| A. Product and manufacturer suitability | 15 |
| B. Technical and qualification compliance | 15 |
| C. Operational complexity | 15 |
| D. Cash flow and financing | 20 |
| E. Profitability and contract economics | 15 |
| F. Logistics and customs | 10 |
| G. Timing and deadline readiness | 5 |
| H. Competitiveness and bid effort | 5 |
| **Total** | **100** |

Each dimension should contain measurable subcriteria.

Scores should be normalised consistently.

The system should be able to explain exactly why each dimension received its score.

### A. Product and Manufacturer Suitability – 15 points

Evaluate:

- Whether the product belongs to our preferred categories.
- Whether a Turkish manufacturer can plausibly supply it.
- Whether the product is standard or custom-manufactured.
- Whether a verified manufacturer already exists in our database.
- Whether the requested quantity is compatible with likely MOQ.
- Whether there is any meaningful Turkish manufacturing advantage.

### B. Technical and Qualification Compliance – 15 points

Evaluate:

- Completeness of technical specifications.
- Product certification requirements.
- Bidder-level eligibility and qualifications.
- Historical contract references.
- Mandatory samples or testing.
- OEM approval requirements.
- Product conformity evidence.

### C. Operational Complexity – 15 points

Evaluate:

- Installation.
- Commissioning.
- Maintenance.
- Training.
- Warranty.
- Local technical support.
- Number of delivery locations.
- Ongoing inventory requirements.

A single shipment with no installation should generally score highly.

A contract requiring a permanent overseas service operation should generally score poorly unless an established partner is available.

### D. Cash Flow and Financing – 20 points

Evaluate:

- Confirmed funding available to the contracting BOZKOR entity.
- Manufacturer deposit.
- Remaining manufacturer payment.
- Logistics payment timing.
- Import duties and any VAT cash exposure.
- Contract guarantees and collateral.
- Buyer advance payments.
- Buyer acceptance period.
- Expected payment delays.
- Availability and timing of documented financing.

**Calculate peak cash deficit over time, not simply total product cost.**

For each period:

`Ending Cash = Starting Cash + Confirmed Cash Inflows – Required Cash Outflows`

Calculate the maximum projected shortfall before final buyer payment.

Test delayed acceptance, late customer payment and cost overruns.

Only confirmed finance facilities or enforceable commercial terms should be included in an approved financing scenario.

### E. Profitability and Contract Economics – 15 points

Evaluate:

- Expected revenue excluding recoverable taxes.
- Manufacturer purchase cost.
- Freight.
- Duties.
- Non-recoverable taxes.
- Insurance.
- Inspection.
- Packaging.
- Samples.
- Warranty provisions.
- Financing cost.
- Contract administration.
- Expected returns or defects.

Calculate:

`Contribution Margin = (Revenue – Direct Contract Costs) / Revenue × 100`

Our preferred contribution margin is approximately **15–20% or higher**, depending on risk.

This is a target, not a universal legal threshold.

A lower margin may occasionally be acceptable for a strategically valuable, low-risk first transaction, subject to manual approval.

Also consider **absolute contribution**, not only percentage margin.

A 30% margin on a €500 order may not justify extensive tender preparation.

### F. Logistics and Customs – 10 points

Evaluate:

- Country of destination.
- Number of delivery points.
- Incoterms.
- Freight volume and weight.
- Customs and importer responsibilities.
- Delivery handling requirements.
- Local delivery arrangements.
- Insurance and damages risk.
- Product origin restrictions.

A UK bidder supplying Turkish-origin goods must be treated separately from a UK-origin product.

The country of incorporation does not automatically determine the goods' origin.

### G. Timing and Deadline – 5 points

Evaluate:

- Days and hours until submission.
- Whether all procurement documents have been obtained.
- Manufacturer quotation lead time.
- Sample preparation.
- Translation.
- Mandatory site visits.
- Registration requirements.
- Clarification deadline.
- Expected delivery date.

If the deadline has already passed, classify the tender as expired.

If less than seven days remain and critical samples or manufacturer documents are unavailable, impose a severe readiness penalty.

Do not automatically reject every opportunity with fewer than seven days remaining if the manufacturer and documents are already prepared.

### H. Competitiveness and Bid Effort – 5 points

Evaluate:

- Lowest-price versus price/quality award.
- Price competitiveness.
- Number of credible competitors, if supported by evidence.
- Local supplier advantage.
- Number of documents to prepare.
- Translation and bid costs.
- Likely supplier response time.
- Expected value relative to effort.

Do not invent competition intensity when bidder or market data is unavailable.

---

# PART VI – HARD GATES AND CONDITIONAL GATES

The decision engine must apply mandatory checks before scoring can lead to an actionable recommendation.

## Hard Gates

### H01 – Deadline Expired

If the authoritative current deadline has passed:

`EXPIRED / ARCHIVE`

Never mark an expired tender as currently bid-ready.

Keep it as historical training data.

### H02 – Confirmed Legal Ineligibility

If neither BOZKOR company nor a valid bidding structure can legally participate:

`HARD REJECT`

This must be based on actual procurement rules.

`GPA: No` does not automatically mean UK or Turkish firms are ineligible.

### H03 – Confirmed Mandatory Qualification Failure

If mandatory bidder requirements cannot be met directly or through a permitted structure:

`QUALIFICATION NO-BID`

### H04 – Prohibited or Unauthorised Product

If the specific transaction would require authorisations we do not possess and cannot legally obtain in time:

`HARD REJECT / COMPLIANCE BLOCK`

### H05 – Unachievable Mandatory Performance

If a mandatory requirement has been verified and cannot be fulfilled in the available time:

`NO-BID`

Examples include a compulsory site visit already missed or an unavailable mandatory product approval.

Do not equate missing evidence with confirmed impossibility.

---

## Conditional Gates

These should suspend bid readiness rather than automatically eliminate the opportunity.

| Rule | Trigger | Decision |
|---|---|---|
| C01 | Technical documents unavailable | NEEDS DOCUMENTS |
| C02 | Manufacturer not identified | NEEDS SUPPLIER |
| C03 | Local service required but no partner | NEEDS PARTNER |
| C04 | Funding shortfall not yet resolved | NEEDS FINANCE |
| C05 | Product certificate not yet verified | NEEDS COMPLIANCE |
| C06 | Buyer quantity or specifications inconsistent | NEEDS CLARIFICATION |
| C07 | Samples mandatory and not ready | NEEDS SAMPLES |
| C08 | Unknown import/Incoterms obligations | NEEDS LOGISTICS |
| C09 | Manufacturer references may be needed | NEEDS QUALIFICATION REVIEW |

### Fundamental rule

**Unknown does not mean failed. Unknown also does not mean passed.**

The platform must preserve these distinctions:

- `PASS`
- `FAIL`
- `UNKNOWN`
- `NOT_APPLICABLE`

A verified failure and missing information must never produce the same result.

---

# PART VII – DOCUMENT ANALYSIS REQUIREMENTS

One of the most important lessons from the Lithuanian generator procurement is that the TED notice alone can be seriously misleading.

The complete scoring pipeline should consider:

1. Tender notice.
2. Lot descriptions.
3. Technical specifications.
4. Qualification requirements.
5. Historical reference requirements.
6. Pricing forms and bills of quantities.
7. Delivery schedules.
8. Draft contract.
9. Award criteria.
10. Clarification documents.
11. Contract amendments.
12. Updated or replacement technical specifications.

### Version handling

The most recent valid amendment must take precedence over superseded documents.

However, the system should retain the earlier versions and record what changed.

For example, a change notice may alter:

- Submission deadline.
- Product specifications.
- Quantity.
- Warranty.
- Eligibility.
- Delivery conditions.

The platform must identify these changes and recalculate the relevant scores.

### Evidence traceability

Every material conclusion must preserve:

- Source document.
- Page or section.
- Extracted requirement.
- Evidence confidence.
- Extraction timestamp.
- Applicable version.
- Whether human verification is required.

For example:

`Mandatory past generator deliveries: €98,467`

must be linked to the relevant qualification document, not merely stated in an AI-generated summary.

### Missing documents

If a tender looks attractive but qualification documents are missing, do not classify it as fully suitable.

Return:

`NEEDS DOCUMENTS`

and identify exactly which documents would resolve the uncertainty.

---

# PART VIII – MANUFACTURER MATCHING INTEGRATION

The screening engine must eventually connect with BOZKOR's Turkish manufacturer database.

The manufacturer database should not contain only company names and industry categories.

Each manufacturer should have a structured capability profile.

### Required manufacturer fields

- Legal company name.
- Country and factory location.
- Business registration identifiers.
- Website and verified contact information.
- Product categories.
- Product catalogue.
- Manufacturing methods.
- Materials processed.
- Dimensional capabilities.
- Standards and certifications.
- Product-specific certifications.
- Manufacturing capacity.
- Minimum order quantities.
- Standard production lead times.
- Custom manufacturing capability.
- Sample availability.
- Export experience.
- Typical payment terms.
- Warranty capability.
- After-sales support locations.
- Relevant previous deliveries.
- Verification status.
- Historical BOZKOR RFQ responses.
- Quotations and previous transaction performance.

### Matching process

When an opportunity is identified, the platform should:

**Step 1:** Extract the requested product and technical requirements.

**Step 2:** Generate candidate manufacturers based on product categories, manufacturing methods and semantic matching.

**Step 3:** Check mandatory technical and regulatory requirements.

**Step 4:** Check quantity, MOQ, capacity and lead time.

**Step 5:** Check whether the manufacturer can provide any qualifications BOZKOR needs to rely upon.

**Step 6:** Calculate the likely sourcing effort.

**Step 7:** Recommend the best manufacturers for RFQ outreach.

### Matching scores

Use a separate 100-point Manufacturer Match Score:

| Dimension | Weight |
|---|---:|
| Product/manufacturing capability match | 25 |
| Technical specification compatibility | 20 |
| Certification and quality assurance | 15 |
| Capacity and MOQ | 10 |
| Lead time | 10 |
| Price competitiveness | 10 |
| Export and logistics readiness | 5 |
| Commercial responsiveness/reliability | 5 |
| **Total** | **100** |

A high semantic similarity score must not be treated as evidence that the manufacturer can produce the item.

Actual technical capability needs documentary or direct manufacturer confirmation.

### Bidder versus manufacturer qualification

An especially important distinction:

A manufacturer may have ISO certification, references or production equipment, while BOZKOR itself does not.

The system must identify whether those manufacturer credentials can legally be relied upon by the bidder.

Do not automatically transfer manufacturer qualifications to BOZKOR.

---

# PART IX – EXAMPLES OF GOOD OR PROMISING OPPORTUNITIES

Use these as positive or conditional-positive reference cases.

## Positive Example A – UK Outdoor Café Furniture

**Tender:** Find a Tender 096735-2026
**Buyer:** Eryri National Park Authority
**Value:** £12,500.

Products:

- 20 outdoor chairs.
- Five outdoor tables.
- Stacking trolley.

Why attractive:

- Clearly defined physical products.
- Relevant Turkish manufacturing capabilities.
- No major commissioning requirement apparent.
- Potential for consolidated delivery.
- Manageable nominal contract value.

Important condition:

The buyer required a 15-year warranty.

Therefore:

`HIGH PRODUCT FIT + LONG WARRANTY UNVERIFIED`

must produce:

`NEEDS MANUFACTURER WARRANTY CONFIRMATION`

not immediate bid approval.

A manufacturer-backed warranty and spare-parts undertaking could improve the opportunity's readiness.

## Positive Example B – Industrial Metal Components

Example based on an actual B2B requirement for 3,000 stainless steel compression springs delivered to Spain.

Why attractive:

- Turkish precision manufacturing potential.
- Limited shipment volume.
- Specific technical parameters.
- Custom manufacturing may create added commercial value.
- No obvious requirement for an overseas service centre.

Important conditions:

- Confirm dimensions and tolerances.
- Resolve contradictory winding directions.
- Validate sample performance.
- Clarify delivery terms and import responsibilities.

This is not a public tender, so it should enter the B2B RFQ pipeline rather than be mixed directly with public procurement scoring.

## Positive Example C – Premium Kitchen Towels

Actual B2B requirement for 300, 500 or 1,000 sets of four linen-cotton kitchen towels.

Why attractive:

- Strong Turkish textile production capabilities.
- Straightforward product and packaging.
- Private-label opportunity.
- Relatively low capital requirement.
- No complex installation.

Important conditions:

- Manufacturer MOQ.
- Fabric composition.
- Colour availability.
- Sample acceptance.
- Absolute profitability of the smaller quantities.

These examples demonstrate that we want **small and medium orders where our manufacturer network creates a real sourcing advantage**.

---

# PART X – SCORING AND DECISION OUTPUT

The platform should return both a numeric evaluation and an actionable classification.

## Proposed status categories

### 1. HARD REJECT

Confirmed legal or mandatory compliance obstacle.

### 2. EXPIRED

Submission deadline has passed.

### 3. COMMERCIAL NO-BID

Opportunity may be legally accessible but does not justify the costs, capital commitment or operational risk.

### 4. NEEDS DOCUMENTS

Critical tender documents unavailable.

### 5. NEEDS SUPPLIER

Relevant product but no verified manufacturer.

### 6. NEEDS PARTNER

Local installation or service partner required.

### 7. NEEDS FINANCE

Commercially promising but currently unfunded.

### 8. NEEDS QUALIFICATION REVIEW

Eligibility or mandatory references require assessment.

### 9. WATCH

Interesting category or buyer, but the present opportunity is not worth pursuing.

### 10. SHORTLIST

Good opportunity that merits active sourcing and commercial analysis.

### 11. BID REVIEW

Technical, legal, financial and operational conditions have been sufficiently verified to prepare the bid for human approval.

**The platform must never autonomously submit a binding public tender, commit company funds or make legal declarations simply because the score is high.**

---

## Suggested Score Thresholds

| Score | Preliminary interpretation |
|---|---|
| 85–100 | Priority opportunity |
| 70–84 | Strong shortlist |
| 55–69 | Conditional manual investigation |
| 35–54 | Low priority |
| 0–34 | Generally unsuitable |

These thresholds apply only to the preliminary scoring.

Mandatory gate decisions always override the score.

Where critical information is missing, the platform should report a provisional score or score range rather than claim that the calculation is fully verified.

### Confidence model

I also want an independent `Evidence Confidence` or `Data Completeness` measurement.

Examples:

- Product category known, qualification unknown: limited confidence.
- Full specification, contract and qualifications available: higher confidence.
- Manufacturer quotation and delivery commitments confirmed: higher commercial confidence.

Do not convert unsupported assumptions into confirmed facts.

---

# PART XI – IMPORTANT RULES TO PREVENT FALSE REJECTIONS

The platform must not permanently reject a tender solely because:

- It is published by a defence ministry.
- It is from Eastern Europe.
- It is not written in English.
- It is above €35,000.
- It lasts more than 12 months.
- It mentions ISO or CE certification.
- The product is manufactured outside the UK.
- It requests branded products.
- It belongs to a CPV category outside our preferred categories.
- A manufacturer has not yet been identified.
- The original TED notice lacks detailed technical information.

Each of these may represent a risk, but not necessarily a disqualifying condition.

For example:

A €70,000 HDPE pipe contract involving one delivery may be more attractive than a €20,000 multi-year maintenance contract.

Similarly, a defence ministry buying ordinary commercial shelving may be easier to serve than a civilian hospital buying highly specialised equipment.

**The actual scope and contract conditions matter more than the buyer category or tender title.**

---

# PART XII – REQUIRED ENGINEERING BEHAVIOUR

Please implement the scoring engine with the following architecture.

## 1. Lot-level evaluation

Evaluate each lot separately.

A tender with six lots can contain:

- One attractive lot.
- Three unsuitable lots.
- Two requiring further information.

Do not reject or approve all six automatically.

## 2. Separate fact extraction from scoring

The first stage should extract facts from procurement documents.

The second stage should evaluate them against our configurable business policy.

Do not let the language model freely invent scoring rules for each new tender.

## 3. Configurable thresholds

The following must be configurable without rewriting the entire engine:

- Available capital.
- Minimum contribution margin.
- Minimum absolute contribution.
- Target contract size.
- Bid preparation time.
- Supplier response capability.
- Existing countries with local service partners.
- Preferred product categories.
- Accepted financing arrangements.
- Manufacturer database confidence requirements.

As BOZKOR completes contracts and expands, the system should adapt.

## 4. Explainability

Every decision should answer:

**Why did the system produce this decision?**

For example:

> COMMERCIAL NO-BID: This €24,100 tyre supply contract lasts 24 months and includes mandatory local fitting and balancing services. BOZKOR has no verified Bulgarian service partner. The projected operational burden is disproportionate to the contract value.

Avoid explanations such as:

> Low score because the tender is unsuitable.

## 5. Action recommendations

Every non-final opportunity should receive the next required action.

Examples:

- Download the qualification annex.
- Ask the buyer whether manufacturer references are accepted.
- Identify two Turkish manufacturers.
- Obtain the technical datasheet.
- Confirm delivery cost.
- Verify the applicable certification.
- Calculate peak working capital.
- Obtain local installation partner pricing.

## 6. Preserve rejected opportunities

Rejected tenders should remain in the database.

Store their:

- Tender identifier.
- Lot identifier.
- Product category.
- Contract value and currency.
- Rejection reason.
- Blocking conditions.
- Original source documents.
- Decision timestamp.
- Scoring policy version.

This is necessary for later calibration and regression testing.

## 7. Separate B2B RFQs from public tenders

The platform will eventually ingest two distinct types of opportunities:

**Public Procurement:** Legally structured tender procedures with mandatory qualification rules, deadlines and contracts.

**B2B Buyer RFQs:** Commercial buyer inquiries with varying levels of credibility, technical detail and commitment.

They can share the same product taxonomy, manufacturer database and commercial analysis.

However, they should not use exactly the same lead-qualification rules.

For B2B requests, buyer authenticity, purchase intent, payment risk and order maturity must carry more importance.

A platform's `VERIFIED` badge must not be treated as proof of creditworthiness or a confirmed purchase order.

---

# PART XIII – FINAL BUSINESS PRINCIPLE

Our objective is not to win the largest number of tenders.

Our objective is to discover and execute international supply opportunities where:

1. We are genuinely eligible to participate.
2. Turkish manufacturing or distribution gives us a competitive advantage.
3. We can prove product compliance.
4. We can obtain a credible and competitively priced supplier quotation.
5. We can finance the contract.
6. We can deliver the goods on time.
7. We can fulfil warranty and other contractual obligations.
8. We can make a commercially meaningful profit.

The system must therefore distinguish between three questions:

**Can we bid?**

**Can we deliver?**

**Should we bid?**

A tender should only reach `BID REVIEW` when the answers to all three are supported by evidence.

Please treat these requirements as the initial BOZKOR procurement qualification policy and design the scoring system to be explainable, configurable, evidence-based and suitable for future manufacturer matching integration.
