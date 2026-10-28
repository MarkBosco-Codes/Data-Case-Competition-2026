"""
Backtest: which forecasting method predicts monthly orders best?

SYNTHETIC DATA: the orders come from src/make_synthetic_data.py, not from
Lives Group. Results show how the method works, not real findings.

How it works:
1. Add up orders into 15 monthly series (5 countries x 3 products).
2. Stand at the end of a past month (the "cut-off"). Each model sees only the
   months up to the cut-off and forecasts the next 1, 2 and 3 months.
3. Compare each forecast with what actually happened. Move the cut-off one
   month later and repeat: 12 cut-offs, from Sep 2025 to Aug 2026.
4. Score every model the same way:
     MAE   = average miss in units per month
     MAPE  = average miss as a % of actual orders
     wins  = in how many of the 15 series the model beats the 12-month average
     range coverage = how often actual orders land inside the 80% forecast range

Run from the repo folder:  python src/backtest.py
"""

import os
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import RidgeCV
from statsmodels.tsa.holtwinters import ExponentialSmoothing
from statsmodels.tsa.statespace.sarimax import SARIMAX

# Only the calendar *dates* are reused from the generator. The size of each
# effect is not: the models have to estimate that from the orders.
from make_synthetic_data import FISCAL_YEAR_END, HOLIDAYS, RAINY_MONTHS

warnings.filterwarnings("ignore", module="statsmodels")  # fitting warnings on short series
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")  # harmless Windows cache warning

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data" / "synthetic"
RESULTS_DIR = ROOT / "results"

FIRST_CUTOFF = "2025-09"  # the first month the models stand at (they see 24 months)
MAX_HORIZON = 3           # forecast up to 3 months ahead

FLAGS = ["holiday", "budget_last", "budget_second_last", "rainy"]
FLAGS_BY_PRODUCT = {  # the flags that can matter for each product
    "A": ["holiday", "rainy"],
    "B": ["holiday", "budget_last", "budget_second_last"],
    "C": ["holiday"],
}
COUNTRY_NUMBER = {country: n for n, country in enumerate(sorted(HOLIDAYS))}
PRODUCT_NUMBER = {"A": 0, "B": 1, "C": 2}


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------

def load_series():
    """Monthly units ordered: one row per month, one column per (country, product)."""
    orders = pd.read_csv(DATA_DIR / "orders.csv")
    customers = pd.read_csv(DATA_DIR / "customers.csv")
    orders = orders.merge(customers[["card_code", "country"]], on="card_code")
    table = orders.pivot_table(index="month", columns=["country", "product"],
                               values="quantity", aggfunc="sum", fill_value=0)
    return table.sort_index()


def calendar_flags(country, product, month):
    """Calendar facts known in advance for one series and month (1 = yes, 0 = no)."""
    month_number = int(month[5:])
    year_end = FISCAL_YEAR_END[country]
    month_before = 12 if year_end == 1 else year_end - 1
    return {
        "holiday": int(any(month in months for months, _effect in HOLIDAYS[country])),
        "budget_last": int(product == "B" and month_number == year_end),
        "budget_second_last": int(product == "B" and month_number == month_before),
        "rainy": int(product == "A" and month_number in RAINY_MONTHS[country]),
    }


def ratio_rows(train):
    """One row per series and month: how far orders sat above or below the
    average of the 12 months before, as a log ratio (so effects read as %)."""
    rows = []
    for country, product in train.columns:
        values = train[(country, product)]
        for t in range(12, len(values)):
            level = values.iloc[t - 12:t].mean()
            month = values.index[t]
            rows.append({"country": country, "product": product, "month": month,
                         "log_ratio": np.log(values.iloc[t] / level),
                         **calendar_flags(country, product, month)})
    return pd.DataFrame(rows)


def future_rows(train, future):
    """One row per series and future month, with the latest 12-month average as the level."""
    rows = []
    for country, product in train.columns:
        level = train[(country, product)].iloc[-12:].mean()
        for month in future:
            rows.append({"country": country, "product": product, "month": month,
                         "level": level, **calendar_flags(country, product, month)})
    return pd.DataFrame(rows)


def to_table(rows, forecasts, future, columns):
    """Turn one forecast per row back into a months x series table."""
    rows = rows.assign(forecast=np.asarray(forecasts))
    table = rows.pivot_table(index="month", columns=["country", "product"], values="forecast")
    return table.reindex(index=future, columns=columns)


