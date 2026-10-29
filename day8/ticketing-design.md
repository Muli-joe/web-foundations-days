# TicketHub Design Document

TicketHub is a website that sells tickets for concerts and events. This document follows the six-part framework: requirements, estimates, API, data model, architecture and trade-offs.

## 1. Requirements

### Functional requirements
- Users can register and log in.
- Users can browse upcoming events and view the details of one event.
- Users can view the seats for an event and see which are available.
- Users can **hold** chosen seats for a short time (10 minutes) while they pay.
- Users can pay for held seats and receive their tickets.
- Users can view the tickets they have bought.

### Non-functional requirements
- **Speed:** browsing pages load in under 1 second, and the seat map in about 1 to 2 seconds, even during a big sale.
- **Correctness:** a seat is never sold to two people. A user is never charged without getting a ticket, and never gets a ticket without paying.
- **Fairness:** during a big sale, people are served in the order they arrived, and bots cannot jump the line.
- **Availability:** the site stays up during a popular sale, which is when it matters most.
- **Security:** passwords are hashed, and card details go to a payment provider, never into our own database.

## 2. Estimates

### Assumptions
- 2 million registered users
- Normal day: 50,000 visitors, each viewing 10 pages, and 5,000 tickets sold
- Big sale: 200,000 people try to buy 20,000 seats within the first 10 minutes (600 seconds)
- 1 day is approximated as 100,000 seconds
- Peak on a normal day is 5 times the average

### Normal day
- Page views: 50,000 x 10 = 500,000 per day, so 500,000 / 100,000 = about **5 per second** (peak about 25 per second)
- Tickets sold: 5,000 per day, so 5,000 / 100,000 = about **0.05 per second**, or one sale every 20 seconds

### Big sale
- People arriving: 200,000 / 600 seconds = about **333 people per second**
- Page views: 200,000 x 10 = 2,000,000 in 10 minutes, so about **3,300 per second**
- Seats: 20,000 in 600 seconds = about **33 purchases per second** if they sell out in 10 minutes
- Competition: 200,000 people for 20,000 seats, so about 10 people for every seat

### Comparison

| Measure | Normal day | Big sale | Difference |
|---|---|---|---|
| Page views per second | about 5 (peak 25) | about 3,300 | about 600 to 700 times higher |
| Tickets sold per second | about 0.05 | about 33 | about 600 times higher |
| Seats being fought over | spread out | the same 20,000 seats | heavy contention |

A big sale is hundreds of times busier than a normal day, and everyone wants the same rows at the same moment. The design must be built for the sale, not the normal day. Storage is small: 5,000 orders a day is only about 1.8 million orders a year.

## 3. API

All endpoints use HTTPS and JSON. Endpoints marked "login" need a valid token.

| Method and path | Purpose | Success | Errors |
|---|---|---|---|
| `GET /events` | List upcoming events (supports `?page=`) | 200 | 400 |
| `GET /events/{id}` | Details of one event | 200 | 404 |
| `GET /events/{id}/seats` | Seat map with availability | 200 | 404 |
| `POST /events/{id}/holds` (login) | Hold seats for 10 minutes | 201 | 400, 401, 404, **409** (seat taken), 429 |
| `DELETE /holds/{id}` (login) | Release a hold early | 204 | 401, 404 |
| `POST /orders` (login) | Pay for a hold and get tickets | 201 | 400, 401, **410** (hold expired), 402 (payment failed) |
| `GET /users/me/tickets` (login) | View my tickets | 200 | 401 |

Example request to hold seats:

```json
POST /events/42/holds
{ "seat_ids": [1051, 1052] }
```

Example request to pay:

```json
POST /orders
{ "hold_id": 9001, "payment_token": "tok_abc123", "idempotency_key": "f3a9-..." }
```

The `idempotency_key` means that if the user's phone retries the request, they are not charged twice.

## 4. Data model

### Tables

```sql
users   (id PK, name, email UNIQUE NOT NULL, password_hash NOT NULL)

events  (id PK, name NOT NULL, venue, starts_at, on_sale_at)

seats   (id PK,
         event_id FK -> events.id NOT NULL,
         section, row_label, seat_number, price,
         status NOT NULL DEFAULT 'available',   -- available / held / sold
         held_by FK -> users.id NULL,
         hold_expires_at NULL,
         UNIQUE (event_id, section, row_label, seat_number))

orders  (id PK,
         user_id FK -> users.id NOT NULL,
         status NOT NULL,                       -- paid / failed
         total_amount, payment_ref, idempotency_key UNIQUE,
         created_at)

tickets (id PK,
         order_id FK -> orders.id NOT NULL,
         seat_id FK -> seats.id NOT NULL UNIQUE)   -- a seat can be on only one ticket
```

### Relationships
- **users to orders:** one-to-many. A user can have many orders, and each order belongs to one user.
- **events to seats:** one-to-many. An event has many seats, and each seat belongs to one event.
- **orders to tickets:** one-to-many. An order can contain several tickets (seats).
- **seats to tickets:** one-to-one at most. A seat can be on at most one ticket, which is enforced by the `UNIQUE` constraint.
- **users to events:** many-to-many, through orders, tickets and seats.

## 5. How double-booking is prevented

Two people must never buy the same seat, even if they click at the same millisecond. Three layers protect it.

**Layer 1: atomic hold inside a transaction.** Holding seats is a single conditional `UPDATE` that only succeeds if the seat is still free:

