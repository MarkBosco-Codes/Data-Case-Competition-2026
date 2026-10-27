"""
Stress test v2: new Lives Group-specific patterns, three new forecast inputs,
and four customer-signal checks.

SYNTHETIC DATA: every world here is generated in memory. Nothing is real
Lives Group data, and nothing in data/ or in the earlier results is changed
(data/ is only read once, to check that our generator copy is faithful).

Everything below was fixed BEFORE looking at any results ("pre-registered"),
so no setting was tuned afterwards to flatter a model. Each world is the
normal generator (S0) plus one or more patterns taken from the brief:

    S0 Baseline         the normal generator, re-run so new models are compared fairly
    S6 Outbreaks + stock-ups
        Dengue/flu outbreaks in Southeast Asia raise demand for Lives Group's
        in-vitro diagnostic reagents (Product A). Separately, customers sometimes
        "stock up": one big order, then two small ones. That breaks the brief's
        steady "monthly purchase orders" pattern.
    S7 Equipment drives reagents
        A cross-entity link. QTS sells the analyser (Product B, equipment), but the
        reagent and lab-solution demand it creates shows up at SPD (A) and QTG (C).
        Business units working in silos would miss this.
    S8 New customer ramp-up
        The brief's MDM delay. A new customer cannot buy anything until its record
        clears today's ~18-day email approval (Amy's example), so its first
        orders start only after approval, and then build up gradually.
    S9 All new patterns  S6 + S7 + S8 together
    S10 Contaminated history
        The S0 world, but the order history the models learn from also contains
        mislabelled enquiries (the brief: commercial teams separate real orders from
        enquiries by hand). Models are still scored against the true orders.

New forecasting models (added to the existing ones in src/backtest.py):
    Calendar + momentum         calendar regression + how far last month sat above
                                or below its 12-month average
    Calendar + equipment lead   calendar regression + recent analyser (B) sales in
                                the same country, for A and C forecasts
    Calendar + pipeline         calendar regression + number of newly approved
                                customers still ramping up (known to an MDM system)

Customer-signal checks (at the last month, Sep 2026):
    1. Drop-off alerts: today's rule vs a stock-up-aware rule
    2. Outbreak early warning from "breadth" (how many customers order unusually much)
    3. Equipment lead: does recent B predict next month's A?
    4. Business impact: how much sooner do new customers order with a 3-day setup?

Outputs, written to results/:
    stress_test_v2_summary.csv   one row per world and model, averaged over the seeds
    stress_test_v2_detail.csv    one row per world, seed and model
    signal_check_v2.csv          one row per world, seed and signal measure

Run from the repo folder:  python src/stress_test_v2.py   (roughly 30-40 minutes)
"""

import math
import time
from functools import partial
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm

import backtest
import stress_test
from backtest import FLAGS
from make_synthetic_data import MONTHS
from stress_test import COUNTRIES, SEEDS

RESULTS_DIR = Path(__file__).resolve().parent.parent / "results"

CHRONOS_SEEDS = SEEDS      # run the two Chronos-2 models on every seed (slowest part)
RUN_S10 = True             # the optional contaminated-history world
LAST_T = len(MONTHS) - 1   # index of the last month, Sep 2026 (months are numbered 0-35)
MONTH_INDEX = {month: t for t, month in enumerate(MONTHS)}

# Which patterns each world switches on (S10 is handled separately, see main).
WORLDS = {
    "S0 Baseline": [],
    "S6 Outbreaks + stock-ups": ["outbreaks"],
    "S7 Equipment drives reagents": ["installs"],
    "S8 New customer ramp-up": ["new customers"],
    "S9 All new patterns": ["outbreaks", "installs", "new customers"],
}
S10 = "S10 Contaminated history"

# ---------------------------------------------------------------------------
# Pattern settings (fixed before seeing any results)
# ---------------------------------------------------------------------------

# S6 outbreaks: one per calendar year, in a random country and start month.
# 80% of that country's customers order more Product A for 4 months.
OUTBREAK_YEARS = ["2024", "2025", "2026"]
OUTBREAK_STEPS = [1.2, 1.4, 1.6, 1.3]   # demand multiplier in outbreak months 1-4
OUTBREAK_SHARE = 0.8

