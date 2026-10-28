"""
Stress test: does the calendar regression still win when the world is messier?

SYNTHETIC DATA: every dataset here is generated in memory. Nothing is real
Lives Group data, and nothing in data/ is changed (data/ is only read once,
to check that our copy of the generator matches the official dataset).

Why this exists: a teammate pointed out that the calendar regression may win
only because the planted world is too simple. It contains exactly the
patterns that regression is built to find. So we build harder worlds and
re-run the same backtest (src/backtest.py) on each.

The scenarios were fixed BEFORE looking at any results ("pre-registered"),
so their strengths cannot be tuned afterwards to flatter any model:

    S0 Baseline              the normal generator, with fresh seeds (sanity check)
    S1 Persistent demand     a customer's busy or quiet spell carries on for months
    S2 Changing calendar     holiday dips and budget year-end spikes change size each year
    S3 Unknown seasonality   a yearly wave that no calendar flag explains
    S4 Shocks and breaks     surprise outbreaks, and a new contract nobody announced
    S5 Messy world           S1 + S2 + S3 + S4 together

Each scenario runs with 3 seeds, i.e. 3 different random worlds.

Outputs, written to results/:
    stress_test_summary.csv  one row per scenario and model, averaged over the seeds
    stress_test_detail.csv   one row per scenario, seed and model

Run from the repo folder:  python src/stress_test.py   (roughly 30 minutes)
"""

import time
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.special import polygamma

import backtest
import make_synthetic_data as gen
from make_synthetic_data import (ANNUAL_GROWTH, BASE_UNITS_A, FISCAL_YEAR_END, HOLIDAYS,
                                 MONTHS, PRODUCT_SCALE, RAINY_MONTHS, dropoff_factor,
                                 season_factor)

RESULTS_DIR = Path(__file__).resolve().parent.parent / "results"

SEEDS = [101, 202, 303]
CHRONOS_SEEDS = SEEDS  # run the two Chronos-2 models on every seed (slowest part)
COUNTRIES = list(ANNUAL_GROWTH)

# Which complications each scenario switches on.
SCENARIOS = {
    "S0 Baseline": [],
    "S1 Persistent demand": ["persistent"],
    "S2 Changing calendar": ["changing calendar"],
    "S3 Unknown seasonality": ["hidden wave"],
    "S4 Shocks and breaks": ["shocks"],
    "S5 Messy world": ["persistent", "changing calendar", "hidden wave", "shocks"],
}

# ---------------------------------------------------------------------------
# Scenario settings (fixed before seeing any results)
# ---------------------------------------------------------------------------

# S1 Persistent demand. The baseline multiplies each month's demand by a fresh
# random "swing" (gamma, average 1). In S1 the swing remembers last month:
#     log swing this month = 0.6 x log swing last month + new random shock
# (an AR(1) process, "auto-regressive of order 1"). Its spread is set to match
# the baseline swing: the variance of log Gamma(15, 1/15) is trigamma(15).
RHO = 0.6
SWING_VARIANCE = float(polygamma(1, 15))  # trigamma(15), about 0.069

# S2 Changing calendar. Holiday dips are scaled by year (a 20% dip becomes
# 10% in 2024, 20% in 2025, 30% in 2026). Budget year-end uplift for Product B
# grows with each fiscal year-end in the window: (last month, month before).
HOLIDAY_DIP_SCALE = {"2024": 0.5, "2025": 1.0, "2026": 1.5}
BUDGET_UPLIFT = [(0.30, 0.15), (0.60, 0.30), (0.90, 0.45)]  # 1st, 2nd, 3rd year-end

# S3 Unknown seasonality: a +/-12% yearly wave, peaking at a different month
# in each country, that none of the models' calendar flags describe.
WAVE_SIZE = 0.12

# S4 Shocks and breaks: one 2-month outbreak a year (Product A x 1.4) in a
# random country, and one country whose whole demand steps up x 1.2 for good
# from a random month in 2025 (a new contract).
OUTBREAK_YEARS = ["2024", "2025", "2026"]
OUTBREAK_SIZE = 1.4
BREAK_SIZE = 1.2
BREAK_YEAR = "2025"


