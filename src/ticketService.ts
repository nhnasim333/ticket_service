import { Pool, PoolClient } from "pg";

interface TicketPool {
  event_id: string;
  total: number;
  available: number;
}

const pool = new Pool({
  host: "localhost",
  port: 5433,
  database: "tickets",
  user: "postgres",
  password: "postgres",
});

pool.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'issued_tickets_event_id_ticket_number_key'
    ) THEN
      ALTER TABLE issued_tickets
        ADD CONSTRAINT issued_tickets_event_id_ticket_number_key
        UNIQUE (event_id, ticket_number);
    END IF;
  END$$;
`).catch((err) => {
  console.error("Warning: could not ensure UNIQUE constraint:", err.message);
});

export async function purchaseTickets(
  userId: string,
  eventId: string,
  quantity: number,
): Promise<number[]> {
  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    const poolResult = await client.query<TicketPool>(
      "SELECT * FROM ticket_pools WHERE event_id = $1 FOR UPDATE",
      [eventId],
    );

    if (poolResult.rows.length === 0) {
      throw new Error("Event not found");
    }

    const ticketPool = poolResult.rows[0];

    if (!ticketPool || ticketPool.available < quantity) {
      throw new Error("Not enough tickets available");
    }

    const maxResult = await client.query<{ max_num: number | null }>(
      "SELECT MAX(ticket_number) AS max_num FROM issued_tickets WHERE event_id = $1",
      [eventId],
    );
    const currentMax = maxResult.rows[0]?.max_num ?? 0;

    const ticketNumbers: number[] = [];
    const values: string[] = [];
    const params: (string | number)[] = [];

    for (let i = 0; i < quantity; i++) {
      const ticketNumber = currentMax + i + 1;
      ticketNumbers.push(ticketNumber);

      const offset = i * 3;
      values.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
      params.push(eventId, userId, ticketNumber);
    }

    await client.query(
      `INSERT INTO issued_tickets (event_id, user_id, ticket_number) VALUES ${values.join(", ")}`,
      params,
    );

    await client.query(
      "UPDATE ticket_pools SET available = available - $1 WHERE event_id = $2",
      [quantity, eventId],
    );

    await client.query("COMMIT");

    return ticketNumbers;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getPool(): Promise<Pool> {
  return pool;
}
