/**
 * Reproduction script for ticket service bugs.
 *
 * Run against the UNMODIFIED codebase:
 *   1. docker-compose up -d
 *   2. npm run seed
 *   3. npm run dev          (start the server)
 *   4. npx ts-node src/reproduce-bugs.ts
 *
 * Expected output:
 *   - Total tickets sold EXCEEDS the available count  (overselling bug)
 *   - Some ticket numbers appear more than once        (duplicate ticket bug)
 */

import axios from "axios";

const API = "http://localhost:3000";
const EVENT_ID = "EVENT004"; // Comedy Night — 1500 total, 1500 available, 0 sold
const TICKETS_PER_REQUEST = 8;
const CONCURRENT_REQUESTS = 200; // 200 × 8 = 1600, which exceeds the 1500 available

interface PurchaseResponse {
  success: boolean;
  tickets?: number[];
  error?: string;
}

async function main() {
  console.log("=== Ticket Service Bug Reproduction ===\n");
  console.log(
    `Sending ${CONCURRENT_REQUESTS} concurrent requests for ${TICKETS_PER_REQUEST} tickets each`,
  );
  console.log(
    `Total requested: ${CONCURRENT_REQUESTS * TICKETS_PER_REQUEST} tickets`,
  );
  console.log(`Available for ${EVENT_ID}: 1500 tickets\n`);

  // Fire all requests simultaneously to maximise race-condition window
  const promises = Array.from({ length: CONCURRENT_REQUESTS }, (_, i) =>
    axios
      .post<PurchaseResponse>(`${API}/purchase`, {
        userId: `loadtest_user_${i}`,
        eventId: EVENT_ID,
        quantity: TICKETS_PER_REQUEST,
      })
      .then((r) => r.data)
      .catch((err) => {
        if (axios.isAxiosError(err) && err.response) {
          return err.response.data as PurchaseResponse;
        }
        return { success: false, error: String(err) } as PurchaseResponse;
      }),
  );

  const results = await Promise.all(promises);

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  const allTickets = successful.flatMap((r) => r.tickets ?? []);

  console.log(`Successful purchases : ${successful.length}`);
  console.log(`Failed purchases     : ${failed.length}`);
  console.log(`Total tickets issued : ${allTickets.length}`);

  // Bug 1 — Overselling
  const maxAllowed = 1500;
  if (allTickets.length > maxAllowed) {
    console.log(
      `\n BUG 1 — OVERSELLING DETECTED: ${allTickets.length} tickets sold but only ${maxAllowed} were available!`,
    );
  } else {
    console.log(
      `\n No overselling detected (${allTickets.length}/${maxAllowed}). Try increasing CONCURRENT_REQUESTS or re-run.`,
    );
  }

  // Bug 2 — Duplicate ticket numbers
  const ticketCounts = new Map<number, number>();
  for (const t of allTickets) {
    ticketCounts.set(t, (ticketCounts.get(t) ?? 0) + 1);
  }
  const duplicates = [...ticketCounts.entries()].filter(([, c]) => c > 1);

  if (duplicates.length > 0) {
    console.log(
      `\n BUG 2 — DUPLICATE TICKET NUMBERS: ${duplicates.length} ticket numbers were issued to multiple users!`,
    );
    console.log(
      "   Sample duplicates:",
      duplicates.slice(0, 10).map(([n, c]) => `#${n} (×${c})`),
    );
  } else {
    console.log(
      "\n No duplicate ticket numbers detected. Try increasing CONCURRENT_REQUESTS or re-run.",
    );
  }

  console.log("\n=== Reproduction complete ===");
}

main().catch(console.error);
