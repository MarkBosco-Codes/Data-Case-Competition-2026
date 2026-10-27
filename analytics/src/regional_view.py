"""
Regional business view for Lives Group: a Streamlit app.

SYNTHETIC DATA: every order and request is generated (see analytics/data/synthetic).
Patterns were planted to test the methods; the numbers are not real Lives Group results.

Run from the repo folder:   streamlit run analytics/src/regional_view.py
"""

import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
import streamlit as st

from backtest import FLAGS, calendar_regression, load_series, ratio_rows
from dedupe import THRESHOLD, evaluate, find_matches, merge_map
from make_synthetic_data import FISCAL_YEAR_END
from signals import DROP_RATIO, PEER_SHARE, cross_sell_gaps, dropoff_alerts

ANALYTICS = Path(__file__).resolve().parent.parent
DATA = ANALYTICS / "data" / "synthetic"
RESULTS = ANALYTICS / "results"
DATAGENT_DB = ANALYTICS.parent / ".datagent.db"  # the request app's database, if present

CURRENT = "6-month average (current method)"
BEST = "Calendar regression"
CITY = {  # map markers: one main city per country
    "Singapore": (1.35, 103.82), "Malaysia": (3.14, 101.69), "Thailand": (13.75, 100.50),
    "Indonesia": (-6.21, 106.85), "Vietnam": (10.82, 106.63),
}


# ---------------------------------------------------------------------------
# Data and calculations
# ---------------------------------------------------------------------------

def load_stress():
    """Both rounds of the stress test. Round 2 re-ran the baseline world, so drop that copy."""
    first = pd.read_csv(RESULTS / "stress_test_summary.csv")
    second = pd.read_csv(RESULTS / "stress_test_v2_summary.csv")
    return pd.concat([first, second[second["scenario"] != "S0 Baseline"]])


@st.cache_data
def load_data():
    return {
        "series": load_series(),  # months x (country, product), units ordered
        "orders": pd.read_csv(DATA / "orders.csv"),
        "customers": pd.read_csv(DATA / "customers.csv"),
        "answer_key": pd.read_csv(DATA / "answer_key.csv"),
        "requests": pd.read_csv(DATA / "setup_requests.csv", parse_dates=["submitted", "approved"]),
        "scoreboard": pd.read_csv(RESULTS / "backtest_summary.csv", index_col=0),
        "forecasts": pd.read_csv(RESULTS / "backtest_forecasts.csv"),
        "stress": load_stress(),
    }


WORLDS = {  # stress-test scenario -> plain description
    "S0 Baseline": "Same rules as our data",
    "S1 Persistent demand": "Busy or quiet spells last for months",
    "S2 Changing calendar": "Holiday and budget effects change size each year",
    "S3 Unknown seasonality": "A seasonal wave that no calendar flag explains",
    "S4 Shocks and breaks": "Surprise outbreaks and a new big contract",
    "S5 Messy world": "All of the above at once",
    "S6 Outbreaks + stock-ups": "Dengue/flu outbreaks; some customers stock up (one big order, then two small)",
    "S7 Equipment drives reagents": "Analyser sales (B) lead to reagent orders (A, C) later",
    "S8 New customer ramp-up": "New customers wait ~18 days for approval, then build up",
    "S9 All new patterns": "Outbreaks, equipment lead and ramp-up at once",
    "S10 Contaminated history": "Enquiries logged as orders add about 6% to past order history",
}


def stress_table(stress):
    """One row per harder world: today's method, the 12-month average, the
    calendar regression, and the best method overall in that world."""
    mape = (stress.pivot_table(index="scenario", columns="model", values="MAPE % (mean of seeds)")
            .reindex(list(WORLDS)))  # keep S0..S10 in order (sorting by text puts S10 after S1)
    table = mape[[CURRENT, "12-month average", BEST]].copy()
    table["Best method in this world"] = [f"{mape.loc[s].idxmin()} ({mape.loc[s].min():.1f}%)"
                                          for s in mape.index]
    table.insert(0, "World", [WORLDS.get(s, s) for s in table.index])
    return table.reset_index(drop=True)


def noise_band(series):
    """How big a 12-month vs 12-month change can be from normal month-to-month
    noise alone: two standard errors, from the calendar regression's leftover
    variation in each series."""
    history = ratio_rows(series)
    fit = sm.OLS(history["log_ratio"], sm.add_constant(history[FLAGS], has_constant="add")).fit()
    sigma = history.assign(leftover=fit.resid).groupby(["country", "product"])["leftover"].std()
    return 2 * sigma * np.sqrt(2 / 12)


