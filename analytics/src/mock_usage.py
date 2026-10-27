"""
Fill the LifeGroup DataGent app's database with FAKE usage, so its request list
looks like a team has used the app for four weeks (Wed 30 Sep - Tue 27 Oct 2026).

SYNTHETIC DATA: every person, company, product and number here is made up.

What it adds: 42 requests across the 5 countries (new customers, vendors and
products, plus some customer orders), with their approvals, audit trail, emails
to the requester, and the partner/product/order rows the app keeps.

Assumptions:
- Request mix per country follows setup_requests.py (per month about 3 customer,
  1 vendor and 2 item requests), plus 1-2 customer orders per country.
- With the app, approvals take hours to about 2 days, not ~18 days. Approvers
  work in parallel and only act 8 am - 7 pm, Monday to Friday.
- Bank details and credit terms come in through the app's secure web form,
  never by email. So every customer/vendor request waits for that form first.
- Medical-sounding products also need the regulatory approver. We use the
  same word list as the app (ingest.server.ts).
- Times are Singapore time, saved in UTC the way the app saves them.
- Status mix is chosen by hand in the tables below: most requests are done,
  some wait for approvers, a few wait for the requester, a few were rejected.

Every fake row is tagged, so it can be removed again:
- fake people use @demo.example addresses (".example" is reserved, never real)
- request thread ids start with "demo-"; partner, product and order ids too
- bank account numbers look like DEMO-0000-1001

Run from the repo folder:
    python analytics/src/mock_usage.py                 add the demo rows
    python analytics/src/mock_usage.py --undo          remove them again
    python analytics/src/mock_usage.py --db PATH       use another database file
Running it twice does not duplicate anything: it removes old demo rows first.
"""

import argparse
import json
import random
import re
import sqlite3
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[2]
DEFAULT_DB = REPO / ".datagent.db"
CUSTOMERS_FILE = REPO / "analytics" / "data" / "synthetic" / "customers.csv"

rng = random.Random(2026)  # fixed seed, so every run gives the same data

DEMO_DOMAIN = "@demo.example"
GO_LIVE = datetime(2026, 9, 30)            # Wednesday, Singapore time
DATA_END = datetime(2026, 10, 27, 12, 0)   # Tuesday noon, Singapore time
SGT_OFFSET = timedelta(hours=8)            # Singapore time = UTC + 8 hours

# ---------------------------------------------------------------------------
# People (all fake)

# Who asks: a sales person (customers, orders) and a product/procurement person
# (vendors, products) in each country.
SALES = {
    "Singapore": ("Amy Tan", "sales executive, SPD Singapore"),
    "Malaysia": ("Nurul Huda", "sales executive, SPD Malaysia"),
    "Thailand": ("Ploy Srisuk", "sales executive, QTS Thailand"),
    "Indonesia": ("Rina Wijaya", "sales executive, SPD Indonesia"),
    "Vietnam": ("Linh Tran", "sales executive, QTG Vietnam"),
}
OPS = {
    "Singapore": ("Daniel Koh", "product manager, QTG Singapore"),
    "Malaysia": ("Arif Rahman", "procurement officer, SPD Malaysia"),
    "Thailand": ("Nattapong Chai", "procurement officer, QTS Thailand"),
    "Indonesia": ("Budi Santoso", "product specialist, SPD Indonesia"),
    "Vietnam": ("Quang Pham", "procurement officer, QTG Vietnam"),
}

# Who approves: one business approver per country, plus a regulatory approver
# for medical products. Two quirks of the app's request page:
# - it adds "(IT)" to any approver whose name contains the letters "it",
#   so these names avoid them;
# - it adds "(regulatory)" only when the name contains that word.
APPROVER = {
    "Singapore": ("Wei Jie Lim", "commercial manager, Singapore & Malaysia"),
    "Malaysia": ("Wei Jie Lim", "commercial manager, Singapore & Malaysia"),
    "Thailand": ("Somchai Wongsakul", "country manager, Thailand"),
    "Indonesia": ("Hendra Gunawan", "commercial manager, Indonesia & Vietnam"),
    "Vietnam": ("Hendra Gunawan", "commercial manager, Indonesia & Vietnam"),
}
REGULATORY = ("Farah Aziz (regulatory)", "quality & regulatory affairs lead")

