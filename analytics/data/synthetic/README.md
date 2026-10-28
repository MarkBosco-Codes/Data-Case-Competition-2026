# Synthetic data: read this first

**Everything in this folder is made up.** The competition brief provides no dataset, so we
generated one from stated real-world assumptions. It is not Lives Group data, and the
customer names are invented.

Made by [`src/make_synthetic_data.py`](../../src/make_synthetic_data.py). The random seed is
fixed, so running it again gives exactly the same files.

## Files

| File | What it is | Equivalent in SAP Business One |
|---|---|---|
| `customers.csv` | Customer master: 56 records = 50 real customers + 6 duplicate records | Business Partners (table OCRD: CardCode, CardName) |
| `orders.csv` | Units ordered per customer record, product and month. A month with no order has no row. | Sales Orders (tables ORDR/RDR1), summed by month |
| `answer_key.csv` | What we planted. **Only for checking our methods afterwards, never as a model input.** | none |

## Assumptions

| Topic | What we assume | Why |
|---|---|---|
| Countries | Singapore (HQ), Malaysia, Thailand, Indonesia, Vietnam | The brief says five Southeast Asian locations but not which. Lives Group's footprint isn't public, so we picked five of the region's largest healthcare markets. |
| Period | Oct 2023 to Sep 2026, 36 months. The dashboard shows the last 12. | Holt-Winters needs 2 full years in every backtest window. SAP B1 keeps all past orders, so the 6–12-month window is a spreadsheet habit, not a data limit. |
| Products | A = diagnostic reagents (sold by SPD), B = medical equipment (QTS), C = lab solutions (QTG) | The brief lists these three lines and three business units but doesn't pair them. |
| Customers | 10 per country: 3 hospitals, 2 medical centres, 2 labs, 3 clinics. Hospitals buy A+B+C, medical centres A+B, labs A+C, clinics A. | A simple, realistic mix of customer types. |
| Size | Base monthly units by type (hospital 300, lab 200, medical centre 120, clinic 30 of Product A), times a random customer size. B is 4% of A's units, C is 30%. | Equipment is bought far less often than reagents. |
| Growth | Singapore 4%, Thailand 5%, Malaysia 6%, Indonesia 9%, Vietnam 10% a year | Anchored on a third-party estimate of about 7% a year for the Southeast Asia diagnostics market ([Meticulous Research](https://www.meticulousresearch.com/product/south-east-asia-in-vitro-diagnostics-market-5613)): mature Singapore below it, fast-growing Indonesia and Vietnam above. |
| Holidays | Fewer orders in holiday months. Lunar New Year (Feb 2024, Jan 2025, Feb 2026): Singapore and Malaysia −7%, Vietnam −25% (Tết). Hari Raya / Eid al-Fitr (Apr 2024, Mar 2025, Mar 2026): Malaysia −12%, Indonesia −20%. Songkran (every April): Thailand −12%. | Real holiday dates. The sizes of the dips are our estimates. |
| Rainy season | +10% reagent (A) orders: Singapore Jun–Aug, Malaysia Dec–Feb, Thailand Jun–Sep, Indonesia Jan–Mar, Vietnam Jul–Oct | Dengue and fever testing rise in the rainy season. The months are rough. |
| Budget year-end | Equipment (B) orders +30% in the second-last month of the public-sector budget year and +60% in the last month. Budget years: Singapore Apr–Mar, Thailand Oct–Sep, others Jan–Dec. | Hospitals spend leftover budget before it closes. |
| Noise | Each month: a random swing (gamma distribution, average 1), then a Poisson count around it | Real orders are noisier than Poisson alone. Together this is a negative binomial. |

## Planted patterns

The answer key records each of these. We use it to check whether our methods find them.

- **6 duplicate records.** Another business unit couldn't find an existing customer and set it up
  again under a different name. Three name styles are used, two duplicates each:
  - abbreviated: `Garuda Diag. Lab`
  - legal name: `NAGA DIAGNOSTICS LABORATORY CO., LTD.`
  - initials: `KPL`

  From the month the duplicate was created, that unit's orders go to the new record. In the raw
  data this looks like a false drop-off on the old record plus a "new" customer.
- **6 cross-sell gaps.** The customer doesn't buy a product that its peers of the same type buy.
- **4 drop-offs.** Orders fade in a straight line to 30% of normal over 6 months. Each starts in
  a random month between Oct 2025 and Apr 2026.

**Honesty line for the pitch:** the patterns were planted, so results show the method works,
not real findings about Lives Group.
