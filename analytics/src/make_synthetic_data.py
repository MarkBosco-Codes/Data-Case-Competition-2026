"""
Make the synthetic dataset for the Lives Group prototype.

SYNTHETIC DATA: nothing here is real Lives Group data. The brief gives no
dataset, so we build one from stated real-world assumptions and plant a few
known patterns, so we can later check whether our methods find them.
Every assumption is listed in data/synthetic/README.md.

Outputs, written to data/synthetic/:
    customers.csv   the customer master as SAP B1 would hold it, duplicates included
    orders.csv      monthly purchase-order quantity per customer record and product
    answer_key.csv  the truth behind the planted patterns; use it only to check methods

Run from the repo folder:  python src/make_synthetic_data.py
"""

from pathlib import Path

import numpy as np
import pandas as pd

rng = np.random.default_rng(seed=2026)  # fixed seed, so every run gives the same data

OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "synthetic"

# 36 months, Oct 2023 to Sep 2026 (the last complete month before the deadline).
MONTHS = [str(p) for p in pd.period_range("2023-10", periods=36, freq="M")]


# ---------------------------------------------------------------------------
# Real-world assumptions (sources and reasoning in data/synthetic/README.md)
# ---------------------------------------------------------------------------

# Yearly demand growth. Anchored on ~7%/year for the Southeast Asia
# diagnostics market: mature Singapore below it, Indonesia and Vietnam above.
ANNUAL_GROWTH = {
    "Singapore": 0.04,
    "Malaysia": 0.06,
    "Thailand": 0.05,
    "Indonesia": 0.09,
    "Vietnam": 0.10,
}

# Public holidays: offices and labs slow down, so fewer orders that month.
# Lunar New Year and Hari Raya move each year, so they are listed by month.
LUNAR_NEW_YEAR = ["2024-02", "2025-01", "2026-02"]
HARI_RAYA = ["2024-04", "2025-03", "2026-03"]  # Eid al-Fitr
SONGKRAN = ["2024-04", "2025-04", "2026-04"]   # Thai New Year
HOLIDAYS = {
    "Singapore": [(LUNAR_NEW_YEAR, 0.93)],
    "Malaysia": [(LUNAR_NEW_YEAR, 0.93), (HARI_RAYA, 0.88)],
    "Thailand": [(SONGKRAN, 0.88)],
    "Indonesia": [(HARI_RAYA, 0.80)],     # Lebaran: a long national break
    "Vietnam": [(LUNAR_NEW_YEAR, 0.75)],  # Tet: the longest break in the region
}

# Rainy season brings dengue and fever testing, so more reagent (Product A)
# orders. Rough months per country.
RAINY_MONTHS = {
    "Singapore": [6, 7, 8],
    "Malaysia": [12, 1, 2],
    "Thailand": [6, 7, 8, 9],
    "Indonesia": [1, 2, 3],
    "Vietnam": [7, 8, 9, 10],
}

# Last month of the public-sector budget year. Hospitals spend leftover
# budget on equipment (Product B) just before it closes.
FISCAL_YEAR_END = {
    "Singapore": 3,  # April to March
    "Malaysia": 12,
    "Thailand": 9,   # October to September
    "Indonesia": 12,
    "Vietnam": 12,
}

# How a company's legal name is written in each country.
LEGAL_NAME = {
    "Singapore": "{} Pte Ltd",
    "Malaysia": "{} Sdn Bhd",
    "Thailand": "{} Co., Ltd.",
    "Indonesia": "PT {}",
    "Vietnam": "{} Co., Ltd.",
}

# Products: A = diagnostic reagents, B = medical equipment, C = lab solutions.
# Each is mainly sold by one business unit (assumption).
PRODUCT_OWNER = {"A": "SPD", "B": "QTS", "C": "QTG"}

# Which products each type of customer normally buys.
PRODUCTS_BY_TYPE = {
    "Hospital": ["A", "B", "C"],
    "Medical Centre": ["A", "B"],
    "Laboratory": ["A", "C"],
    "Clinic": ["A"],
}

# Typical monthly units of Product A by customer type. B and C are scaled from it.
BASE_UNITS_A = {"Hospital": 300, "Medical Centre": 120, "Laboratory": 200, "Clinic": 30}
PRODUCT_SCALE = {"A": 1.0, "B": 0.04, "C": 0.3}