# S6 stock-ups: a 5% chance each month; that month x 2.5, the next 2 months x 0.3.
STOCKUP_CHANCE = 0.05
STOCKUP_STEPS = [2.5, 0.3, 0.3]

# S7 analyser installations: a 3% chance each month for each customer buying B.
INSTALL_CHANCE = 0.03
INSTALL_B_SPIKE = 4.0     # the month the analyser is bought
INSTALL_LIFT = 1.25       # A and C demand from the next month on, for good

# S8 new customers: from month 6 on, each country gets a new customer with
# probability 0.25 per month. Type mix 3 hospitals : 2 medical centres :
# 2 laboratories : 3 clinics, as among the existing customers.
NEW_CUSTOMER_CHANCE = 0.25
NEW_FROM_T = 6
TYPE_MIX = {"Hospital": 0.3, "Medical Centre": 0.2, "Laboratory": 0.2, "Clinic": 0.3}
APPROVAL_SHAPE = 4         # approval time in days = ceil(Gamma(shape 4, mean 18))
APPROVAL_MEAN_TODAY = 18   # today's email process (the brief's ~18 days)
APPROVAL_MEAN_FAST = 3     # signal check 4: a fast digital process
RAMP = [0.3, 0.5, 0.75]    # share of normal orders in a new customer's first 3 ordering months

# S10: mislabelled enquiries add about 6% extra units to the training history.
CONTAMINATION_RATE = 0.06


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def month_label(t):
    """Month number -> 'YYYY-MM'. Works past Sep 2026 too (t = 36 is '2026-10')."""
    return str(pd.Period(MONTHS[0], freq="M") + t)


def month_number_of(date):
    """A calendar date -> its month number (Oct 2023 = 0)."""
    return (date.year - 2023) * 12 + (date.month - 10)


def ramp_factor(first_order_t, t):
    """New customers: 0 before their first order, then 30%, 50%, 75%, then 100%."""
    if t < first_order_t:
        return 0.0
    if t - first_order_t < len(RAMP):
        return RAMP[t - first_order_t]
    return 1.0


def normal_level(customer, product, t):
    """A customer's average monthly units with no new pattern (the generator's formula)."""
    return stress_test.expected_orders(customer, product, t, month_label(t), [], None)


# ---------------------------------------------------------------------------
# Drawing the random events. Each pattern has its own random source, so the
# S6 events are identical in S6 and S9, and so on. Existing customers are
# always handled before new ones, so adding new customers in S9 does not
# change what happens to existing customers.
# ---------------------------------------------------------------------------

def existing_customers(seed):
    """The generator's 50 customers (with its planted drop-offs), plus three
    labels this file needs."""
    customers = stress_test.make_customers(seed)
    for c in customers:
        c["id"] = c["true_id"]
        c["new"] = False
        c["first_order_t"] = 0
    return customers


def draw_new_customers(seed):
    """S8: new customers, their MDM setup request, and when they can start ordering."""
    rng = np.random.default_rng([seed, 8])
    newcomers = []
    for country in COUNTRIES:
        for t in range(NEW_FROM_T, len(MONTHS)):
            if rng.random() >= NEW_CUSTOMER_CHANCE:
                continue
            kind = str(rng.choice(list(TYPE_MIX), p=list(TYPE_MIX.values())))
            size = rng.lognormal(mean=0, sigma=0.5)
            days_in_month = pd.Period(MONTHS[t], freq="M").days_in_month
            submitted = pd.Timestamp(MONTHS[t] + "-01") + pd.Timedelta(
                days=int(rng.integers(0, days_in_month)))
            # One draw of "how hard is this request"; the fast process takes the
            # same request 3/18 as long, so it is never slower than today.
            effort = rng.gamma(APPROVAL_SHAPE, APPROVAL_MEAN_TODAY / APPROVAL_SHAPE)
            days_today = math.ceil(effort)
            days_fast = math.ceil(effort * APPROVAL_MEAN_FAST / APPROVAL_MEAN_TODAY)
            approval_t = month_number_of(submitted + pd.Timedelta(days=days_today))
            fast_approval_t = month_number_of(submitted + pd.Timedelta(days=days_fast))
            newcomers.append({
                "id": f"N{len(newcomers) + 1:03d}", "new": True, "country": country,
                "customer_type": kind, "products": list(stress_test.gen.PRODUCTS_BY_TYPE[kind]),
                "size": size, "dropoff_start": None, "arrival_t": t,
                "approval_days": days_today, "fast_approval_days": days_fast,
                "approval_t": approval_t, "first_order_t": approval_t + 1,
                "fast_first_order_t": fast_approval_t + 1,
            })
    return newcomers