# ---------------------------------------------------------------------------
# What was requested (all fictional). Status is chosen by hand.

# (country, customer name, credit terms, status)
CUSTOMERS = [
    ("Singapore", "Marina Crest Medical Centre", "NET45", "CREATED_IN_MDM"),
    ("Singapore", "Tampines Vale Family Clinic", "NET30", "CREATED_IN_MDM"),
    ("Singapore", "Helix Point Molecular Lab", "NET30", "PENDING_APPROVAL"),
    ("Singapore", "Kingsway Univ. Hospital", "NET60", "REJECTED"),  # on purpose: C10002 in customers.csv
    ("Malaysia", "Teratai Biru Specialist Centre", "NET45", "CREATED_IN_MDM"),
    ("Malaysia", "Cahaya Seri Diagnostics Laboratory", "NET30", "CREATED_IN_MDM"),
    ("Malaysia", "Klinik Pakar Delima", "NET60", "REJECTED"),
    ("Malaysia", "Bukit Jalil Medical Supplies Sdn Bhd", "NET30", "IN_PROGRESS"),
    ("Thailand", "Ruam Jai Women's Hospital", "NET45", "CREATED_IN_MDM"),
    ("Thailand", "Kaew Kao Medical Lab Co., Ltd.", "NET30", "CREATED_IN_MDM"),
    ("Thailand", "Ban Rak Polyclinic", "NET30", "IN_PROGRESS"),
    ("Indonesia", "Teluk Biru General Hospital", "NET60", "CREATED_IN_MDM"),
    ("Indonesia", "Cendana Clinical Lab", "NET30", "CREATED_IN_MDM"),
    ("Indonesia", "Mawar Sari Family Clinic", "NET30", "PENDING_APPROVAL"),
    ("Vietnam", "Minh Chau General Hospital", "NET60", "CREATED_IN_MDM"),
    ("Vietnam", "Thien Phuc Diagnostics Laboratory", "NET30", "CREATED_IN_MDM"),
    ("Vietnam", "Mekong Delta Medical Supplies", "NET30", "CREATED_IN_MDM"),
]

# (country, vendor name, country of origin, credit terms, status, request reason)
VENDORS = [
    ("Singapore", "Alpenmark Diagnostics GmbH", "Germany", "NET60", "CREATED_IN_MDM",
     "New principal for IVD reagents; distribution agreement signed"),
    ("Malaysia", "Tropika Cold Chain Logistics Sdn Bhd", "Malaysia", "NET30", "CREATED_IN_MDM",
     "Cold-chain courier needed for reagent deliveries"),
    ("Thailand", "Hoshimura Lab Instruments K.K.", "Japan", "NET45", "PENDING_APPROVAL",
     "New principal for benchtop analysers"),
    ("Indonesia", "PT Lintas Dingin Logistik", "Indonesia", "NET30", "CREATED_IN_MDM",
     "Second cold-chain courier for outer islands"),
    ("Indonesia", "PT Sinar Medika Supplies", "Indonesia", "NET30", "REJECTED",
     "Second source for lab consumables after supply delays"),
    ("Vietnam", "Hanbit Bioreagents Co., Ltd.", "South Korea", "NET60", "IN_PROGRESS",
     "New principal for rapid test kits"),
]

# (country, item code, product name, status)
PRODUCTS = [
    ("Singapore", "RG-2041", "Dengue NS1 Antigen Rapid Test Kit, 25 tests", "CREATED_IN_MDM"),
    ("Singapore", "EQ-3105", "Benchtop Haematology Analyser HX-300", "CREATED_IN_MDM"),
    ("Singapore", "EQ-3108", "Ultra-Low Temperature Freezer UF-86", "CREATED_IN_MDM"),
    ("Malaysia", "RG-2046", "HbA1c Reagent Cartridge, 10-pack", "CREATED_IN_MDM"),
    ("Malaysia", "LS-4112", "Nitrile Examination Gloves, box of 100", "CREATED_IN_MDM"),
    ("Thailand", "RG-2052", "CRP Immunoassay Reagent Kit, 100 tests", "CREATED_IN_MDM"),
    ("Thailand", "RG-2055", "Blood Glucose Test Strips, 50-pack", "REJECTED"),
    ("Indonesia", "EQ-3110", "Refrigerated Centrifuge RC-24", "CREATED_IN_MDM"),
    ("Indonesia", "LS-4118", "Sterile Pipette Tips 200 uL, rack of 96", "PENDING_APPROVAL"),
    ("Vietnam", "RG-2060", "Malaria Pf/Pv Antigen Rapid Test Kit", "CREATED_IN_MDM"),
    ("Vietnam", "LS-4125", "Cryogenic Storage Vials 2 mL, pack of 500", "PENDING_APPROVAL"),
]

