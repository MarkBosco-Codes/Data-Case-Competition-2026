# Analytics: regional view and forecasts

**All data here is fake.** We made it up and planted patterns in it to test our methods.
How it was made: [`data/synthetic/README.md`](data/synthetic/README.md).

## Open the dashboard
```
pip install -r analytics/requirements.txt
streamlit run analytics/src/regional_view.py
```
It opens in your browser with 4 tabs:
- **Business:** orders by country and product, and growth vs last year
- **Administrative:** requests for new records, kept separate from orders
- **Forecast:** which forecast method works best, and the next 3 months
- **Actions:** duplicate customers, who sales should call, and what to do

## Main results (fake data)
- Using the holiday and budget calendar makes forecast misses about 19% smaller for
  reagents (A) and 28% smaller for equipment (B) than today's 6-month average.
- In 18 harder fake worlds, it beat the 6-month average every time.
- 6 duplicate customer records caused 11 of 17 wrong sales leads.

## Files
| File | What it does |
|---|---|
| `src/make_synthetic_data.py` | Makes 3 years of fake orders for 50 customers in 5 countries |
| `src/setup_requests.py` | Makes fake requests for new records |
| `src/backtest.py` | Tests 11 forecast methods on 12 months they have not seen |
| `src/stress_test.py` | Repeats the test in 6 harder fake worlds |
| `src/dedupe.py` | Finds customers saved twice under different names |
| `src/signals.py` | Flags customers ordering less, or who could buy more |
| `src/regional_view.py` | The dashboard |