def draw_outbreaks_and_stockups(customers, seed):
    """S6: three outbreaks (one per year) and every customer's stock-up months."""
    rng = np.random.default_rng([seed, 6])
    outbreaks = []
    for year in OUTBREAK_YEARS:
        country = str(rng.choice(COUNTRIES))
        # the 4-month outbreak must end by Sep 2026
        starts = [t for t, m in enumerate(MONTHS) if m[:4] == year and t + 3 <= LAST_T]
        start = int(rng.choice(starts))
        local = [c["id"] for c in customers if c["country"] == country and not c["new"]]
        hit = rng.choice(local, size=round(OUTBREAK_SHARE * len(local)), replace=False)
        outbreaks.append({"country": country, "start": start, "hit": {str(i) for i in hit}})

    stockups = {}
    for c in customers:  # existing customers first, then new ones
        if c["new"]:  # a new customer is hit by each outbreak in its country with 80% chance
            for o in outbreaks:
                if o["country"] == c["country"] and rng.random() < OUTBREAK_SHARE:
                    o["hit"].add(c["id"])
        blocked = {o["start"] + k for o in outbreaks if o["country"] == c["country"]
                   for k in range(len(OUTBREAK_STEPS))}
        for product in c["products"]:
            stockups[(c["id"], product)] = draw_stockup_starts(c["first_order_t"], blocked, rng)
    return outbreaks, stockups


def draw_stockup_starts(first_t, blocked, rng):
    """Months in which one customer-product stocks up. A stock-up never overlaps
    another one, and none of its 3 months falls in an outbreak in that country."""
    starts = []
    t = first_t
    while t <= LAST_T:
        if {t, t + 1, t + 2} & blocked:
            t += 1
        elif rng.random() < STOCKUP_CHANCE:
            starts.append(t)
            t += len(STOCKUP_STEPS)
        else:
            t += 1
    return starts


def draw_installs(customers, seed):
    """S7: the month each B-buying customer installs a new analyser (at most once)."""
    rng = np.random.default_rng([seed, 7])
    installs = {}
    for c in customers:
        if "B" not in c["products"]:
            continue
        for t in range(c["first_order_t"], LAST_T + 1):
            if rng.random() < INSTALL_CHANCE:
                installs[c["id"]] = t
                break
    return installs


# ---------------------------------------------------------------------------
# One world -> customer-level orders and 15 monthly series
# ---------------------------------------------------------------------------

def pattern_factor(c, product, t, events):
    """Multiply the normal demand by every new pattern active in this month."""
    factor = 1.0
    for o in events["outbreaks"]:                     # S6 outbreaks (Product A only)
        k = t - o["start"]
        if product == "A" and c["id"] in o["hit"] and 0 <= k < len(OUTBREAK_STEPS):
            factor *= OUTBREAK_STEPS[k]
    for start in events["stockups"].get((c["id"], product), []):   # S6 stock-ups
        if 0 <= t - start < len(STOCKUP_STEPS):
            factor *= STOCKUP_STEPS[t - start]
    install = events["installs"].get(c["id"])         # S7 analyser installation
    if install is not None:
        if product == "B" and t == install:
            factor *= INSTALL_B_SPIKE
        if product in ("A", "C") and t > install:
            factor *= INSTALL_LIFT
    if c["new"]:                                      # S8 ramp-up after approval
        factor *= ramp_factor(c["first_order_t"], t)
    return factor