# (country, existing customer from customers.csv, product A/B/C, quantity, status)
ORDERS = [
    ("Singapore", "Harbourview General Hospital", "A", 60, "CREATED_IN_MDM"),
    ("Singapore", "Lionsgate Diagnostics Laboratory", "C", 40, "PENDING_APPROVAL"),
    ("Malaysia", "Seri Permata General Hospital", "B", 2, "CREATED_IN_MDM"),
    ("Thailand", "Rattana General Hospital", "A", 80, "CREATED_IN_MDM"),
    ("Indonesia", "Nusantara University Hospital", "A", 120, "CREATED_IN_MDM"),
    ("Indonesia", "Garuda Diagnostics Laboratory", "C", 30, "CREATED_IN_MDM"),
    ("Vietnam", "Hoa Mai General Hospital", "B", 1, "CREATED_IN_MDM"),
    ("Vietnam", "Sao Viet Diagnostics Laboratory", "A", 50, "PENDING_APPROVAL"),
]

# Why the rejected requests were rejected (key = name in the tables above).
REJECTION_REASONS = {
    "Kingsway Univ. Hospital": "Already in SAP as C10002 Kingsway University Hospital. "
                               "Please extend the existing record instead of opening a new one.",
    "Klinik Pakar Delima": "NET60 is above the limit for a new clinic. Please resubmit with NET30 or PREPAID.",
    "PT Sinar Medika Supplies": "No ISO 13485 certificate on file yet. Resubmit once Quality has qualified this supplier.",
    "Blood Glucose Test Strips, 50-pack": "This pack size is not registered with the Thai FDA yet, so we cannot sell it. "
                                          "Resubmit once registration is approved.",
}

CUSTOMER_REASONS = [
    "Won hospital tender; first PO expected next month",
    "Customer moving from another distributor; account needed before first order",
    "New lab opening; wants a reagent supply contract",
    "Clinic group expanding; asked for a quotation and an account",
]
PRODUCT_REASONS = [
    "Customer tender requires this item",
    "Replaces a discontinued item",
    "New item from an existing principal",
    "Requested by several hospital customers",
]
ORDER_REASONS = ["Customer PO received", "Monthly standing order", "Customer PO received by email"]

CONTACTS = {
    "Singapore": ["Rachel Ong", "Kelvin Goh", "Shirley Chua"],
    "Malaysia": ["Aishah Karim", "Kumar Pillai", "Mei Ling Chong"],
    "Thailand": ["Siriporn Kaew", "Anan Boonmee", "Malee Thongdee"],
    "Indonesia": ["Wulan Sari", "Agus Setiawan", "Putri Halim"],
    "Vietnam": ["Nguyen Thu Ha", "Le Van Duc", "Pham Mai Anh"],
}
CITY = {"Singapore": "Singapore", "Malaysia": "Kuala Lumpur", "Thailand": "Bangkok",
        "Indonesia": "Jakarta", "Vietnam": "Ho Chi Minh City"}
DIAL_CODE = {"Singapore": "+65", "Malaysia": "+60", "Thailand": "+66", "Indonesia": "+62", "Vietnam": "+84"}
COUNTRY_CODE = {"Singapore": "SG", "Malaysia": "MY", "Thailand": "TH", "Indonesia": "ID", "Vietnam": "VN"}

# Names Mark uses in his recorded test flows (to_test.md). Ours must not look
# like these, or the app's duplicate check would block his own demo.
MARK_TEST_NAMES = [
    "Vietnam Trading Co (Công ty Thương mại Việt Nam)", "Vietnam Trading Co", "Saigon Logistics",
    "Hanoi Electronics", "Pho Spice Mix", "MedicalScanner V2", "Lab Consumable Set", "Spare Screw", "Foo Corp",
]