def growth_table(series):
    """Units and year-on-year growth per country and product."""
    last, previous = series.iloc[-12:].sum(), series.iloc[-24:-12].sum()
    band = noise_band(series)
    change = np.log(last / previous)
    table = pd.DataFrame({
        "Units, last 12 months": last,
        "Units, previous 12 months": previous,
        "Growth %": (last / previous - 1) * 100,
        "Noise band ± %": (np.exp(band) - 1) * 100,
        "Signal": np.where(change.abs() > band, "real change", "within noise"),
    })
    return table.reset_index().rename(columns={"country": "Country", "product": "Product"})


def next_quarter(series, forecasts):
    """Calendar-regression forecast for the next 3 months, with an 80% range
    taken from this model's past misses in the backtest."""
    future = [str(pd.Period(series.index[-1], freq="M") + h) for h in (1, 2, 3)]
    point = calendar_regression(series, future)
    past = forecasts[forecasts["model"] == BEST]
    miss = np.log(past["actual"] / past["forecast"])
    bounds = miss.groupby([past["product"], past["horizon"]]).quantile([0.1, 0.9]).unstack()
    rows = []
    for horizon, month in enumerate(future, start=1):
        for (country, product), value in point.loc[month].items():
            low, high = bounds.loc[(product, horizon)]
            rows.append({"Month": month, "Country": country, "Product": product,
                         "Forecast": value, "Low (10%)": value * np.exp(low),
                         "High (90%)": value * np.exp(high)})
    return pd.DataFrame(rows)


def budget_spike(forecasts):
    """Equipment (B) in the countries whose budget year ends in December:
    actual orders vs one-month-ahead forecasts from two methods."""
    countries = [country for country, month in FISCAL_YEAR_END.items() if month == 12]
    one_ahead = forecasts[(forecasts["horizon"] == 1) & (forecasts["product"] == "B")
                          & forecasts["country"].isin(countries)
                          & forecasts["model"].isin([CURRENT, BEST])]
    table = one_ahead.pivot_table(index="month", columns="model", values="forecast", aggfunc="sum")
    table["Actual orders"] = one_ahead[one_ahead["model"] == BEST].groupby("month")["actual"].sum()
    return table.rename(columns={CURRENT: "Current method forecast", BEST: "Calendar regression forecast"})


def customer_names(customers):
    return customers.set_index("card_code")[["card_name", "country", "customer_type"]]


def call_list(orders, customers, mapping, months):
    """Who the sales team should call this month, and why (after clean-up)."""
    names = customer_names(customers)
    volume = orders[orders["month"].isin(months[-12:])].assign(
        customer=orders["card_code"].map(lambda code: mapping.get(code, code))
    ).groupby("customer")["quantity"].sum()
    drops = dropoff_alerts(orders, mapping, months)
    gaps = cross_sell_gaps(orders, customers, mapping, months)
    rows = [{"customer": r.customer, "Product": r.product, "Signal": "Drop-off",
             "Why": f"Orders down {-r._5:.0f}% vs usual level",
             "Recommended action": "Retention call: ask about a competitor, budget or stock issue"}
            for r in drops.itertuples()]
    rows += [{"customer": r.customer, "Product": r.product, "Signal": "Cross-sell",
              "Why": f"{r._3:.0f}% of similar customers buy Product {r.product}",
              "Recommended action": f"Offer Product {r.product}"}
             for r in gaps.itertuples()]
    table = pd.DataFrame(rows).join(names, on="customer")
    table["Units, last 12 months"] = table["customer"].map(volume)
    table = table.rename(columns={"card_name": "Customer", "country": "Country", "customer_type": "Type"})
    return table.sort_values("Units, last 12 months", ascending=False)[
        ["Customer", "Country", "Type", "Signal", "Product", "Why", "Recommended action"]]


def datagent_requests():
    """Live request counts from the request app's database, if it is next to this folder."""
    if not DATAGENT_DB.exists():
        return None
    with sqlite3.connect(f"file:{DATAGENT_DB.as_posix()}?mode=ro", uri=True) as connection:
        return pd.read_sql("SELECT type AS Type, status AS Status, COUNT(*) AS Requests "
                           "FROM requests GROUP BY type, status", connection)


# ---------------------------------------------------------------------------
# Page
# ---------------------------------------------------------------------------

st.set_page_config(page_title="Lives Group regional view", layout="wide")
data = load_data()
series, orders, customers = data["series"], data["orders"], data["customers"]
months = list(series.index)
period = f"{months[-12]} to {months[-1]}"

st.title("Lives Group: regional business view")
st.warning("**Synthetic data.** Orders, customers and requests are generated with planted patterns "
           "to test the methods. The numbers are not real Lives Group results.")