# ---------------------------------------------------------------------------
# Models. Each takes the history up to the cut-off and the months to forecast,
# and returns a table of forecasts (months x series).
# ---------------------------------------------------------------------------

def flat(values, future):
    """Repeat one number per series for every future month."""
    return pd.DataFrame([values] * len(future), index=future)


def six_month_average(train, future):
    """The client's current method: the average of the last 6 months."""
    return flat(train.iloc[-6:].mean(), future)


def twelve_month_average(train, future):
    """The client's other option: the average of the last 12 months."""
    return flat(train.iloc[-12:].mean(), future)


def same_month_last_year(train, future):
    """Seasonal naive: forecast = orders in the same month one year earlier."""
    rows = [train.loc[str(pd.Period(month, freq="M") - 12)] for month in future]
    return pd.DataFrame(rows, index=future)


def holt_winters(train, future):
    """Seasonal exponential smoothing, fitted separately to each series."""
    forecasts = {}
    for series in train.columns:
        model = ExponentialSmoothing(train[series].to_numpy(dtype=float),
                                     trend="add", damped_trend=True,
                                     seasonal="mul", seasonal_periods=12)
        forecasts[series] = model.fit().forecast(len(future))
    return pd.DataFrame(forecasts, index=future)


def calendar_regression(train, future):
    """One regression across all 15 series (DSA211 linear regression):

        log(orders / last-12-month average) = b0 + b1*holiday + b2*budget_last
                                              + b3*budget_second_last + b4*rainy

    If no calendar effect matters, b1..b4 are about 0 and the forecast is
    close to the 12-month average."""
    history = ratio_rows(train)
    fit = sm.OLS(history["log_ratio"], sm.add_constant(history[FLAGS], has_constant="add")).fit()
    upcoming = future_rows(train, future)
    log_ratio = fit.predict(sm.add_constant(upcoming[FLAGS], has_constant="add"))
    return to_table(upcoming, upcoming["level"] * np.exp(log_ratio), future, train.columns)


def sarimax_with_calendar(train, future):
    """The teammate's SARIMAX idea, fitted to each series in logs: an AR(1)
    model with a trend, plus the calendar flags for that product. No seasonal
    ARIMA terms, because 2-3 years is too short to estimate them reliably."""
    forecasts = {}
    for country, product in train.columns:
        flags = FLAGS_BY_PRODUCT[product]
        past = pd.DataFrame([calendar_flags(country, product, m) for m in train.index])[flags]
        ahead = pd.DataFrame([calendar_flags(country, product, m) for m in future])[flags]
        values = np.log(train[(country, product)].to_numpy(dtype=float))
        fit = SARIMAX(values, exog=past.to_numpy(), order=(1, 0, 0), trend="ct").fit(disp=False)
        forecasts[(country, product)] = np.exp(fit.forecast(len(future), exog=ahead.to_numpy()))
    return pd.DataFrame(forecasts, index=future)


def tree_features(rows):
    """Numbers the tree model can split on: the calendar flags plus month, country, product."""
    return pd.DataFrame({
        **{flag: rows[flag] for flag in FLAGS},
        "month_number": rows["month"].str[5:].astype(int),
        "country": rows["country"].map(COUNTRY_NUMBER),
        "product": rows["product"].map(PRODUCT_NUMBER),
    })


def gradient_boosting(train, future):
    """Gradient-boosted trees (the XGBoost family), given the same target as the
    calendar regression plus month, country and product. Tests whether a more
    flexible learner beats a straight-line regression on this little data."""
    history = ratio_rows(train)
    model = HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, max_iter=200,
                                          min_samples_leaf=10, random_state=0)
    model.fit(tree_features(history), history["log_ratio"])
    upcoming = future_rows(train, future)
    log_ratio = model.predict(tree_features(upcoming))
    return to_table(upcoming, upcoming["level"] * np.exp(log_ratio), future, train.columns)


def ridge_features(rows):
    """The shared calendar flags plus one 'holiday in this country' column per country."""
    features = rows[FLAGS].copy()
    for country in COUNTRY_NUMBER:
        features[f"holiday_{country}"] = rows["holiday"] * (rows["country"] == country)
    return features