# Same word list the app uses to send a product to the regulatory approver.
MEDICAL_WORDS = re.compile(
    r"lab(oratory)?|consum|reagent|sample|tube|swab|serum|plasma|assay|kit|steril|medical|clinical|diagnos"
    r"|cultur|pipette|needle|vaccine|infection|blood|tissue|molecul|dna|rna|antibod|vial|drug|pharma|biotech"
    r"|health|hospital|patient|specimen|chemistry|hemat|immun|microbio|patholog|histolog|cytolog|endotoxin|ivd",
    re.IGNORECASE,
)

# All demo rows that this script owns (used by --undo).
DEMO_REQUEST_IDS = f"SELECT id FROM requests WHERE threadId LIKE 'demo-%' AND requesterEmail LIKE '%{DEMO_DOMAIN}'"
DEMO_USER_IDS = f"SELECT id FROM users WHERE email LIKE '%{DEMO_DOMAIN}'"
NEEDED_TABLES = ["users", "requests", "request_approvals", "audit_events", "emails", "request_links",
                 "api_requests", "request_bonus_values", "business_partners", "products", "orders",
                 "requester_approvers"]


# ---------------------------------------------------------------------------
# Small helpers

def email_of(name):
    """'Farah Aziz (regulatory)' -> 'farah.aziz@demo.example'"""
    plain = re.sub(r"\(.*?\)", "", name).strip().lower()
    return plain.replace(" ", ".") + DEMO_DOMAIN


def new_id():
    """A random-looking id (uuid4) that still comes from our fixed seed."""
    return str(uuid.UUID(int=rng.getrandbits(128), version=4))


def iso(t):
    """Singapore time -> the app's UTC text format, e.g. 2026-10-05T02:13:00.000Z"""
    return (t - SGT_OFFSET).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def random_office_time(first_day, last_day):
    """A random time between 9 am and 6 pm on a weekday between two dates."""
    while True:
        day = first_day + timedelta(days=rng.randint(0, (last_day - first_day).days))
        if day.weekday() < 5:  # Monday = 0 ... Friday = 4
            return day.replace(hour=rng.randint(9, 17), minute=rng.randint(0, 59), second=rng.randint(0, 59))


def office_hours(t):
    """Move a time outside 8 am - 7 pm, Monday to Friday, to the next working morning."""
    moved = False
    if t.hour >= 19:
        t = (t + timedelta(days=1)).replace(hour=8, minute=0)
        moved = True
    elif t.hour < 8:
        t = t.replace(hour=8, minute=0)
        moved = True
    while t.weekday() >= 5:  # Saturday or Sunday
        t = (t + timedelta(days=1)).replace(hour=8, minute=0)
        moved = True
    if moved:
        t += timedelta(minutes=rng.randint(5, 55))
    return t


def hours_later(t, low, high, most_likely):
    """t plus a random number of hours (triangular distribution), in office hours."""
    return office_hours(t + timedelta(hours=rng.triangular(low, high, most_likely)))


def wire(request_id, status, custom_data):
    """The 'mock SAP B1' message, in the app's exact template (validation.ts)."""
    custom = json.dumps(custom_data, separators=(",", ":"), ensure_ascii=False)
    return '{"requestId":"' + request_id + '","processStatus":"' + status + '","customData":"' + custom + '"}'


# Copy of the app's duplicate rule (validation.ts, isNameSimilar).
def clean_name(name):
    s = re.sub(r"\([^)]*\)", " ", name).lower()
    s = re.sub(r"\bcompany\b", "co", s)
    s = re.sub(r"\bcorporation\b", "corp", s)
    s = re.sub(r"\blimited\b", "ltd", s)
    s = re.sub(r"\bincorporated\b", "inc", s)
    return re.sub(r"[^a-z0-9]", "", s)


def levenshtein(a, b):
    """Fewest single-letter edits (insert, delete, swap) to turn a into b."""
    previous = list(range(len(b) + 1))
    for i, letter_a in enumerate(a, start=1):
        current = [i]
        for j, letter_b in enumerate(b, start=1):
            cost = 0 if letter_a == letter_b else 1
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost))
        previous = current
    return previous[-1]


