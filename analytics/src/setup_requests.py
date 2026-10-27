"""
Make synthetic MDM setup requests (new customer, vendor and item records), so
the regional view can show them separately from purchase orders.

SYNTHETIC DATA. Assumptions:
- Each country raises, per month, on average 3 new-customer, 1 new-vendor and
  2 new-item requests (Poisson counts).
- Today, approval takes about 18 days on average (the brief's example), varying
  from request to request (gamma distribution).
- Requests not approved by 30 Sep 2026 are still open.

Uses its own random seed, so the order data is not affected.
Run from the repo folder:  python analytics/src/setup_requests.py
"""

from pathlib import Path

import numpy as np
import pandas as pd

from make_synthetic_data import CUSTOMER_NAMES, MONTHS

rng = np.random.default_rng(seed=7)

OUT_FILE = Path(__file__).resolve().parent.parent / "data" / "synthetic" / "setup_requests.csv"
REQUESTS_PER_MONTH = {"Customer": 3, "Vendor": 1, "Item": 2}
MEAN_DAYS_TO_APPROVE = 18
DATA_END = pd.Timestamp("2026-09-30")


def main():
    rows = []
    for country in CUSTOMER_NAMES:
        for month in MONTHS:
            first_day = pd.Timestamp(month)
            for kind, rate in REQUESTS_PER_MONTH.items():
                for _ in range(rng.poisson(rate)):
                    submitted = first_day + pd.Timedelta(days=int(rng.integers(0, first_day.days_in_month)))
                    days = int(np.ceil(rng.gamma(shape=4, scale=MEAN_DAYS_TO_APPROVE / 4)))
                    approved = submitted + pd.Timedelta(days=days)
                    done = approved <= DATA_END
                    rows.append({"country": country, "type": kind, "submitted": submitted.date(),
                                 "approved": approved.date() if done else None,
                                 "days_to_approve": days if done else None})

    requests = pd.DataFrame(rows).sort_values("submitted", ignore_index=True)
    requests.insert(0, "request_id", [f"R{n:05d}" for n in range(1, len(requests) + 1)])
    requests.to_csv(OUT_FILE, index=False)
    print(f"{len(requests)} setup requests, {requests['approved'].isna().sum()} still open")


if __name__ == "__main__":
    main()