def make_world(world, seed):
    """Generate one world. With no patterns this is exactly the generator."""
    patterns = WORLDS[world]
    customers = existing_customers(seed)
    noise = stress_test.gen.rng  # carry on with the generator's own random source
    if "new customers" in patterns:
        customers += draw_new_customers(seed)
    events = {"outbreaks": [], "stockups": {}, "installs": {}}
    if "outbreaks" in patterns:
        events["outbreaks"], events["stockups"] = draw_outbreaks_and_stockups(customers, seed)
    if "installs" in patterns:
        events["installs"] = draw_installs(customers, seed)

    rows = []
    for c in customers:
        for product in c["products"]:
            for t, month in enumerate(MONTHS):
                mean = normal_level(c, product, t) * pattern_factor(c, product, t, events)
                swing = noise.gamma(shape=15, scale=1 / 15)  # as in the generator
                rows.append({"customer": c["id"], "country": c["country"], "product": product,
                             "t": t, "month": month, "mean": mean,
                             "quantity": int(noise.poisson(mean * swing))})
    orders = pd.DataFrame(rows)
    return {"world": world, "seed": seed, "customers": customers, "events": events,
            "orders": orders, "series": to_series(orders, "quantity"),
            "true_mean": to_series(orders, "mean"),
            "pipeline": [(c["country"], c["approval_t"]) for c in customers if c["new"]]}


def to_series(orders, column):
    """Customer rows -> one row per month, one column per (country, product)."""
    table = orders.pivot_table(index="month", columns=["country", "product"],
                               values=column, aggfunc="sum", fill_value=0)
    return table.sort_index()


def check_against_official_data():
    """With the generator's own seed (2026), our S0 must equal data/synthetic exactly."""
    ours = make_world("S0 Baseline", 2026)["series"]
    official = backtest.load_series()
    same = (ours.index.equals(official.index) and ours.columns.equals(official.columns)
            and (ours.to_numpy() == official.to_numpy()).all())
    print(f"Check: S0 with seed 2026 reproduces data/synthetic exactly: {same}")
    if not same:
        raise SystemExit("Our generator copy does not match the official one; stopping.")


# ---------------------------------------------------------------------------
# New models: the calendar regression plus one extra input each
# ---------------------------------------------------------------------------

def regression_forecast(history, upcoming, inputs, train, future):
    """Pooled OLS of log(orders / last-12-month average) on `inputs`, then
    forecast = latest 12-month average x exp(predicted log ratio).
    With inputs = FLAGS this is exactly backtest.calendar_regression."""
    fit = sm.OLS(history["log_ratio"], sm.add_constant(history[inputs], has_constant="add")).fit()
    log_ratio = fit.predict(sm.add_constant(upcoming[inputs], has_constant="add"))
    return backtest.to_table(upcoming, upcoming["level"] * np.exp(log_ratio), future, train.columns)


def calendar_plus_momentum(train, future):
    """Extra input: last month's log ratio of the same series. If a series ran
    hot last month (an outbreak building up), does it stay hot? For forecasts
    2-3 months ahead the latest known value is reused."""
    history = backtest.ratio_rows(train)
    by_series = history.groupby(["country", "product"])["log_ratio"]
    latest = by_series.last()                       # the cut-off month's log ratio
    history["momentum"] = by_series.shift(1)        # the month before each row
    history = history.dropna(subset=["momentum"])   # the first row of each series has none
    upcoming = backtest.future_rows(train, future)
    upcoming["momentum"] = [latest[key] for key in zip(upcoming["country"], upcoming["product"])]
    return regression_forecast(history, upcoming, FLAGS + ["momentum"], train, future)


def b_lead(b_units, origin):
    """B units in the 3 months up to `origin`, compared with 3 x B's average
    month over the 12 months up to `origin`, as a log ratio (0 = normal)."""
    recent = b_units[origin - 2:origin + 1].sum()
    usual = b_units[origin - 11:origin + 1].mean()
    return np.log(recent / (3 * usual))


def calendar_plus_equipment(train, future):
    """Extra input for A and C rows (0 for B rows): recent analyser (B) sales in
    the same country. Each training row uses the 3 months before its month;
    forecasts use the 3 months up to the cut-off."""
    b_units = {country: train[(country, "B")].to_numpy(dtype=float) for country in COUNTRIES}
    position = {month: t for t, month in enumerate(train.index)}
    history = backtest.ratio_rows(train)
    history["equipment_lead"] = [
        0.0 if product == "B" else b_lead(b_units[country], position[month] - 1)
        for country, product, month in zip(history["country"], history["product"], history["month"])]
    upcoming = backtest.future_rows(train, future)
    cutoff = len(train) - 1
    upcoming["equipment_lead"] = [0.0 if product == "B" else b_lead(b_units[country], cutoff)
                                  for country, product in zip(upcoming["country"], upcoming["product"])]
    return regression_forecast(history, upcoming, FLAGS + ["equipment_lead"], train, future)


