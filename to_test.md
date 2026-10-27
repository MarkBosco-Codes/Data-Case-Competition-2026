# Test emails to send as requestor (mbprojects2022@gmail.com)

Send each email to the Zoho agent inbox the app polls. Wait ~5-10s for processing, then check `/` and the track link in the reply.

## 1. Business Partner — complete (happy path)
Subject: New customer Vietnam Trading Co
Body:
```
Please create a new customer business partner.
Name: Vietnam Trading Co (Công ty Thương mại Việt Nam)
Partner class: Customer
Country: Vietnam
Country of origin: Vietnam
Contact name: Nguyen Van A
Contact email: contact@vietnamtrading.vn
Contact phone: +84 90 123 4567
Address: 10 Nguyen Hue, District 1, Ho Chi Minh City
Request reason: Onboarding new customer for Q2 sales
```
Expected:
- BP request created with status `IN_PROGRESS` (bank account & credit terms are not in email).
- Requester receives track link to request page.
- Opening track link shows request form for Bank Account Number & Credit Terms dropdown (with explanations).
- Clicking "Submit request" sets status to `PENDING_APPROVAL`, sets `QualityApproved = N/A` & `RegulatoryApproved = N/A` (or `PENDING`), and sends notification emails to approvers.

## 2. Business Partner — missing reason (request reason)
Subject: New supplier Hanoi Electronics
Body:
```
Create supplier Hanoi Electronics in Vietnam.
Name: Hanoi Electronics
Partner class: Supplier
Country: Vietnam
Address: Hanoi
```
Expected: no request created; reply asks for a request reason; processed_emails outcome MISSING_REASON.

## 3. Business Partner — missing details (incl. contact email)
Subject: New customer Saigon Logistics
Body:
```
New customer Saigon Logistics from Vietnam.
Request reason: expand into Vietnamese market
```
Expected: no request; reply lists missing fields (contact name, contact email, contact phone, address, country); outcome MISSING_DETAILS. Note: Bank Account and Credit Terms are not required in email.

## 3b. Follow-up completing missing details (reply to #3 thread)
Reply to the MISSING_DETAILS email:
```
Bank account: VN99887766
Contact name: Tran Thi B
Contact email: info@saigonlogistics.vn
Contact phone: +84 91 234 5678
Address: 5 Le Loi, District 1, Ho Chi Minh City
Country: Vietnam
Request reason: expand into Vietnamese market
```
Expected: new BP request created (PENDING_APPROVAL) with all fields; track link in reply.

## 4. Business Partner — duplicate
Send #1 again with same name/class/country.
Expected: reply "duplicate business partner found"; no new request; outcome DUPLICATE.

## 5. Business Partner — follow-up update to pending request
After #1 is PENDING_APPROVAL, reply to its notification:
```
Re: New customer Vietnam Trading Co
Update bank account to VN00001111 and contact phone to +84 98 888 0000
Request reason: corrected banking details
```
Expected: follow-up merges fields; audit event UPDATED; confirmation reply; if any required field still missing, reply "Still missing: ...".

## 6. Product — complete
Subject: New product Pho Spice Mix
Body:
```
Add product Pho Spice Mix, code PSM.
Request reason: new SKU for Q2 launch
```
Expected: product request created; code stored; PENDING_APPROVAL; approver email subject "Approval needed: New product Pho Spice Mix".

## 7. Product — duplicate code
Send #6 again with same code.
Expected: reply duplicate product; outcome DUPLICATE_PRODUCT.

## 8. Order — complete
Subject: New order for Vietnam Trading Co
Body:
```
Create order ORD-1001 for product PSM, partner Vietnam Trading Co, qty 5, payment date 2026-05-01, delivery 2026-05-10.
Request reason: customer PO received
```
Expected: order request created; partnerId resolved; PENDING_APPROVAL; approver email subject "Approval needed: New order ORD-1001".

## 9. Unknown / unclassifiable
Subject: Hello
Body: `Just checking in.`
Expected: reply asking for a classified request (BP/product/order) + request reason, or field/value pairs; outcome UNKNOWN.