def is_name_similar(name_a, name_b):
    a, b = clean_name(name_a), clean_name(name_b)
    if not a or not b:
        return False
    if a == b:
        return True
    distance = levenshtein(a, b)
    if distance <= 2 and min(len(a), len(b)) >= 4:
        return True
    return distance / max(len(a), len(b)) <= 0.25


# ---------------------------------------------------------------------------
# Checks, undo

def check_tables(db):
    found = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    missing = [t for t in NEEDED_TABLES if t not in found]
    if missing:
        raise SystemExit(f"Stopped: tables {missing} are missing. Start the DataGent app once so it creates them.")


def check_names(db):
    """Stop if any of our names would trip the app's duplicate check on real rows."""
    theirs = MARK_TEST_NAMES + [row[0] for row in db.execute(
        "SELECT name FROM business_partners WHERE id NOT LIKE 'demo-%' "
        "UNION ALL SELECT name FROM products WHERE id NOT LIKE 'demo-%'")]
    ours = [c[1] for c in CUSTOMERS] + [v[1] for v in VENDORS] + [p[2] for p in PRODUCTS]
    for our_name in ours:
        for their_name in theirs:
            if is_name_similar(our_name, their_name):
                raise SystemExit(f"Stopped: '{our_name}' looks like existing '{their_name}'. Rename it.")
    their_codes = {row[0] for row in db.execute("SELECT code FROM products WHERE id NOT LIKE 'demo-%'")}
    for _, code, _, _ in PRODUCTS:
        if code in their_codes:
            raise SystemExit(f"Stopped: product code {code} already exists. Pick another code.")


def undo(db):
    """Delete every demo row (and only demo rows). Returns how many were deleted."""
    removed = 0
    for table in ["request_approvals", "audit_events", "emails", "request_links", "api_requests",
                  "request_bonus_values"]:
        removed += db.execute(f"DELETE FROM {table} WHERE requestId IN ({DEMO_REQUEST_IDS})").rowcount
    removed += db.execute(f"DELETE FROM requests WHERE id IN ({DEMO_REQUEST_IDS})").rowcount
    for table in ["business_partners", "products", "orders"]:
        removed += db.execute(f"DELETE FROM {table} WHERE id LIKE 'demo-%'").rowcount
    removed += db.execute(f"DELETE FROM requester_approvers WHERE requesterUserId IN ({DEMO_USER_IDS}) "
                          f"OR approverUserId IN ({DEMO_USER_IDS})").rowcount
    removed += db.execute(f"DELETE FROM users WHERE email LIKE '%{DEMO_DOMAIN}'").rowcount
    return removed


# ---------------------------------------------------------------------------
# Making up one request's history

def simulate(status, approvers, needs_web_form):
    """Make up when each step happened.

    Returns (submitted, form_time, decisions). form_time is when the requester
    filled bank details and credit terms in the web form (None if not done).
    decisions is a list of (approver email, "APPROVED"/"REJECTED", time).
    """
    if status in ("PENDING_APPROVAL", "IN_PROGRESS"):   # still open: sent in the last few days
        submitted = random_office_time(datetime(2026, 10, 23), datetime(2026, 10, 26))
    else:                                               # finished: sent any time before
        submitted = random_office_time(GO_LIVE, datetime(2026, 10, 22))

    ready = submitted + timedelta(minutes=1)            # when approvers are asked
    form_time = None
    if needs_web_form:
        if status == "IN_PROGRESS":
            return submitted, None, []                  # requester has not filled the form yet
        form_time = hours_later(submitted, 0.3, 12, 1)
        form_time = min(form_time, DATA_END - timedelta(hours=1))
        ready = form_time

    # Approvers act on their own, in parallel: from 1 hour to about a day and a half.
    times = {approver: hours_later(ready, 1, 30, 5) for approver in approvers}
    last = approvers[-1]
    decisions = []
    if status == "CREATED_IN_MDM":
        decisions = [(a, "APPROVED", t) for a, t in times.items()]
    elif status == "REJECTED":                          # the last approver rejects
        decisions = [(a, "APPROVED", t) for a, t in times.items() if a != last and t < times[last]]
        decisions.append((last, "REJECTED", times[last]))
    elif status == "PENDING_APPROVAL":                  # the last approver has not acted yet
        decisions = [(a, "APPROVED", t) for a, t in times.items() if a != last and t < DATA_END]
    decisions.sort(key=lambda d: d[2])
    return submitted, form_time, decisions