def pipeline_count(pipeline, country, t, cutoff):
    """New customers in `country` approved in the 3 months before month t (so
    still ramping up in month t), counting only approvals known by the cut-off."""
    return sum(1 for where, approved in pipeline
               if where == country and t - 3 <= approved <= t - 1 and approved <= cutoff)


def calendar_plus_pipeline(train, future, pipeline):
    """Extra input: how many newly approved customers are still ramping up in
    that country. Only an MDM system knows this. In worlds without new
    customers the count is always 0, so the forecast equals the plain regression."""
    cutoff = len(train) - 1
    history = backtest.ratio_rows(train)
    history["pipeline"] = [pipeline_count(pipeline, country, MONTH_INDEX[month], cutoff)
                           for country, month in zip(history["country"], history["month"])]
    upcoming = backtest.future_rows(train, future)
    upcoming["pipeline"] = [pipeline_count(pipeline, country, MONTH_INDEX[month], cutoff)
                            for country, month in zip(upcoming["country"], upcoming["month"])]
    return regression_forecast(history, upcoming, FLAGS + ["pipeline"], train, future)


def model_set(world, with_chronos):
    """All existing models from backtest.py plus the three new ones."""
    models = {name: model for name, model in backtest.MODELS.items()
              if with_chronos or not name.startswith("Chronos")}
    models["Calendar + momentum"] = calendar_plus_momentum
    models["Calendar + equipment lead"] = calendar_plus_equipment
    # partial() fills in this world's pipeline record in advance
    models["Calendar + pipeline"] = partial(calendar_plus_pipeline, pipeline=world["pipeline"])
    return models


# ---------------------------------------------------------------------------
# Backtest: same rolling cut-offs as src/backtest.py, but the history the
# models learn from can differ from the actual orders they are scored on (S10)
# ---------------------------------------------------------------------------

def run_backtest(history, actuals, models):
    """Forecast from every cut-off with every model. One row per forecast."""
    months = list(actuals.index)
    first = months.index(backtest.FIRST_CUTOFF)
    rows = []
    for cut in range(first, len(months) - 1):
        train = history.iloc[:cut + 1]                                  # only the past
        future = months[cut + 1:cut + 1 + backtest.MAX_HORIZON]         # months to forecast
        for name, model in models.items():
            forecast = model(train, future)
            for horizon, month in enumerate(future, start=1):
                for country, product in actuals.columns:
                    rows.append({"cutoff": months[cut], "horizon": horizon, "month": month,
                                 "country": country, "product": product, "model": name,
                                 "forecast": forecast.loc[month, (country, product)],
                                 "actual": actuals.loc[month, (country, product)]})
    return backtest.add_ensemble(pd.DataFrame(rows))  # the same 4-model average as before


def contaminated_history(world, seed):
    """S10: each country-product-month gains Poisson(6% of its true mean) extra
    units: enquiries wrongly counted as orders."""
    rng = np.random.default_rng([seed, 10])
    extra = rng.poisson(CONTAMINATION_RATE * world["true_mean"].to_numpy())
    return world["series"] + extra


# ---------------------------------------------------------------------------
# Signal checks (customer level, standing at Sep 2026)
# ---------------------------------------------------------------------------

def signal_row(world, check, measure, value, note=""):
    return {"scenario": world["world"], "seed": world["seed"], "check": check,
            "measure": measure, "value": value, "note": note}


def units_table(world, product=None):
    """One row per customer-product, one column per month number."""
    orders = world["orders"]
    if product is not None:
        orders = orders[orders["product"] == product]
    return orders.pivot_table(index=["customer", "product"], columns="t",
                              values="quantity", aggfunc="sum", fill_value=0)


