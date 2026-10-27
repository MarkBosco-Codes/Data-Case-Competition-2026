"""
Customer signals for the sales team: drop-off alerts and cross-sell gaps.

SYNTHETIC DATA. The rules were fixed before looking at results:
- Drop-off alert: a customer's average monthly order of a product over the
  last 3 months is below half of its average over the 12 months before.
- Cross-sell gap: the customer bought none of a product in the last 12 months,
  while at least 60% of customers of the same type did.

`mapping` points duplicate record codes at the record they duplicate.
An empty mapping means "use the records as they are", duplicates included.
"""

import pandas as pd

DROP_RATIO = 0.5
PEER_SHARE = 0.6


def with_customer_id(table, mapping):
    """Add a 'customer' column: the record's own code, or the code it duplicates."""
    return table.assign(customer=table["card_code"].map(lambda code: mapping.get(code, code)))


def dropoff_alerts(orders, mapping, months):
    """Customer-product pairs whose recent orders fell below half their usual level."""
    data = with_customer_id(orders, mapping)
    table = (data.pivot_table(index=["customer", "product"], columns="month", values="quantity",
                              aggfunc="sum", fill_value=0)
             .reindex(columns=months, fill_value=0))
    usual = table[months[-15:-3]].mean(axis=1)
    recent = table[months[-3:]].mean(axis=1)
    alerts = pd.DataFrame({"usual per month": usual, "last 3 months per month": recent})
    alerts = alerts[(usual > 0) & (recent < DROP_RATIO * usual)]
    alerts["change %"] = (alerts["last 3 months per month"] / alerts["usual per month"] - 1) * 100
    return alerts.reset_index()


def cross_sell_gaps(orders, customers, mapping, months):
    """Customers missing a product that most similar customers buy."""
    recent = with_customer_id(orders[orders["month"].isin(months[-12:])], mapping)
    bought = recent.groupby("customer")["product"].apply(set)
    types = with_customer_id(customers, mapping).drop_duplicates("customer").set_index("customer")["customer_type"]
    rows = []
    for kind in types.unique():
        members = [c for c in types.index[types == kind] if c in bought.index]
        for product in ["A", "B", "C"]:
            share = sum(product in bought[c] for c in members) / len(members)
            if share >= PEER_SHARE:
                rows += [{"customer": c, "product": product, "peer share %": share * 100}
                         for c in members if product not in bought[c]]
    return pd.DataFrame(rows, columns=["customer", "product", "peer share %"])