## 10. Follow-up no-op
Reply to a pending request thread with no parseable fields:
```
Re: New product Pho Spice Mix
Any update?
```
Expected: reply telling user to use field/value pairs or send a new email with request reason; outcome FOLLOW_UP_NOOP.

## 11. Cross-type follow-up (no pollution)
With a pending PRODUCT request, reply with BP details:
```
Re: New product Pho Spice Mix
Name: Foo Corp
Bank account: 123
```
Expected: no merge (whitelist); FOLLOW_UP_NOOP reply.

## 12. Approve (approver link)
Open approver's combined link for a PENDING request; click Approve.
Expected: status becomes CREATED_IN_MDM (BP: pushed to SAP mock; product/order: created); requester notified by email; audit APPROVED.

## 12c. Approval types — regulatory auto-flag for medical-sounding products
Subject: New product Lab Consumable Set
Body:
```
Add product Lab Consumable Set, code LCS.
Request reason: importing a lab consumable for the team
```
Expected:
- Approval type = `REGULATORY` automatically (medical/clinical/lab wording).
- Approver email subject: `Approval needed: Regulatory review — New product Lab Consumable Set`.
- Request page badge = `Regulatory approval`; requestor notified.
- Regulatory approver role is `sendtomarkbosco@gmail.com` (`sendtomarkbosco` account is a regulatory approver); for new-field requests IT is additionally required.
- Audit trail includes `Approval type: REGULATORY`.

## 12d. Approval types — quality default for non-medical products
Subject: New product Spare Screw
Body:
```
Add product Spare Screw, code SCR2.
Request reason: non-medical spare part
```
Expected: approval type automatically set to `QUALITY`; approver email subject mentions `Quality review`; request page badge = `Quality approval`.

## 13. Reject (approver link) — reason required
Open approver link; click Reject. Confirm button disabled until a rejection reason is entered. Enter reason e.g. "Wrong contact email" and confirm.
Expected: status REJECTED; requester notified email includes "Rejection reason: Wrong contact email"; audit REJECTED with reason; approvals table shows reason. Attempting reject with empty reason returns REJECTION_REASON_REQUIRED and no status change.

## 14. Cancel (requester link)
Open requester's combined link for a PENDING request; click Cancel request; confirm.
Expected: status CANCELLED; partner status REJECTED; audit CANCELLED; requester notified by email.

## 15. Change request — modify approved BP
After #1 approved (CREATED_IN_MDM), reply:
```
Re: New customer Vietnam Trading Co
Modify contact phone to +84 99 777 8888
Request reason: customer requested phone change
```
Expected: new PENDING request with intent modify + originalRequestId; approver approves -> partner record updated (phone changed), audit.

## 16. Change request — delete approved BP
Reply to approved BP thread:
```
Re: New customer Vietnam Trading Co
Delete this partner
Request reason: duplicate account, to be removed
```
Expected: new PENDING request intent delete; approve -> partner status REJECTED.

## 17. Edge: bad secret
Visit `/r/<valid-id>/not-a-real-secret` and `/r/<uuid>/bad`.
Expected: 404.

## 18. Edge: self-reply skip
Agent's own reply emails should not be reprocessed.
Expected: no duplicate processing; processed_emails marks SELF_REPLY for mailbox sender.

## 19. Edge: empty/whitespace reason
Body with `Request reason:` only or `Request reason:   `.
Expected: treated as missing reason -> MISSING_REASON reply.

## 20. View-only verification
Requester link must show ", view-only" suffix and no Approve/Reject buttons (Cancel allowed while pending). Approver link shows Approve/Reject. Bad secret 404.

## 21. IT approval on new-field requests
Create a BP/PRODUCT/ORDER request that introduces a new bonus field (or triggers needsItConfig). Expect:
- Approver email list includes IT (`vanadite111@gmail.com`) alongside the business approver, each with a single review-and-approve link.
- Approvals table on the magic-link page shows both approvers with `PENDING` status from the start.
- Request stays `PENDING_APPROVAL` after only the business approver approves; it becomes `CREATED_IN_MDM` once IT also approves. IT receives the same notification email.

## 22. UI labels
Request detail page shows "Request reason:" for the requester's reason and "Rejection reason:" for the approver's reason. Index table column shows request reason.