def check_dropoffs(world):
    """1. Current rule: average of the last 3 months < 50% of the average of
    the 12 months before. Stock-up-aware rule: also, the last 6 months' total
    < 70% of 6 x that same 12-month average (a stock-up's big month is in there)."""
    table = units_table(world)
    usual = table[list(range(LAST_T - 14, LAST_T - 2))].mean(axis=1)  # 12 months before the last 3
    last3 = table[list(range(LAST_T - 2, LAST_T + 1))].mean(axis=1)
    last6 = table[list(range(LAST_T - 5, LAST_T + 1))].sum(axis=1)
    current = (usual > 0) & (last3 < 0.5 * usual)
    rules = {"Current rule": current, "Stock-up-aware rule": current & (last6 < 0.7 * 6 * usual)}

    fading = {c["id"] for c in world["customers"] if c["dropoff_start"] is not None}
    stocked_up = {key for key, starts in world["events"]["stockups"].items()
                  if any(start > LAST_T - 6 for start in starts)}   # a stock-up in the last 6 months
    rows = [signal_row(world, "1 Drop-off alerts", "Genuinely fading customers (planted)", len(fading))]
    for rule, alert in rules.items():
        flagged = list(table.index[alert])
        genuine = [key for key in flagged if key[0] in fading]
        false_stockup = [key for key in flagged if key[0] not in fading and key in stocked_up]
        other = len(flagged) - len(genuine) - len(false_stockup)
        caught = len({key[0] for key in genuine})
        rows += [
            signal_row(world, "1 Drop-off alerts", f"{rule}: alerts raised", len(flagged),
                       "one alert = one customer-product"),
            signal_row(world, "1 Drop-off alerts", f"{rule}: false, stock-up in last 6 months",
                       len(false_stockup)),
            signal_row(world, "1 Drop-off alerts", f"{rule}: false, other (noise)", other),
            signal_row(world, "1 Drop-off alerts", f"{rule}: fading customers caught", caught,
                       f"of {len(fading)}"),
        ]
    return rows


def outbreak_breadth(world):
    """2. For each country and month: the share of customers whose Product A
    order is above 1.2 x their own average of the 12 months before. Only
    customers with A orders in all of those 12 months count (others have no
    reliable 'own average', e.g. new customers still ramping up)."""
    a_units = units_table(world, "A").droplevel("product")
    country_of = world["orders"].groupby("customer")["country"].first()
    rows = []
    for country, block in a_units.groupby(country_of):
        for t in range(12, LAST_T + 1):
            past = block[list(range(t - 12, t))]
            eligible = (past > 0).all(axis=1)
            above = block[t] > 1.2 * past.mean(axis=1)
            breadth = above[eligible].mean() if eligible.any() else 0.0
            rows.append({"country": country, "t": t, "breadth": breadth,
                         "warning": breadth >= 0.5})
    return pd.DataFrame(rows)


def check_outbreak_warnings(world):
    """2. Warning if breadth >= 50%. Per outbreak: months from its start to the
    first warning. Plus warnings in country-months without an outbreak."""
    breadth = outbreak_breadth(world)
    warned = set(zip(breadth.loc[breadth["warning"], "country"], breadth.loc[breadth["warning"], "t"]))
    outbreaks = world["events"]["outbreaks"]
    outbreak_months = {(o["country"], o["start"] + k) for o in outbreaks
                       for k in range(len(OUTBREAK_STEPS))}
    rows = []
    for o in outbreaks:
        label = f"{o['country']}, starts {MONTHS[o['start']]}"
        if o["start"] < 12:
            rows.append(signal_row(world, "2 Outbreak warning", "Months to first warning", None,
                                   f"{label}: not scored (needs 12 months of history)"))
            continue
        fired = [k for k in range(len(OUTBREAK_STEPS)) if (o["country"], o["start"] + k) in warned]
        rows.append(signal_row(world, "2 Outbreak warning", "Months to first warning",
                               fired[0] if fired else None,
                               label + ("" if fired else ": missed")))
    quiet = breadth[[(c, t) not in outbreak_months for c, t in zip(breadth["country"], breadth["t"])]]
    rows += [
        signal_row(world, "2 Outbreak warning", "False alarms (warnings with no outbreak)",
                   int(quiet["warning"].sum())),
        signal_row(world, "2 Outbreak warning", "Country-months checked with no outbreak", len(quiet),
                   f"{MONTHS[12]} to {MONTHS[-1]}, 5 countries"),
    ]
    return rows


