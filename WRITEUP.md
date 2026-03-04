# Ticket Service - Bug Analysis, Fix & Write-Up

## 1. Bug Identification

### Bug 1 - Overselling (TOCTOU Race Condition)

**Root cause:** The original `purchaseTickets()` performs three critical steps **without any transaction or lock**:

```
Step A: SELECT available FROM ticket_pools          ← read
Step B: if (available < quantity) throw              ← check
Step C: UPDATE ticket_pools SET available = available - N  ← write
```

When hundreds of requests arrive simultaneously, multiple Node.js request handlers are in-flight concurrently. Each one executes Step A at roughly the same time and reads the **same** `available` value (e.g., 1500). They all pass Step B, then all execute Step C - each decrementing from the same starting point. The result is that far more tickets are sold than actually exist.

This is a classic **Time-of-Check-Time-of-Use (TOCTOU)** race condition.

### Bug 2 - Duplicate Ticket Numbers

**Root cause:** Ticket numbers are calculated from the `available` count, which is read at the start of the request. When multiple requests run at the same time, they all read the same `available` value and end up generating the same ticket numbers. The database has no UNIQUE constraint on `(event_id, ticket_number)`, so these duplicates are inserted without any error.

---

## 2. Reproduction

The file `src/reproduce-bugs.ts` fires 200 concurrent HTTP requests (each for 8 tickets = 1,600 total) against EVENT004 which only has 1,500 available. Run it against the **unmodified** codebase:

```bash
docker-compose up -d
npm run seed
npm run dev              # in one terminal
npx ts-node src/reproduce-bugs.ts   # in another terminal
```

Expected output:

- **Overselling**: more than 1,500 tickets are successfully issued
- **Duplicates**: many ticket numbers appear multiple times

---

## 3. The Fix

### 3a. Row-Level Locking with `SELECT ... FOR UPDATE`

The key change wraps the entire purchase operation in a **PostgreSQL transaction** with a **row-level lock**:

```sql
BEGIN;
SELECT * FROM ticket_pools WHERE event_id = $1 FOR UPDATE;
COMMIT;
```

`FOR UPDATE` makes concurrent transactions wait in line to acquire the lock on the same `event_id` row. This serialises purchases for a given event, which eliminates both bugs.

For **overselling**, only one transaction at a time can read and update the `available` count, so the check-then-decrement becomes atomic - no two transactions can see the same stale value.

For **duplicate ticket numbers**, we now query `MAX(ticket_number)` inside the locked transaction instead of computing it from the stale `available` column. Since the lock ensures only one writer proceeds at a time, `MAX` always returns the true latest number.

### 3b. Database-Level UNIQUE Constraint (Defence-in-Depth)

```sql
UNIQUE (event_id, ticket_number)
```

Added to `issued_tickets` so that even if a bug is introduced in the future, the database itself will reject duplicate ticket numbers with a constraint violation.

### 3c. Batch INSERT (Performance)

Instead of N individual INSERT statements (one per ticket), the fix builds a single multi-row INSERT:

```sql
INSERT INTO issued_tickets (event_id, user_id, ticket_number)
VALUES ($1,$2,$3), ($4,$5,$6), ...
```

This reduces round-trips from N to 1.

---

## 4. Tradeoffs

I chose `SELECT ... FOR UPDATE` inside a transaction. It is simple, well-understood, and correctness is easy to reason about. The downside is that it serialises all writes for the same event - under extreme contention, transactions queue up and each one holds the lock while doing the INSERT I/O. For a single-instance service this is perfectly acceptable, and the batch INSERT helps reduce lock hold time.

---

## 5. Bonus — Scaling to Tens of Thousands of Users / Second

For true high-scale (10k+ req/s, multiple service instances), the current `FOR UPDATE` approach becomes a bottleneck because it serialises all purchases for the same event - every request has to wait in line.

To solve this, we can pre-generate ticket rows in the database with a status of `available`. When a user purchases tickets, we use `SELECT ... FOR UPDATE SKIP LOCKED LIMIT $1` to atomically claim rows. The `SKIP LOCKED` clause skips rows that are already locked by other transactions instead of waiting, so multiple purchases can proceed in parallel without blocking each other. This gives near-linear throughput scaling across as many service instances as needed, using only PostgreSQL with full ACID guarantees.
