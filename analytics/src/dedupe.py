"""
Find likely duplicate customer records by name (fuzzy matching).

SYNTHETIC DATA: tested on the generated customer list in ../data/synthetic.

How it works:
1. Clean each name: lower case, no punctuation, short forms written out
   ("Univ." -> "university"), company words dropped ("Pte Ltd", "Sdn Bhd", "PT").
2. Compare every pair of records in the same country.
3. Score each pair from 0 to 100 for how similar the names are (Python's difflib).
   A name that is just the other's initials ("KPL") also scores 100.
4. Pairs scoring 90 or more are likely duplicates. A person confirms each merge.
"""

import re
from difflib import SequenceMatcher
from itertools import combinations

import pandas as pd

THRESHOLD = 90  # fixed before testing; 85 wrongly matched two different medical centres

SHORT_FORMS = {
    "gen": "general", "univ": "university", "hosp": "hospital", "med": "medical",
    "ctr": "centre", "diag": "diagnostics", "path": "pathology", "lab": "laboratory",
    "spec": "specialist", "fam": "family",
}
COMPANY_WORDS = {"pte", "ltd", "sdn", "bhd", "pt", "co", "tbk"}


def clean_name(name):
    """'KINGSWAY UNIV. HOSP. PTE LTD' -> 'kingsway university hospital'."""
    words = re.sub(r"[^a-z0-9 ]", " ", name.lower()).split()
    return " ".join(SHORT_FORMS.get(word, word) for word in words if word not in COMPANY_WORDS)


def initials(cleaned):
    """'kenanga pathology laboratory' -> 'kpl'."""
    return "".join(word[0] for word in cleaned.split())


def similarity(name_a, name_b):
    """How alike two names are, from 0 to 100. Not a probability."""
    a, b = clean_name(name_a), clean_name(name_b)
    if (" " not in a and a == initials(b)) or (" " not in b and b == initials(a)):
        return 100.0
    return round(SequenceMatcher(None, a, b).ratio() * 100, 1)


def find_matches(customers, threshold=THRESHOLD):
    """Every pair of records in the same country that scores at least `threshold`."""
    rows = []
    for country, group in customers.groupby("country"):
        for a, b in combinations(group.itertuples(), 2):
            score = similarity(a.card_name, b.card_name)
            if score >= threshold:
                rows.append({"country": country, "code_a": a.card_code, "name_a": a.card_name,
                             "code_b": b.card_code, "name_b": b.card_name, "similarity": score})
    return pd.DataFrame(rows, columns=["country", "code_a", "name_a", "code_b", "name_b", "similarity"])


def merge_map(matches):
    """Point each duplicate's code at the older record (the lower code number)."""
    return {max(a, b): min(a, b) for a, b in zip(matches["code_a"], matches["code_b"])}


def evaluate(matches, answer_key):
    """Compare the matches found with the duplicates we planted."""
    planted = {frozenset(pair) for pair in
               answer_key.dropna(subset=["duplicate_of"])[["card_code", "duplicate_of"]].itertuples(index=False)}
    found = {frozenset(pair) for pair in matches[["code_a", "code_b"]].itertuples(index=False)}
    correct = len(found & planted)
    return {"planted": len(planted), "found": len(found), "correct": correct,
            "false matches": len(found) - correct}