# Fictional customers, 10 per country: 3 hospitals, 2 medical centres,
# 2 laboratories, 3 clinics. The type is read from the end of the name.
CUSTOMER_NAMES = {
    "Singapore": [
        "Harbourview General Hospital", "Kingsway University Hospital", "Silverbrook Hospital",
        "Orchid Medical Centre", "Evergreen Medical Centre",
        "Lionsgate Diagnostics Laboratory", "Straits Pathology Laboratory",
        "Bayfront Specialist Clinic", "Northpoint Family Clinic", "Tanjong Heights Clinic",
    ],
    "Malaysia": [
        "Seri Permata General Hospital", "Bukit Indah University Hospital", "Sinar Hospital",
        "Cempaka Medical Centre", "Mutiara Medical Centre",
        "Selatan Diagnostics Laboratory", "Kenanga Pathology Laboratory",
        "Harmoni Specialist Clinic", "Damai Family Clinic", "Taman Sejahtera Clinic",
    ],
    "Thailand": [
        "Rattana General Hospital", "Saeng Tham University Hospital", "Rimnam Hospital",
        "Lotus Medical Centre", "Mali Medical Centre",
        "Naga Diagnostics Laboratory", "Thong Pathology Laboratory",
        "Sukjai Specialist Clinic", "Baan Suk Family Clinic", "Pattana Clinic",
    ],
    "Indonesia": [
        "Cahaya Harapan General Hospital", "Nusantara University Hospital", "Bintang Hospital",
        "Melati Medical Centre", "Pelita Medical Centre",
        "Garuda Diagnostics Laboratory", "Kartika Pathology Laboratory",
        "Sehat Specialist Clinic", "Bunga Family Clinic", "Merdeka Clinic",
    ],
    "Vietnam": [
        "Hoa Mai General Hospital", "Truong Son University Hospital", "Hai Dang Hospital",
        "Binh Minh Medical Centre", "Ha Thanh Medical Centre",
        "Sao Viet Diagnostics Laboratory", "Kim Long Pathology Laboratory",
        "Thanh Tam Specialist Clinic", "Phuc An Family Clinic", "Tuong Lai Clinic",
    ],
}

# Short forms a requestor might type instead of the full word.
ABBREVIATIONS = {
    "General": "Gen.", "University": "Univ.", "Hospital": "Hosp.",
    "Medical": "Med.", "Centre": "Ctr", "Diagnostics": "Diag.",
    "Pathology": "Path.", "Laboratory": "Lab", "Specialist": "Spec.", "Family": "Fam.",
}

# How many customers get each planted pattern.
N_DUPLICATES = 6
N_CROSS_SELL_GAPS = 6
N_DROPOFFS = 4


# ---------------------------------------------------------------------------
# Customers
# ---------------------------------------------------------------------------

def customer_type(name):
    """Read the customer type from the end of its name."""
    for kind in PRODUCTS_BY_TYPE:
        if name.endswith(kind):
            return kind
    raise ValueError(f"No customer type at the end of: {name}")


def name_variant(name, country, style):
    """Write the same customer's name the way a different requestor might."""
    if style == "abbreviated":  # Kingsway University Hospital -> Kingsway Univ. Hosp.
        return " ".join(ABBREVIATIONS.get(word, word) for word in name.split())
    if style == "legal name":   # -> KINGSWAY UNIVERSITY HOSPITAL PTE LTD
        return LEGAL_NAME[country].format(name).upper()
    if style == "initials":     # -> KUH
        return "".join(word[0] for word in name.split())
    raise ValueError(f"Unknown style: {style}")


def make_customers():
    """One record per real customer, each with a random size (1 = typical)."""
    customers = []
    for country, names in CUSTOMER_NAMES.items():
        for name in names:
            kind = customer_type(name)
            number = len(customers) + 1
            customers.append({
                "true_id": f"T{number:03d}",
                "card_code": f"C{10000 + number}",
                "card_name": name,
                "country": country,
                "customer_type": kind,
                "products": list(PRODUCTS_BY_TYPE[kind]),
                "size": rng.lognormal(mean=0, sigma=0.5),
                "duplicate": None,       # the next three are filled in by plant_patterns
                "cross_sell_gap": None,
                "dropoff_start": None,
            })
    return customers


def plant_patterns(customers):
    """Give a few customers a known pattern. Each customer gets at most one."""
    multi_product = [c for c in customers if len(c["products"]) >= 2]
    picked = rng.choice(len(multi_product), size=N_DUPLICATES + N_CROSS_SELL_GAPS, replace=False)
    duplicate_customers = [multi_product[i] for i in picked[:N_DUPLICATES]]
    gap_customers = [multi_product[i] for i in picked[N_DUPLICATES:]]

    # 1. Duplicates: another business unit can't find the customer and sets it
    #    up again. From then on, that unit's orders go to the new record.
    #    Months are sorted so the card codes follow the order of creation, as in SAP.
    created = sorted(int(m) for m in rng.integers(6, 31, size=N_DUPLICATES))  # index into MONTHS
    styles = ["abbreviated", "legal name", "initials"]
    for n, c in enumerate(duplicate_customers):
        product = str(rng.choice([p for p in c["products"] if p != "A"]))
        c["duplicate"] = {
            "card_code": f"C{10000 + len(customers) + n + 1}",
            "card_name": name_variant(c["card_name"], c["country"], styles[n % len(styles)]),
            "product": product,
            "requested_by": PRODUCT_OWNER[product],
            "switch_month": created[n],
        }

    # 2. Cross-sell gaps: the customer doesn't buy a product its peers buy.
    for c in gap_customers:
        missing = str(rng.choice([p for p in c["products"] if p != "A"]))
        c["products"].remove(missing)
        c["cross_sell_gap"] = missing

    # 3. Drop-offs: orders start fading during the last year.
    untouched = [c for c in customers if c["duplicate"] is None and c["cross_sell_gap"] is None]
    for i in rng.choice(len(untouched), size=N_DROPOFFS, replace=False):
        untouched[i]["dropoff_start"] = int(rng.integers(24, 31))  # index into MONTHS