def add_request(db, r):
    """Insert one request with its link, audit trail, approvals and emails.

    r is a dict with the request's facts (see the add_* functions below).
    Returns hours from request to record created (None if not created).
    """
    submitted, form_time, decisions = r["submitted"], r["form_time"], r["decisions"]
    requester = r["requester"]
    payload = dict(r["payload"])
    if r["needs_web_form"] and form_time is None:       # bank details not given yet
        payload["creditTerms"] = None
        payload["bankAccountNumber"] = None
    payload["approvers"] = r["approvers"]

    rejection = REJECTION_REASONS[r["name"]] if r["status"] == "REJECTED" else None
    regulatory = "N/A"
    if r["approval_type"] == "REGULATORY":
        regulatory = {"CREATED_IN_MDM": "APPROVED", "REJECTED": "REJECTED"}.get(r["status"], "PENDING")
    last_time = max([submitted] + ([form_time] if form_time else []) + [d[2] for d in decisions])

    db.execute(
        "INSERT INTO requests (id, threadId, type, bpClass, requesterEmail, status, payload, needsItConfig,"
        " approvalType, qualityApproved, regulatoryApproved, requestReason, bonusText, decidedBy, decisionNote,"
        " token, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,0,?,'N/A',?,?,NULL,?,?,?,?,?)",
        (r["id"], r["thread"], r["type"], r.get("bp_class"), requester, r["status"],
         json.dumps(payload, ensure_ascii=False), r["approval_type"], regulatory, r["reason"],
         decisions[-1][0] if decisions else None, rejection, new_id(), iso(submitted), iso(last_time)))
    db.execute("INSERT INTO request_links (requestId, email, secret, canApprove, createdAt) VALUES (?,?,?,0,?)",
               (r["id"], requester, new_id(), iso(submitted)))

    # Audit trail and emails, in the same words the app itself writes.
    events = [(submitted, requester, "SUBMITTED", r["ingest_detail"])]
    emails = [(submitted + timedelta(minutes=1), requester, f"Re: New {r['what']}")]
    if form_time:
        masked = "*" * (len(payload["bankAccountNumber"]) - 4) + payload["bankAccountNumber"][-4:]
        events.append((form_time, requester, "SUBMITTED",
                       f"Requester submitted Bank Account Number ({masked}). Request sent for approval."))
    if r["status"] != "IN_PROGRESS":
        review = "Regulatory" if r["approval_type"] == "REGULATORY" else "Quality"
        asked = form_time or submitted + timedelta(minutes=1)
        for approver in r["approvers"]:
            emails.append((asked, approver, f"Approval needed: {review} review — New {r['what']}"))
    for approver, decision, when in decisions:
        db.execute("INSERT INTO request_approvals (requestId, approverEmail, decision, reason, decidedAt)"
                   " VALUES (?,?,?,?,?)", (r["id"], approver, decision, rejection if decision == "REJECTED" else None,
                                          iso(when)))
        events.append((when, approver, decision, rejection if decision == "REJECTED" else None))
        emails.append((when + timedelta(minutes=1), requester, f"Update on your request {r['id'][:8]} — {decision}"))

    for seq, (when, actor, action, detail) in enumerate(sorted(events, key=lambda e: e[0]), start=1):
        db.execute("INSERT INTO audit_events (requestId, seq, actor, action, detail, createdAt) VALUES (?,?,?,?,?,?)",
                   (r["id"], seq, actor, action, detail, iso(when)))
    for when, to, subject in emails:
        db.execute("INSERT INTO emails (id, requestId, toEmail, subject, body, createdAt) VALUES (?,?,?,?,?,?)",
                   ("demo-" + new_id(), r["id"], to, subject, f"SYNTHETIC demo email (no real message sent). {subject}",
                    iso(when)))

    if r["status"] != "CREATED_IN_MDM":
        return None
    done = decisions[-1][2]
    custom = {"decidedBy": decisions[-1][0], "mockedSapB1": "true"}
    db.execute("INSERT INTO api_requests (id, requestId, content, createdAt) VALUES (?,?,?,?)",
               ("demo-" + new_id(), r["id"], wire(r["id"], "CREATED_IN_MDM", custom), iso(done)))
    return (done - submitted).total_seconds() / 3600