def check_equipment_lead(world):
    """3. Country level: correlation between B's 3-month log ratio (as in the
    equipment-lead model) and A's log ratio in the following month."""
    series = world["series"]
    b_side, a_side = [], []
    for country in COUNTRIES:
        b_units = series[(country, "B")].to_numpy(dtype=float)
        a_units = series[(country, "A")].to_numpy(dtype=float)
        for origin in range(11, LAST_T):
            b_side.append(b_lead(b_units, origin))
            a_side.append(np.log(a_units[origin + 1] / a_units[origin - 11:origin + 1].mean()))
    return [
        signal_row(world, "3 Equipment lead", "Correlation: B 3-month vs A next month",
                   round(float(np.corrcoef(b_side, a_side)[0, 1]), 3), "5 countries x 24 months"),
        signal_row(world, "3 Equipment lead", "Analyser installations planted",
                   len(world["events"]["installs"])),
    ]


def check_setup_speed(world):
    """4. Business impact of faster MDM setup: first orders under today's ~18-day
    approval vs a 3-day approval (same request, 3/18 of the time). Units are
    expected units from the generator's normal level (other patterns ignored)."""
    newcomers = [c for c in world["customers"] if c["new"]]
    if not newcomers:
        return []
    delays = [c["first_order_t"] - c["fast_first_order_t"] for c in newcomers]
    earlier = [c for c in newcomers
               if c["first_order_t"] > c["fast_first_order_t"] and c["fast_first_order_t"] <= LAST_T]
    first_month_units = sum(normal_level(c, p, c["first_order_t"]) * RAMP[0]
                            for c in earlier for p in c["products"])
    window_gain = sum(normal_level(c, p, t) * (ramp_factor(c["fast_first_order_t"], t)
                                               - ramp_factor(c["first_order_t"], t))
                      for c in newcomers for p in c["products"] for t in range(LAST_T + 1))
    check = "4 Faster setup"
    return [
        signal_row(world, check, "New customers", len(newcomers)),
        signal_row(world, check, "Average approval days, today", round(np.mean([c["approval_days"] for c in newcomers]), 1)),
        signal_row(world, check, "Average approval days, 3-day process", round(np.mean([c["fast_approval_days"] for c in newcomers]), 1)),
        signal_row(world, check, "Customers whose first order comes >= 1 month earlier", len(earlier),
                   "first order inside the data window"),
        signal_row(world, check, "First-month units arriving >= 1 month earlier", round(first_month_units),
                   "expected units, all products"),
        signal_row(world, check, "Average delay in months (today vs 3-day)", round(float(np.mean(delays)), 2),
                   "over all new customers"),
        signal_row(world, check, "Extra units ordered by Sep 2026 with 3-day setup", round(window_gain),
                   "whole ramp shifts earlier; expected units"),
    ]


def signal_checks(world):
    return (check_dropoffs(world) + check_outbreak_warnings(world)
            + check_equipment_lead(world) + check_setup_speed(world))


# ---------------------------------------------------------------------------
# Saving and printing
# ---------------------------------------------------------------------------

def save(detail, signals):
    """Write all three CSVs (called after every run, so a crash loses little)."""
    detail = pd.concat(detail, ignore_index=True)
    first = ["scenario", "seed", "model"]
    detail = detail[first + [col for col in detail.columns if col not in first]].round(2)
    RESULTS_DIR.mkdir(exist_ok=True)
    detail.to_csv(RESULTS_DIR / "stress_test_v2_detail.csv", index=False)
    stress_test.summarise_scenarios(detail).to_csv(RESULTS_DIR / "stress_test_v2_summary.csv", index=False)
    pd.DataFrame(signals).to_csv(RESULTS_DIR / "signal_check_v2.csv", index=False)
    return detail


def describe_events(world):
    e = world["events"]
    outbreaks = "; ".join(f"{o['country']} from {MONTHS[o['start']]}" for o in e["outbreaks"])
    newcomers = [c for c in world["customers"] if c["new"]]
    parts = []
    if outbreaks:
        parts.append(f"outbreaks: {outbreaks}; stock-ups: "
                     f"{sum(len(s) for s in e['stockups'].values())}")
    if e["installs"]:
        parts.append(f"installs: {len(e['installs'])}")
    if newcomers:
        parts.append(f"new customers: {len(newcomers)}")
    return " | ".join(parts) if parts else "no new patterns"