def ridge_country_holidays(train, future):
    """Calendar regression where each country gets its own holiday effect,
    pulled towards the shared effect by ridge (DSA211 week 9). Same idea as
    Buhlmann credibility: trust a country's own estimate only as far as its
    evidence allows. The pull strength is chosen by cross-validation."""
    history = ratio_rows(train)
    model = RidgeCV(alphas=np.logspace(-2, 2, 21))
    model.fit(ridge_features(history), history["log_ratio"])
    upcoming = future_rows(train, future)
    log_ratio = model.predict(ridge_features(upcoming))
    return to_table(upcoming, upcoming["level"] * np.exp(log_ratio), future, train.columns)


_chronos = None


def chronos_pipeline():
    """Amazon's pre-trained Chronos-2 forecasting model, run with PyTorch.
    Loaded once; the first run downloads it (~0.5 GB) from Hugging Face."""
    global _chronos
    if _chronos is None:
        from chronos import Chronos2Pipeline
        _chronos = Chronos2Pipeline.from_pretrained("amazon/chronos-2", device_map="cpu")
    return _chronos


def long_table(train, months, with_target):
    """Chronos wants one row per series and month, with a real date."""
    rows = []
    for country, product in train.columns:
        for month in months:
            row = {"item_id": f"{country}|{product}", "timestamp": pd.Timestamp(month),
                   **calendar_flags(country, product, month)}
            if with_target:
                row["target"] = float(train.loc[month, (country, product)])
            rows.append(row)
    return pd.DataFrame(rows)


def chronos_forecast(train, future, use_calendar):
    """Ask Chronos-2 for the median forecast of every series. It is not trained
    on our data at all: it uses patterns learned from a large collection of
    other time series. With use_calendar, it also sees the calendar flags."""
    past = long_table(train, train.index, with_target=True)
    columns = ["item_id", "timestamp", "target"] + (FLAGS if use_calendar else [])
    ahead = long_table(train, future, with_target=False)[["item_id", "timestamp"] + FLAGS]
    output = chronos_pipeline().predict_df(past[columns],
                                           future_df=ahead if use_calendar else None,
                                           prediction_length=len(future), quantile_levels=[0.5])
    output["month"] = output["timestamp"].dt.strftime("%Y-%m")
    output[["country", "product"]] = output["item_id"].str.split("|", expand=True)
    return to_table(output, output["0.5"], future, train.columns)


def chronos_plain(train, future):
    return chronos_forecast(train, future, use_calendar=False)


def chronos_with_calendar(train, future):
    return chronos_forecast(train, future, use_calendar=True)


MODELS = {
    "6-month average (current method)": six_month_average,
    "12-month average": twelve_month_average,
    "Same month last year": same_month_last_year,
    "Holt-Winters": holt_winters,
    "Calendar regression": calendar_regression,
    "Ridge: country holidays": ridge_country_holidays,
    "SARIMAX with calendar": sarimax_with_calendar,
    "Gradient boosting": gradient_boosting,
    "Chronos-2 (pre-trained)": chronos_plain,
    "Chronos-2 + calendar": chronos_with_calendar,
}
# The ensemble is the plain average of these four, fixed before seeing any results.
ENSEMBLE_OF = ["Holt-Winters", "Calendar regression", "SARIMAX with calendar", "Gradient boosting"]


# ---------------------------------------------------------------------------
# Backtest and scoring
# ---------------------------------------------------------------------------

def run_backtest(series):
    """Forecast from every cut-off with every model. One row per forecast."""
    months = list(series.index)
    first = months.index(FIRST_CUTOFF)
    rows = []
    for cut in range(first, len(months) - 1):
        train = series.iloc[:cut + 1]                       # only the past
        future = months[cut + 1:cut + 1 + MAX_HORIZON]      # the months to forecast
        for name, model in MODELS.items():
            forecast = model(train, future)
            for horizon, month in enumerate(future, start=1):
                for country, product in series.columns:
                    rows.append({"cutoff": months[cut], "horizon": horizon, "month": month,
                                 "country": country, "product": product, "model": name,
                                 "forecast": forecast.loc[month, (country, product)],
                                 "actual": series.loc[month, (country, product)]})
    return add_ensemble(pd.DataFrame(rows))


def add_ensemble(results):
    """Add the ensemble: the average forecast of the models in ENSEMBLE_OF."""
    keys = ["cutoff", "horizon", "month", "country", "product"]
    parts = results[results["model"].isin(ENSEMBLE_OF)]
    average = parts.groupby(keys, as_index=False).agg(forecast=("forecast", "mean"),
                                                      actual=("actual", "first"))
    average["model"] = "Ensemble (average of 4)"
    return pd.concat([results, average], ignore_index=True)