# ---------------------------------------------------------------------------
# One function per request type

def base_request(number, country, status, requester, approval_type, needs_web_form):
    """The facts every request has, including its made-up timeline."""
    approvers = [email_of(APPROVER[country][0])]
    if approval_type == "REGULATORY":
        approvers.append(email_of(REGULATORY[0]))
    submitted, form_time, decisions = simulate(status, approvers, needs_web_form)
    return {"id": new_id(), "thread": f"demo-{number:03d}", "status": status, "requester": email_of(requester),
            "approval_type": approval_type, "approvers": approvers, "needs_web_form": needs_web_form,
            "submitted": submitted, "form_time": form_time, "decisions": decisions}


def add_partner(db, number, country, name, partner_class, origin, terms, status, reason):
    """A new customer or vendor ('business partner' in the app)."""
    person = SALES[country][0] if partner_class == "Customer" else OPS[country][0]
    r = base_request(number, country, status, person, "QUALITY", needs_web_form=True)
    contact = rng.choice(CONTACTS[country])
    slug = re.sub(r"[^a-z0-9]", "", "".join(name.lower().split()[:2]))
    address = f"{rng.randint(1, 200)} Example Road, {CITY[country]}"
    bank = f"DEMO-0000-{1000 + number}"
    r.update({
        "type": "BUSINESS_PARTNER", "bp_class": "CUSTOMER" if partner_class == "Customer" else "VENDOR",
        "name": name, "reason": reason, "what": f"{partner_class.lower()} {name}",
        "ingest_detail": f"Ingested from email {r['thread']} — Request reason: {reason}",
        "payload": {"name": name, "creditTerms": terms, "bankAccountNumber": bank, "contactName": contact,
                    "contactEmail": f"procurement@{slug}.demo.example",
                    "contactPhone": f"{DIAL_CODE[country]} 0000 {1000 + number}", "partnerClass": partner_class,
                    "country": country, "countryOfOrigin": origin, "addresses": address},
    })
    hours = add_request(db, r)

    # The app keeps a business-partner row for every request; "pushed to SAP" once approved.
    process = {"CREATED_IN_MDM": "PUSHED_TO_SAP", "REJECTED": "REJECTED"}.get(status, "PENDING")
    filled = status != "IN_PROGRESS"
    db.execute(
        "INSERT INTO business_partners (id, requestId, processStatus, customData, name, creditTerms,"
        " bankAccountNumber, contactName, contactEmail, contactPhone, partnerClass, country, countryOfOrigin,"
        " countrySynced, addresses, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)",
        (f"demo-bp-{number:03d}", r["id"], process, json.dumps({"note": "SYNTHETIC demo data"}), name,
         terms if filled else "NET30", bank if filled else "", contact, r["payload"]["contactEmail"],
         r["payload"]["contactPhone"], partner_class, country, origin, json.dumps(address), iso(r["submitted"])))
    return r, hours


def add_product(db, number, country, code, name, status):
    approval_type = "REGULATORY" if MEDICAL_WORDS.search(name) else "QUALITY"
    r = base_request(number, country, status, OPS[country][0], approval_type, needs_web_form=False)
    reason = rng.choice(PRODUCT_REASONS)
    r.update({
        "type": "PRODUCT", "name": name, "reason": reason, "what": f"product {name}",
        "ingest_detail": f"Ingested product from email {r['thread']} — Request reason: {reason}"
                         f" — Approval type: {approval_type}",
        "payload": {"code": code, "name": name},
    })
    hours = add_request(db, r)
    # The app saves the item as soon as the email arrives. We skip rejected
    # items, so they do not look like real items.
    if status != "REJECTED":
        db.execute("INSERT INTO products (id, code, name, createdAt) VALUES (?,?,?,?)",
                   (f"demo-product-{number:03d}", code, name, iso(r["submitted"])))
    return r, hours