def print_tables(detail, signals):
    summary = stress_test.summarise_scenarios(detail)
    order = list(WORLDS) + ([S10] if S10 in set(summary["scenario"]) else [])
    wide = summary.pivot(index="model", columns="scenario", values="MAPE % (mean of seeds)")[order]
    print("\nMAPE %, mean of 3 seeds (lower is better):\n")
    print(wide.sort_values("S0 Baseline").round(2).to_string())
    print("\nWinner per world:", {w: wide[w].idxmin() for w in order})
    spread = (summary.pivot(index="model", columns="scenario", values="MAPE % (highest seed)")
              - summary.pivot(index="model", columns="scenario", values="MAPE % (lowest seed)"))[order]
    print("\nSpread across seeds (highest minus lowest MAPE %):\n")
    print(spread.reindex(wide.sort_values("S0 Baseline").index).round(1).to_string())

    mape = detail.pivot_table(index=["scenario", "seed"], columns="model", values="MAPE %")
    print("\nNew models vs plain calendar regression (MAPE % difference, negative = better):")
    for new in ["Calendar + momentum", "Calendar + equipment lead", "Calendar + pipeline"]:
        gap = mape[new] - mape["Calendar regression"]
        for w in order:
            per_seed = gap.loc[w]
            print(f"  {new:27s} {w:30s} mean {per_seed.mean():+.2f}  "
                  f"per seed {[round(v, 2) for v in per_seed]}")
    if S10 in order:
        loss = wide[S10] - wide["S0 Baseline"]
        print("\nS10 accuracy loss from contaminated history (MAPE % points, S10 minus S0):\n")
        print(loss.sort_values().round(2).to_string())

    s = pd.DataFrame(signals)
    print("\nSignal checks (sum over seeds; outbreak lags listed):\n")
    for (check, measure), block in s.groupby(["check", "measure"], sort=False):
        if measure == "Months to first warning":
            continue
        print(f"  {check} | {measure}: "
              + ", ".join(f"{w.split()[0]} {block.loc[block['scenario'] == w, 'value'].tolist()}"
                          for w in block["scenario"].unique()))
    lags = s[s["measure"] == "Months to first warning"]
    print("\n  Outbreak lags:")
    for _, r in lags.iterrows():
        print(f"    {r['scenario']:26s} seed {r['seed']}: {r['note']} -> {r['value']}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    start = time.time()
    check_against_official_data()
    detail, signals = [], []

    for world_name in WORLDS:
        for seed in SEEDS:
            clock = time.time()
            world = make_world(world_name, seed)
            results = run_backtest(world["series"], world["series"],
                                   model_set(world, with_chronos=seed in CHRONOS_SEEDS))
            table = stress_test.score(results)
            detail.append(table.reset_index().assign(scenario=world_name, seed=seed))
            signals += signal_checks(world)
            save(detail, signals)
            print(f"{world_name}, seed {seed}: {describe_events(world)}; best = "
                  f"{table['MAPE %'].idxmin()} ({table['MAPE %'].min():.1f}%), "
                  f"{time.time() - clock:.0f} s", flush=True)

    if RUN_S10:  # S0 worlds again, but the models learn from contaminated history
        for seed in SEEDS:
            clock = time.time()
            world = make_world("S0 Baseline", seed)
            results = run_backtest(contaminated_history(world, seed), world["series"],
                                   model_set(world, with_chronos=seed in CHRONOS_SEEDS))
            table = stress_test.score(results)
            detail.append(table.reset_index().assign(scenario=S10, seed=seed))
            save(detail, signals)
            print(f"{S10}, seed {seed}: best = {table['MAPE %'].idxmin()} "
                  f"({table['MAPE %'].min():.1f}%), {time.time() - clock:.0f} s", flush=True)

    print_tables(save(detail, signals), signals)
    print(f"\nTotal runtime: {(time.time() - start) / 60:.1f} minutes")


if __name__ == "__main__":
    main()