def range_coverage(results):
    """How often actuals land inside the 80% forecast range.

    The range comes from past misses: for each model, product and horizon,
    take log(actual / forecast) from the first 6 cut-offs and find its 10th
    and 90th percentiles. Apply that range to forecasts from the last 6
    cut-offs and count how often the actual lands inside."""
    cutoffs = sorted(results["cutoff"].unique())
    early = results[results["cutoff"].isin(cutoffs[:6])]
    late = results[results["cutoff"].isin(cutoffs[6:])]
    misses = early.assign(miss=np.log(early["actual"] / early["forecast"]))
    bounds = (misses.groupby(["model", "product", "horizon"])["miss"]
              .quantile([0.1, 0.9]).unstack())
    bounds.columns = ["low", "high"]
    late = late.join(bounds, on=["model", "product", "horizon"])
    inside = ((late["actual"] >= late["forecast"] * np.exp(late["low"]))
              & (late["actual"] <= late["forecast"] * np.exp(late["high"])))
    return inside.groupby(late["model"]).mean() * 100


def summarise(results):
    """The scoreboard: one row per model."""
    results = results.assign(miss=(results["actual"] - results["forecast"]).abs())
    mae = results.pivot_table(index="model", columns="product", values="miss", aggfunc="mean")
    mae.columns = [f"MAE {product} (units)" for product in mae.columns]
    mape = (results["miss"] / results["actual"]).groupby(results["model"]).mean() * 100
    per_series = results.groupby(["model", "country", "product"])["miss"].mean().unstack("model")
    wins = per_series.lt(per_series["12-month average"], axis=0).sum()
    table = mae.assign(**{"MAPE %": mape,
                          "Beats 12-mo avg (of 15)": wins,
                          "80% range coverage %": range_coverage(results)})
    return table.sort_values("MAPE %").round(1)


def recovered_effects(series):
    """Fit the calendar regression on all 36 months and compare its estimates
    with what the generator planted."""
    history = ratio_rows(series)
    fit = sm.OLS(history["log_ratio"], sm.add_constant(history[FLAGS], has_constant="add")).fit()
    interval = fit.conf_int()
    table = pd.DataFrame({"estimated %": np.exp(fit.params) - 1,
                          "95% CI low %": np.exp(interval[0]) - 1,
                          "95% CI high %": np.exp(interval[1]) - 1}) * 100
    table = table.round(1)
    table["planted %"] = ["(growth drift)", "-7 to -25", "+60", "+30", "+10"]
    return table


def country_holiday_effects(series):
    """Fit the ridge model on all 36 months: each country's holiday effect vs planted."""
    history = ratio_rows(series)
    model = RidgeCV(alphas=np.logspace(-2, 2, 21)).fit(ridge_features(history), history["log_ratio"])
    coef = dict(zip(ridge_features(history).columns, model.coef_))
    planted = {"Indonesia": "-20 (Hari Raya)", "Malaysia": "-7 (LNY), -12 (Hari Raya)",
               "Singapore": "-7 (LNY)", "Thailand": "-12 (Songkran)", "Vietnam": "-25 (Tet)"}
    return pd.DataFrame({
        "estimated %": {c: round((np.exp(coef["holiday"] + coef[f"holiday_{c}"]) - 1) * 100, 1)
                        for c in COUNTRY_NUMBER},
        "planted %": planted,
    })


def main():
    series = load_series()
    print(f"{series.shape[1]} series, {series.index[0]} to {series.index[-1]}")

    results = run_backtest(series)
    summary = summarise(results)
    RESULTS_DIR.mkdir(exist_ok=True)
    results.to_csv(RESULTS_DIR / "backtest_forecasts.csv", index=False)
    summary.to_csv(RESULTS_DIR / "backtest_summary.csv")

    per_model = len(results) // results["model"].nunique()
    print(f"\nBacktest: {results['cutoff'].nunique()} cut-offs, {per_model} forecasts per model\n")
    print(summary.to_string())
    print("\nCalendar effects found by the regression vs planted:\n")
    print(recovered_effects(series).to_string())
    print("\nHoliday effect per country, ridge model vs planted:\n")
    print(country_holiday_effects(series).to_string())


if __name__ == "__main__":
    main()