business, admin, forecast_tab, actions = st.tabs(
    ["Business: orders", "Administrative: MDM requests", "Forecast", "Actions"])

# ---- Business: purchase orders -------------------------------------------
with business:
    st.subheader(f"Customer purchase orders, {period}")
    st.caption("Growth = (units in the last 12 months − units in the previous 12 months) "
               "÷ units in the previous 12 months. Comparing whole years stops seasonality "
               "from looking like growth.")

    by_product = series.T.groupby(level="product").sum().T
    columns = st.columns(3)
    for column, product in zip(columns, ["A", "B", "C"]):
        last, previous = by_product[product].iloc[-12:].sum(), by_product[product].iloc[-24:-12].sum()
        column.metric(f"Product {product}, all 5 countries", f"{last:,.0f} units",
                      f"{(last / previous - 1) * 100:+.1f}% vs previous 12 months")

    growth = growth_table(series)
    st.dataframe(growth, hide_index=True, width="stretch", column_config={
        "Units, last 12 months": st.column_config.NumberColumn(format="%d"),
        "Units, previous 12 months": st.column_config.NumberColumn(format="%d"),
        "Growth %": st.column_config.NumberColumn(format="%+.1f%%"),
        "Noise band ± %": st.column_config.NumberColumn(format="±%.1f%%"),
    })
    st.caption("'Within noise' means the change is smaller than two standard errors of normal "
               "month-to-month variation, so it could be chance. Only 'real change' rows should drive decisions. "
               "With 15 rows, about 1 can cross the line by chance, and noise can exaggerate the size "
               "of a real change.")

    by_country = growth.groupby("Country")["Units, last 12 months"].sum()
    map_points = pd.DataFrame({
        "lat": [CITY[c][0] for c in by_country.index], "lon": [CITY[c][1] for c in by_country.index],
        "size": by_country.to_numpy() / by_country.max() * 150_000,
    })
    st.map(map_points, latitude="lat", longitude="lon", size="size")
    st.caption("Circle size = units ordered in the last 12 months.")

# ---- Administrative: MDM setup requests ----------------------------------
with admin:
    requests = data["requests"]
    recent = requests[requests["submitted"] >= pd.Timestamp(months[-12])]
    st.subheader(f"MDM setup requests, {period}")
    st.caption("Counted separately from purchase orders. Orders come from SAP B1 sales orders; "
               "setup requests come from the request tracker. A new customer must be set up "
               "before its first order can be entered.")

    columns = st.columns(3)
    columns[0].metric("Setup requests", f"{len(recent):,}")
    columns[1].metric("Average days to approve (today's email process)",
                      f"{recent['days_to_approve'].mean():.0f}")
    columns[2].metric("Still open", f"{recent['approved'].isna().sum()}")

    counts = recent.pivot_table(index="country", columns="type", values="request_id", aggfunc="count")
    st.bar_chart(counts)
    st.caption("Assumption: per country and month, on average 3 new-customer, 1 new-vendor and "
               "2 new-item requests; about 18 days to approve today (the brief's example).")

    live = datagent_requests()
    if live is not None:
        st.markdown("**Live from the DataGent request app**")
        st.dataframe(live, hide_index=True)