def add_order(db, number, country, customer, product, qty, status, card_codes):
    """A purchase order from an existing customer (card code from customers.csv)."""
    r = base_request(number, country, status, SALES[country][0], "QUALITY", needs_web_form=False)
    reason = rng.choice(ORDER_REASONS)
    order_number = f"PO-{COUNTRY_CODE[country]}-{rng.randint(1000, 9999)}"
    delivery = r["submitted"].date() + timedelta(days=rng.randint(7, 14))
    payment = delivery + timedelta(days=30)
    r.update({
        "type": "ORDER", "name": order_number, "reason": reason, "what": f"order {order_number}",
        "ingest_detail": f"Ingested order from email {r['thread']} — Request reason: {reason}"
                         f" — Approval type: QUALITY",
        "payload": {"orderNumber": order_number, "productCode": product, "partnerName": customer,
                    "partnerId": card_codes[customer], "qty": qty, "paymentDate": str(payment),
                    "deliveryDate": str(delivery)},
    })
    hours = add_request(db, r)
    db.execute("INSERT INTO orders (id, orderNumber, productCode, partnerId, qty, paymentDate, deliveryDate,"
               " createdAt) VALUES (?,?,?,?,?,?,?,?)",
               (f"demo-order-{number:03d}", order_number, product, card_codes[customer], qty, str(payment),
                str(delivery), iso(r["submitted"])))
    return r, hours


def add_demo_usage(db):
    """Insert the fake people and all requests. Returns one summary row per request."""
    people = [(name, title, "demo-requester") for name, title in list(SALES.values()) + list(OPS.values())]
    people += [(name, title, "demo-approver") for name, title in set(APPROVER.values())]
    people.append((REGULATORY[0], REGULATORY[1], "demo-regulatory"))
    # Roles start with "demo-" on purpose: the app adds EVERY user with the role
    # "approver" or "regulatory" to new requests, which would break Mark's flows.
    for name, title, role in sorted(people):
        db.execute("INSERT INTO users (id, email, roles, name, title, createdAt) VALUES (?,?,?,?,?,?)",
                   ("demo-" + new_id(), email_of(name), json.dumps([role]), name, title,
                    iso(GO_LIVE - timedelta(days=2))))

    customers = pd.read_csv(CUSTOMERS_FILE)
    card_codes = dict(zip(customers["card_name"], customers["card_code"]))

    summary = []
    number = 0
    for country, name, terms, status in CUSTOMERS:
        number += 1
        r, hours = add_partner(db, number, country, name, "Customer", country, terms, status,
                               rng.choice(CUSTOMER_REASONS))
        summary.append({"type": "customer", "status": status, "hours": hours})
    for country, name, origin, terms, status, reason in VENDORS:
        number += 1
        r, hours = add_partner(db, number, country, name, "Supplier", origin, terms, status, reason)
        summary.append({"type": "vendor", "status": status, "hours": hours})
    for country, code, name, status in PRODUCTS:
        number += 1
        r, hours = add_product(db, number, country, code, name, status)
        summary.append({"type": f"product ({r['approval_type'].lower()})", "status": status, "hours": hours})
    for country, customer, product, qty, status in ORDERS:
        number += 1
        r, hours = add_order(db, number, country, customer, product, qty, status, card_codes)
        summary.append({"type": "order", "status": status, "hours": hours})
    return pd.DataFrame(summary)


def main():
    parser = argparse.ArgumentParser(description="Add (or remove) fake usage data in DataGent's database.")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="path to .datagent.db (default: repo root)")
    parser.add_argument("--undo", action="store_true", help="only remove the demo rows")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():  # sqlite would silently create an empty file
        raise SystemExit(f"No database at {db_path}. Start the DataGent app once, or pass --db PATH.")
    db = sqlite3.connect(db_path, timeout=10)
    check_tables(db)

    removed = undo(db)  # start clean, so re-running never duplicates rows
    if args.undo:
        db.commit()
        db.close()
        print(f"Removed {removed} demo rows from {db_path}.")
        return

    check_names(db)
    summary = add_demo_usage(db)
    db.commit()  # nothing is saved unless every insert worked
    db.close()

    print(f"SYNTHETIC demo usage written to {db_path} (removed {removed} old demo rows first).")
    print(pd.crosstab(summary["type"], summary["status"], margins=True, margins_name="total").to_string())
    done = summary["hours"].dropna()
    print(f"Request to record created: median {done.median():.0f} hours, longest {done.max():.0f} hours "
          f"(old email process: ~18 days).")


if __name__ == "__main__":
    main()
