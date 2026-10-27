# Analytics: regional business view and forecasting

**All data here is synthetic.** It is generated with planted patterns to test the methods;
assumptions are in [`data/synthetic/README.md`](data/synthetic/README.md).

## Run
```
pip install -r analytics/requirements.txt
streamlit run analytics/src/regional_view.py
```
The app has four tabs:
- **Business:** purchase orders by country × product, with year-on-year growth.
- **Administrative:** MDM setup requests, kept separate from orders. It also reads live
  counts from `.datagent.db` if the request app's database is present.
- **Forecast:** the 11-method backtest and the next 3 months.
- **Actions:** the duplicate clean-up, the customers-to-call list and recommended actions.

## Files
| File | What it does |
|---|---|
| `src/make_synthetic_data.py` | 36 months of orders for 50 fictional customers in 5 SE Asian countries |
| `src/setup_requests.py` | synthetic MDM setup requests |
| `src/backtest.py` | tests 11 forecasting methods on 12 held-out months (`python analytics/src/backtest.py`, ~1.5 min) |
| `src/dedupe.py` | fuzzy duplicate-name checker |
| `src/signals.py` | drop-off alerts and cross-sell gaps |
| `src/regional_view.py` | the Streamlit app |