# ---- Forecast -------------------------------------------------------------
with forecast_tab:
    scoreboard = data["scoreboard"]
    current, best = scoreboard.loc[CURRENT], scoreboard.loc[BEST]
    cut_a = (1 - best["MAE A (units)"] / current["MAE A (units)"]) * 100
    cut_b = (1 - best["MAE B (units)"] / current["MAE B (units)"]) * 100
    st.subheader("Does data science forecast better than today's 6-month average?")
    st.markdown(
        f"We tested {len(scoreboard)} methods on 12 past months they had not seen. Compared with "
        f"today's method, the **calendar regression** cuts the average monthly miss by **{cut_a:.0f}%** "
        f"on reagents (A) and **{cut_b:.0f}%** on equipment (B). Product C has no calendar pattern, "
        "so no gain. Other methods that also use the calendar come within about 1 point of it; "
        "we show the regression because it is the simplest to explain.")
    st.markdown(
        "**How it works:** start from the last 12 months' average, then adjust for calendar "
        "facts known in advance: public holidays, the government budget year-end (equipment) "
        "and the rainy season (diagnostic reagents). If none of them matter, it falls back "
        "to the 12-month average.")

    st.markdown("**Equipment orders around the December budget year-end** "
                "(Malaysia, Indonesia, Vietnam combined; forecasts made one month ahead)")
    st.line_chart(budget_spike(data["forecasts"]))
    st.caption("The current method misses the year-end spike, then over-forecasts the months after: "
               "first stock-outs, then excess stock.")

    st.markdown("**Scoreboard** (average miss per month; lower is better)")
    st.dataframe(scoreboard, width="stretch")
    st.caption("80% range coverage: how often actual orders landed inside the forecast's 80% range. "
               "Close to 80% means the ranges are honest.")

    st.markdown("**Stress test: does the result hold in messier worlds?** "
                "(average miss %, 3 random draws per world; lower is better)")
    st.dataframe(stress_table(data["stress"]), hide_index=True, width="stretch",
                 column_config={name: st.column_config.NumberColumn(format="%.1f%%")
                                for name in [CURRENT, "12-month average", BEST]})
    st.caption("The harder worlds were fixed before seeing any results. Round 1 (S1–S5) makes the data "
               "messier in general; round 2 (S6–S10) adds patterns specific to Lives Group. The calendar "
               "regression beat today's 6-month average in 32 of 33 runs (it lost one by 0.3 points). "
               "In most worlds the best method is less than 1 point ahead of it, so the top methods are "
               "effectively tied: what matters most is using the business calendar. The exception is "
               "S10, where the pre-trained Chronos-2 model copes 1.5 points better with enquiries mixed "
               "into the history; keeping enquiries out of the order data matters more. The regression's "
               "80% ranges caught 67–82% of actual orders (about 75% on average), so they are slightly "
               "too narrow.")

    st.markdown("**Next 3 months, calendar regression with an 80% range**")
    st.dataframe(next_quarter(series, data["forecasts"]), hide_index=True, width="stretch",
                 column_config={name: st.column_config.NumberColumn(format="%d")
                                for name in ["Forecast", "Low (10%)", "High (90%)"]})

# ---- Actions --------------------------------------------------------------
with actions:
    matches = find_matches(customers)
    mapping = merge_map(matches)
    check = evaluate(matches, data["answer_key"])

    st.subheader("Clean data first: duplicates create false sales signals")
    before_gaps = cross_sell_gaps(orders, customers, {}, months)
    after_gaps = cross_sell_gaps(orders, customers, mapping, months)
    before_drops = dropoff_alerts(orders, {}, months)
    after_drops = dropoff_alerts(orders, mapping, months)
    st.dataframe(pd.DataFrame({
        "View": ["Before clean-up (records as in SAP today)", "After merging duplicates"],
        "Customer records": [customers["card_code"].nunique(), customers["card_code"].nunique() - len(mapping)],
        "Cross-sell leads": [len(before_gaps), len(after_gaps)],
        "Drop-off alerts": [len(before_drops), len(after_drops)],
    }), hide_index=True)
    st.markdown(
        f"In our simulation, **{len(mapping)} duplicate records created "
        f"{len(before_gaps) - len(after_gaps)} of {len(before_gaps)} cross-sell leads** "
        f"(the customer already buys that product under another name) and "
        f"**{len(before_drops) - len(after_drops)} false drop-off alerts** (orders had just "
        f"moved to the duplicate record).")
    st.caption(f"Duplicate checker: found {check['correct']} of {check['planted']} planted duplicates "
               f"with {check['false matches']} false matches (similarity ≥ {THRESHOLD}/100). "
               "A person confirms every merge. The test names follow 3 known styles, so expect "
               "lower accuracy on real data.")
    st.dataframe(matches, hide_index=True)

    st.subheader("Customers to call this month")
    st.caption(f"Drop-off: last 3 months below {DROP_RATIO:.0%} of the usual level. "
               f"Cross-sell: at least {PEER_SHARE:.0%} of similar customers buy the product. "
               "Biggest customers first.")
    st.dataframe(call_list(orders, customers, mapping, months), hide_index=True, width="stretch")
    st.caption("Known limit: 2 customers whose orders only started fading in April 2026 are down "
               "about 40%, not yet below the 50% line, so they are not flagged yet.")

    year_end_months = {}
    for country, month in FISCAL_YEAR_END.items():
        year_end_months.setdefault(pd.Timestamp(2026, month, 1).strftime("%b"), []).append(country)
    timing = "; ".join(f"{month}: {', '.join(countries)}" for month, countries in year_end_months.items())
    st.subheader("Business implications and recommended actions")
    st.markdown(f"""
1. **Clean the customer master before acting on sales signals.** Otherwise the sales team chases false leads.
2. **Plan equipment stock and sales visits 1–2 months before each budget year-end** ({timing}).
3. **Switch from the 6-month average to the calendar-aware forecast**: about {cut_a:.0f}% smaller misses on reagents and {cut_b:.0f}% on equipment.
4. **Work the call list monthly**: retention calls for drop-offs, product offers for cross-sell gaps.
5. **Act only on growth outside the noise band**; smaller changes may be chance.
""")