# ---------------------------------------------------------------------------
# Random draws for one seed
# ---------------------------------------------------------------------------

def next_month(month):
    """'2025-12' -> '2026-01'."""
    return str(pd.Period(month, freq="M") + 1)


def make_customers(seed):
    """The generator's 50 customers and planted patterns, for one seed.
    The generator keeps its random-number source in a module variable called
    rng, so we put in a fresh one with our seed before calling its functions."""
    gen.rng = np.random.default_rng(seed)
    customers = gen.make_customers()
    gen.plant_patterns(customers)
    return customers


def draw_surprises(seed):
    """The random parts of S3 and S4. They come from their own random source,
    so they are the same in S3, S4 and S5 for a given seed, and drawing them
    does not change the customers or the monthly noise."""
    rng = np.random.default_rng(seed + 1)
    phases = {country: int(rng.integers(1, 13)) for country in COUNTRIES}  # wave peak month
    outbreaks = []
    for year in OUTBREAK_YEARS:
        country = str(rng.choice(COUNTRIES))
        # first month of the outbreak: the next month must be in the same year and in the data
        starts = [m for m in MONTHS[:-1] if m[:4] == year and next_month(m)[:4] == year]
        start = str(rng.choice(starts))
        outbreaks.append({"country": country, "months": [start, next_month(start)]})
    new_contract = {"country": str(rng.choice(COUNTRIES)),
                    "from": str(rng.choice([m for m in MONTHS if m[:4] == BREAK_YEAR]))}
    return {"phases": phases, "outbreaks": outbreaks, "new_contract": new_contract}


# ---------------------------------------------------------------------------
# The complications
# ---------------------------------------------------------------------------

def changing_season_factor(country, product, month):
    """S2: same calendar dates as the baseline, but effect sizes change by year."""
    month_number = int(month[5:])
    factor = 1.0
    for holiday_months, effect in HOLIDAYS[country]:
        if month in holiday_months:
            dip = 1 - effect                               # e.g. 0.25 for Tet
            factor *= 1 - dip * HOLIDAY_DIP_SCALE[month[:4]]
    if product == "A" and month_number in RAINY_MONTHS[country]:
        factor *= 1.10                                     # unchanged
    if product == "B":
        year_ends = [m for m in MONTHS if int(m[5:]) == FISCAL_YEAR_END[country]]  # 3 in the window
        if month in year_ends:
            factor *= 1 + BUDGET_UPLIFT[year_ends.index(month)][0]
        elif next_month(month) in year_ends:               # the month before a year-end
            factor *= 1 + BUDGET_UPLIFT[year_ends.index(next_month(month))][1]
    return factor


def hidden_wave(country, month, phases):
    """S3: 1 + 0.12 x sin(2 pi (month number - phase) / 12)."""
    month_number = int(month[5:])
    return 1 + WAVE_SIZE * np.sin(2 * np.pi * (month_number - phases[country]) / 12)


def shock_factor(country, product, month, surprises):
    """S4: outbreaks lift Product A for 2 months; the new contract lifts everything after it starts."""
    factor = 1.0
    for outbreak in surprises["outbreaks"]:
        if product == "A" and country == outbreak["country"] and month in outbreak["months"]:
            factor *= OUTBREAK_SIZE
    contract = surprises["new_contract"]
    if country == contract["country"] and month >= contract["from"]:  # 'YYYY-MM' sorts by date
        factor *= BREAK_SIZE
    return factor


def expected_orders(customer, product, t, month, complications, surprises):
    """Average units for one customer, product and month, before the random swing.
    With no complications this is exactly the generator's formula."""
    country = customer["country"]
    base = BASE_UNITS_A[customer["customer_type"]] * PRODUCT_SCALE[product] * customer["size"]
    growth = (1 + ANNUAL_GROWTH[country]) ** (t / 12)
    if "changing calendar" in complications:
        calendar = changing_season_factor(country, product, month)
    else:
        calendar = season_factor(country, product, month)
    mean = base * growth * calendar * dropoff_factor(customer["dropoff_start"], t)
    if "hidden wave" in complications:
        mean *= hidden_wave(country, month, surprises["phases"])
    if "shocks" in complications:
        mean *= shock_factor(country, product, month, surprises)
    return mean