```sql
BEGIN;
UPDATE seats
SET status = 'held', held_by = :user_id, hold_expires_at = :now_plus_10_min
WHERE id IN (:seat_ids)
  AND event_id = :event_id
  AND (status = 'available'
       OR (status = 'held' AND hold_expires_at < :now));
-- If rows updated = number of seats requested: COMMIT
-- Otherwise: ROLLBACK and return 409 Conflict
```

The database locks each seat row while it updates it. If two users try for the same seat, one update runs first and wins. The second then sees `status = 'held'`, updates zero rows and gets a 409. Because it is all in one transaction, a user gets all the seats they asked for or none of them.

**Layer 2: checked purchase.** When the user pays, a second transaction confirms the hold still belongs to them:

```sql
BEGIN;
UPDATE seats SET status = 'sold'
WHERE id IN (:seat_ids) AND held_by = :user_id
  AND status = 'held' AND hold_expires_at > :now;
-- If rows updated != number of seats: ROLLBACK and return 410 Gone
INSERT INTO orders ...;
INSERT INTO tickets (order_id, seat_id) ...;
COMMIT;
```

**Layer 3: a database constraint as the safety net.** `tickets.seat_id` is `UNIQUE`. Even if there were a bug in the application code, the database itself would refuse to put the same seat on two tickets.

**Holds that are never paid for** expire after 10 minutes. The expiry check in the query makes an expired seat available again straight away, and a background job also resets old holds. If payment fails, the hold is released.

## 6. Architecture

```
                      +--------------+
                      |    Users     |
                      +------+-------+
                             |
                       +-----v-----+
                       |    CDN    |  (images, event pages, JS and CSS)
                       +-----+-----+
                             | (dynamic requests)
                    +--------v---------+
                    |   Waiting room   |  (lets in a limited number at a time)
                    +--------+---------+
                             |
                    +--------v---------+
                    |  Load balancer   |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
        +-----v----+   +-----v----+   +-----v----+
        |   App    |   |   App    |   |   App    |
        |  server  |   |  server  |   |  server  |
        +--+--+--+-+   +----------+   +----------+
           |  |  |
           |  |  +-------------------+
           |  |                      |
     +-----v--+--+            +------v------+
     |   Cache   |            |    Queue    |
     |  (Redis)  |            +------+------+
     +-----------+                   |
           |                  +------v------+      +------------------+
           |                  |   Workers   +----->| Email / e-ticket |
           |                  +-------------+      +------------------+
           |
   +-------v---------+  replicates   +-----------------+
   |  Primary DB     +-------------->|  Read replica   |
   | (holds, orders) |               | (browse events) |
   +-------+---------+               +-----------------+
           |
   +-------v---------+
   | Payment provider|
   |   (external)    |
   +-----------------+
```

### Components
- **CDN:** serves images and static pages from servers near users, so most of the 3,300 requests per second never reach our servers.
- **Waiting room:** lets people into the buying pages a few at a time, in the order they arrived, so the 200,000 people do not hit the database at once and the sale is fair.
- **Load balancer:** spreads requests across the app servers and stops sending traffic to any that fail.
- **App servers:** run the API logic and are stateless, so we can add many more before a big sale.
- **Cache (Redis):** keeps event details and the seat map in memory for a few seconds, and stores rate limits, so the database is asked far less often.
- **Primary database:** the single source of truth for holds, orders and tickets, and the only place where seats are changed, so double-booking checks happen in one place.
- **Read replica:** answers browsing queries so they never slow down the primary.
- **Queue and workers:** send confirmation emails, create e-tickets and clean up expired holds in the background, so a purchase does not wait for them.
- **Payment provider:** an external service that handles card payments, so we never store card details.

### How it survives the big sale
- **Before the sale:** event pages are cached on the CDN and extra app servers are started.
- **During the sale:** the waiting room lets in only as many people as the system can handle, for example 2,000 at a time. Everyone else waits in line and sees their position.
- **Reads are cheap:** the seat map comes from the cache, not the database.
- **Writes are small:** only about 33 purchases per second reach the primary database, which a well-indexed database can handle. Each one touches only a few seat rows.
- **Bots are slowed:** rate limiting (429 responses), a login requirement, and a limit on seats per user stop one person grabbing hundreds of seats.
- **If something fails:** a failed server is removed by the load balancer, and the database changes are in transactions, so a crash never leaves a half-finished sale.

## 7. Trade-offs

1. **Fairness vs convenience (waiting room):** the waiting room makes the sale fair and protects the system, but users have to wait and some will give up. Without it, the site would likely crash, which is worse for everyone.
2. **Speed vs freshness (cached seat map):** caching the seat map for a few seconds keeps the database safe, but a user might click a seat that was just taken. This is acceptable because the database check in the hold step is always correct, and the app simply shows "seat just taken, please choose another" (the 409 error).
3. **Hold time:** a longer hold (say 10 minutes) gives people time to pay, but unpaid holds keep seats out of sale. A shorter hold (say 5 minutes) frees seats sooner but may rush users and cause failed payments. We chose 10 minutes because losing a sale to a rushed checkout is worse than a short delay.
4. **Strong consistency vs scale:** keeping all holds and orders on a single primary database guarantees no double-booking, but the primary becomes a limit on how much we can scale writes. For about 33 writes per second this is fine. It would need rethinking only for a much larger system.
5. **Complexity vs safety:** three layers of protection against double-booking, plus a queue and a waiting room, make the system harder to build and run than a simple site, but a double-sold seat or a crashed sale would cost far more.