# ---------------------------------------------------------------------------
# Orders
# ---------------------------------------------------------------------------

def season_factor(country, product, month):
    """Calendar effects for one country, product and month (e.g. '2025-02')."""
    month_number = int(month[5:])
    factor = 1.0
    for holiday_months, effect in HOLIDAYS[country]:
        if month in holiday_months:
            factor *= effect
    if product == "A" and month_number in RAINY_MONTHS[country]:
        factor *= 1.10
    if product == "B":
        year_end = FISCAL_YEAR_END[country]
        month_before = 12 if year_end == 1 else year_end - 1
        if month_number == year_end:
            factor *= 1.6
        elif month_number == month_before:
            factor *= 1.3
    return factor


def dropoff_factor(start, t):
    """1.0 before the drop-off starts, then a straight-line fade to 0.3 over 6 months."""
    if start is None or t < start:
        return 1.0
    return max(0.3, 1 - 0.7 * (t - start) / 6)


def make_orders(customers):
    """Monthly order quantity for every customer, product and month."""
    rows = []
    for c in customers:
        for product in c["products"]:
            base = BASE_UNITS_A[c["customer_type"]] * PRODUCT_SCALE[product] * c["size"]
            for t, month in enumerate(MONTHS):
                growth = (1 + ANNUAL_GROWTH[c["country"]]) ** (t / 12)
                mean = (base * growth
                        * season_factor(c["country"], product, month)
                        * dropoff_factor(c["dropoff_start"], t))
                # Random swing this month (gamma, average 1), then a Poisson count around it.
                quantity = rng.poisson(mean * rng.gamma(shape=15, scale=1 / 15))
                if quantity == 0:
                    continue  # no order that month, so no row, as in SAP

                card_code = c["card_code"]
                dup = c["duplicate"]
                if dup is not None and product == dup["product"] and t >= dup["switch_month"]:
                    card_code = dup["card_code"]
                rows.append({"month": month, "card_code": card_code,
                             "product": product, "quantity": int(quantity)})
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# Output tables
# ---------------------------------------------------------------------------

def customer_master(customers):
    """The customer list as SAP B1 would hold it: duplicates look like real customers."""
    rows = []
    for c in customers:
        # Every customer buys Product A, so SPD usually set the record up first.
        rows.append({"card_code": c["card_code"], "card_name": c["card_name"],
                     "country": c["country"], "customer_type": c["customer_type"],
                     "requested_by": PRODUCT_OWNER["A"]})
    for c in customers:
        dup = c["duplicate"]
        if dup is not None:
            rows.append({"card_code": dup["card_code"], "card_name": dup["card_name"],
                         "country": c["country"], "customer_type": c["customer_type"],
                         "requested_by": dup["requested_by"]})
    return pd.DataFrame(rows).sort_values("card_code", ignore_index=True)


def answer_key(customers):
    """What we planted. Only for checking methods afterwards, never as an input."""
    rows = []
    for c in customers:
        dropoff = MONTHS[c["dropoff_start"]] if c["dropoff_start"] is not None else None
        rows.append({"card_code": c["card_code"], "true_customer_id": c["true_id"],
                     "duplicate_of": None, "duplicate_product": None,
                     "duplicate_from_month": None,
                     "cross_sell_gap": c["cross_sell_gap"], "dropoff_start": dropoff})
        dup = c["duplicate"]
        if dup is not None:
            rows.append({"card_code": dup["card_code"], "true_customer_id": c["true_id"],
                         "duplicate_of": c["card_code"], "duplicate_product": dup["product"],
                         "duplicate_from_month": MONTHS[dup["switch_month"]],
                         "cross_sell_gap": None, "dropoff_start": None})
    return pd.DataFrame(rows)


def main():
    customers = make_customers()
    plant_patterns(customers)
    master = customer_master(customers)
    orders = make_orders(customers)
    key = answer_key(customers)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    master.to_csv(OUT_DIR / "customers.csv", index=False)
    orders.to_csv(OUT_DIR / "orders.csv", index=False)
    key.to_csv(OUT_DIR / "answer_key.csv", index=False)

    print(f"Months: {MONTHS[0]} to {MONTHS[-1]} ({len(MONTHS)})")
    print(f"Customer records: {len(master)} ({len(customers)} real customers + "
          f"{len(master) - len(customers)} duplicates)")
    print(f"Order rows: {len(orders)}")
    print(f"Planted: {N_DUPLICATES} duplicates, {N_CROSS_SELL_GAPS} cross-sell gaps, "
          f"{N_DROPOFFS} drop-offs")

    # Quick check: units ordered in the last 12 months, by country and product.
    last_year = orders[orders["month"] >= MONTHS[-12]]
    with_country = last_year.merge(master[["card_code", "country"]], on="card_code")
    print("\nUnits ordered in the last 12 months:")
    print(with_country.pivot_table(index="country", columns="product",
                                   values="quantity", aggfunc="sum"))


if __name__ == "__main__":
    main()