def next_log_swing(previous, rng):
    """S1: one step of the AR(1) log swing. The first month starts from the
    long-run spread; each later month keeps 60% of last month's swing."""
    if previous is None:
        return rng.normal(0, np.sqrt(SWING_VARIANCE))
    return RHO * previous + rng.normal(0, np.sqrt(SWING_VARIANCE * (1 - RHO ** 2)))


# ---------------------------------------------------------------------------
# One world -> 15 monthly series
# ---------------------------------------------------------------------------

def make_series(scenario, seed):
    """Monthly units ordered: one row per month, one column per (country, product),
    the same shape as backtest.load_series()."""
    complications = SCENARIOS[scenario]
    customers = make_customers(seed)
    surprises = draw_surprises(seed)
    noise = gen.rng  # carry on with the generator's random source, as make_orders does
    rows = []
    for c in customers:
        for product in c["products"]:
            log_swing = None
            for t, month in enumerate(MONTHS):
                mean = expected_orders(c, product, t, month, complications, surprises)
                if "persistent" in complications:
                    log_swing = next_log_swing(log_swing, noise)
                    swing = np.exp(log_swing - SWING_VARIANCE / 2)  # average swing stays 1
                else:
                    swing = noise.gamma(shape=15, scale=1 / 15)     # baseline: fresh each month
                rows.append({"month": month, "country": c["country"], "product": product,
                             "quantity": int(noise.poisson(mean * swing))})
    orders = pd.DataFrame(rows)
    table = orders.pivot_table(index="month", columns=["country", "product"],
                               values="quantity", aggfunc="sum", fill_value=0)
    return table.sort_index()


def check_against_official_data():
    """With the generator's own seed (2026), our S0 must equal data/synthetic exactly.
    This proves the copy of the generator in this file is faithful."""
    ours = make_series("S0 Baseline", seed=2026)
    official = backtest.load_series()
    same = (ours.index.equals(official.index) and ours.columns.equals(official.columns)
            and (ours.to_numpy() == official.to_numpy()).all())
    print(f"Check: S0 with seed 2026 reproduces data/synthetic exactly: {same}")
    if not same:
        raise SystemExit("Our generator copy does not match the official one; stopping.")


# ---------------------------------------------------------------------------
# Backtest and scoring (reusing src/backtest.py)
# ---------------------------------------------------------------------------

def run_backtest(series, with_chronos):
    """backtest.run_backtest, optionally without the two Chronos-2 models.
    run_backtest loops over backtest.MODELS, so we swap that list for this call."""
    all_models = backtest.MODELS
    if not with_chronos:
        backtest.MODELS = {name: model for name, model in all_models.items()
                           if not name.startswith("Chronos")}
    try:
        return backtest.run_backtest(series)
    finally:
        backtest.MODELS = all_models


def score(results):
    """The main backtest's scoreboard, with MAPE kept unrounded so that
    averaging over seeds does not add rounding error."""
    table = backtest.summarise(results)
    miss = (results["actual"] - results["forecast"]).abs()
    table["MAPE %"] = (miss / results["actual"]).groupby(results["model"]).mean() * 100
    return table


def summarise_scenarios(detail):
    """Average each model's scores over the seeds, per scenario."""
    summary = detail.groupby(["scenario", "model"]).agg(
        mape_mean=("MAPE %", "mean"), mape_min=("MAPE %", "min"), mape_max=("MAPE %", "max"),
        mae_a=("MAE A (units)", "mean"), mae_b=("MAE B (units)", "mean"),
        mae_c=("MAE C (units)", "mean"), beats_12mo=("Beats 12-mo avg (of 15)", "mean"),
        coverage=("80% range coverage %", "mean"), seeds=("seed", "count")).reset_index()
    summary["rank"] = summary.groupby("scenario")["mape_mean"].rank().astype(int)
    summary = summary.rename(columns={
        "mape_mean": "MAPE % (mean of seeds)", "mape_min": "MAPE % (lowest seed)",
        "mape_max": "MAPE % (highest seed)", "mae_a": "MAE A (units)", "mae_b": "MAE B (units)",
        "mae_c": "MAE C (units)", "beats_12mo": "Beats 12-mo avg (of 15)",
        "coverage": "80% range coverage %", "seeds": "Seeds"})
    return summary.sort_values(["scenario", "rank"]).round(2)


# ---------------------------------------------------------------------------
# Printing
# ---------------------------------------------------------------------------

def print_surprises():
    """What S3 and S4 planted for each seed, so the results can be traced back."""
    for seed in SEEDS:
        s = draw_surprises(seed)
        outbreaks = "; ".join(f"{o['country']} {o['months'][0]}+{o['months'][1]}"
                              for o in s["outbreaks"])
        print(f"Seed {seed}: wave phase per country {s['phases']} "
              f"(a wave peaks 3 months after its phase)")
        print(f"          outbreaks: {outbreaks}")
        print(f"          new contract: {s['new_contract']['country']} from "
              f"{s['new_contract']['from']}")


def print_head_to_head(detail):
    """Per scenario: does the calendar regression beat the two averages, and who wins?"""
    mape = detail.pivot_table(index=["scenario", "seed"], columns="model", values="MAPE %")
    for scenario, block in mape.groupby(level="scenario"):
        reg = block["Calendar regression"]
        beats6 = (reg < block["6-month average (current method)"]).sum()
        beats12 = (reg < block["12-month average"]).sum()
        winners = block.idxmin(axis=1).tolist()
        print(f"{scenario}: regression beats 6-mo avg in {beats6}/3 seeds, "
              f"12-mo avg in {beats12}/3; winner per seed: {winners}")


def main():
    start = time.time()
    check_against_official_data()
    print_surprises()

    detail = []
    for scenario in SCENARIOS:
        for seed in SEEDS:
            clock = time.time()
            series = make_series(scenario, seed)
            table = score(run_backtest(series, with_chronos=seed in CHRONOS_SEEDS))
            detail.append(table.reset_index().assign(scenario=scenario, seed=seed))
            print(f"{scenario}, seed {seed}: best = {table['MAPE %'].idxmin()} "
                  f"({table['MAPE %'].min():.1f}%), {time.time() - clock:.0f} s", flush=True)

    detail = pd.concat(detail, ignore_index=True)
    first = ["scenario", "seed", "model"]
    detail = detail[first + [col for col in detail.columns if col not in first]].round(2)
    summary = summarise_scenarios(detail)
    RESULTS_DIR.mkdir(exist_ok=True)
    detail.to_csv(RESULTS_DIR / "stress_test_detail.csv", index=False)
    summary.to_csv(RESULTS_DIR / "stress_test_summary.csv", index=False)

    wide = summary.pivot(index="model", columns="scenario", values="MAPE % (mean of seeds)")
    print("\nMAPE %, mean of 3 seeds (lower is better):\n")
    print(wide.sort_values("S0 Baseline").round(1).to_string())
    spread = summary.pivot(index="model", columns="scenario", values="MAPE % (highest seed)") \
        - summary.pivot(index="model", columns="scenario", values="MAPE % (lowest seed)")
    print("\nSpread across seeds (highest minus lowest MAPE %):\n")
    print(spread.reindex(wide.sort_values("S0 Baseline").index).round(1).to_string())
    print()
    print_head_to_head(detail)
    s5 = summary[summary["scenario"] == "S5 Messy world"].head(3)
    print("\nS5 top 3 models:\n")
    print(s5[["model", "MAPE % (mean of seeds)", "MAE A (units)", "MAE B (units)",
              "MAE C (units)"]].to_string(index=False))
    print(f"\nTotal runtime: {(time.time() - start) / 60:.1f} minutes")


if __name__ == "__main__":
    main()
