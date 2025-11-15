// backend/routes/maalin.js
import express from "express";
import { pool } from "../config/db.js"; // ensure this exports a pg Pool

const router = express.Router();

/**
 * POST /api/maalin
 * Manager: Create a new maal_in header (status defaults to 'submitted')
 * Body: { company_id, godown_id, date, supplier_name, source, vehicle_number, notes, created_by }
 */
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      company_id,
      godown_id,
      date,
      supplier_name,
      source,
      vehicle_number,
      notes,
      created_by,
    } = req.body;

    if (!company_id || !godown_id || !supplier_name || !date) {
      return res.status(400).json({ error: "company_id, godown_id, supplier_name and date are required" });
    }

    const result = await client.query(
      `INSERT INTO maal_in
        (id, company_id, godown_id, date, supplier_name, source, vehicle_number, notes, status, created_by, created_at)
       VALUES (uuid_generate_v4(), $1, $2, $3::date, $4, $5, $6, $7, 'submitted', $8, NOW())
       RETURNING *;`,
      [company_id, godown_id, date, supplier_name, source || "kabadiwala", vehicle_number || null, notes || null, created_by || null]
    );

    res.status(201).json({ success: true, maal_in: result.rows[0] });
  } catch (err) {
    console.error("❌ Create MaalIn Error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/maalin/:id/items
 * Manager: Add items to a maal_in (one or multiple)
 * Body: { items: [{ material, weight, rate, amount }, ... ] }
 */
router.post("/:id/items", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { items } = req.body;

    if (!id || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "maal_in id and items array are required" });
    }

    await client.query("BEGIN");

    // Insert each item
    const insertPromises = items.map((it) =>
      client.query(
        `INSERT INTO maal_in_items (id, maal_in_id, material, weight, rate, amount)
         VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5)`,
        [id, it.material, it.weight, it.rate, it.amount]
      )
    );
    await Promise.all(insertPromises);

    // Update total_amount on maal_in
    await client.query(
      `UPDATE maal_in
       SET total_amount = COALESCE((
         SELECT SUM(amount) FROM maal_in_items WHERE maal_in_id = $1
       ), 0)
       WHERE id = $1;`,
      [id]
    );

    await client.query("COMMIT");
    res.status(201).json({ success: true, message: "Items added and total updated" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Add MaalIn Items Error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/maalin/list
 * Owner: list maal_in with optional filters
 * Query params: company_id, godown_id, date, status
 */
router.get("/list", async (req, res) => {
  try {
    const { company_id, godown_id, date, status } = req.query;
    if (!company_id || !godown_id) {
      return res.status(400).json({ error: "company_id and godown_id required" });
    }

    const params = [company_id, godown_id];
    let where = `WHERE m.company_id = $1 AND m.godown_id = $2`;

    if (date) {
      params.push(date);
      where += ` AND m.date = $${params.length}::date`;
    }
    if (status) {
      params.push(status);
      where += ` AND m.status = $${params.length}`;
    }

    const q = `
      SELECT m.*, 
             COALESCE(items.items_count, 0) AS items_count,
             COALESCE(items.total_weight, 0) AS total_weight
      FROM maal_in m
      LEFT JOIN (
        SELECT maal_in_id, COUNT(*) AS items_count, SUM(weight) AS total_weight
        FROM maal_in_items
        GROUP BY maal_in_id
      ) items ON items.maal_in_id = m.id
      ${where}
      ORDER BY m.date DESC, m.created_at DESC;
    `;

    const result = await pool.query(q, params);
    res.json({ success: true, maal_in: result.rows });
  } catch (err) {
    console.error("❌ MaalIn List Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/maalin/:id
 * Owner/Manager: get maal_in header + items + payments
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const header = await pool.query(`SELECT * FROM maal_in WHERE id=$1`, [id]);
    if (header.rowCount === 0) return res.status(404).json({ error: "maal_in not found" });

    const items = await pool.query(`SELECT * FROM maal_in_items WHERE maal_in_id=$1 ORDER BY material`, [id]);
    const payments = await pool.query(`SELECT * FROM maal_in_payments WHERE maal_in_id=$1 ORDER BY date DESC`, [id]);

    res.json({
      success: true,
      maal_in: header.rows[0],
      items: items.rows,
      payments: payments.rows,
    });
  } catch (err) {
    console.error("❌ MaalIn Get Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/maalin/:id/approve
 * Owner: approve or reject a maal_in
 * Body: { action: 'approve'|'reject', approved_by }
 *
 * Note: Trigger in DB will update stock when status becomes 'approved'.
 */
router.post("/:id/approve", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { action, approved_by } = req.body;

    if (!id || !action || !["approve", "reject"].includes(action)) {
      return res.status(400).json({ error: "Invalid request" });
    }

    await client.query("BEGIN");

    const newStatus = action === "approve" ? "approved" : "rejected";
    const q = `
      UPDATE maal_in
      SET status = $1,
          approved_by = $2,
          approved_at = CASE WHEN $1 = 'approved' THEN NOW() ELSE NULL END
      WHERE id = $3
      RETURNING *;
    `;
    const updateRes = await client.query(q, [newStatus, approved_by || null, id]);

    if (updateRes.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "maal_in not found" });
    }

    await client.query("COMMIT");
    // The DB trigger fn_handle_maal_in_approval() (if present) runs on UPDATE and will update stock
    res.json({ success: true, maal_in: updateRes.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ MaalIn Approve Error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * POST /api/maalin/:id/pay
 * Add payment for a maal_in
 * Body: { amount, mode, date }
 */
router.post("/:id/pay", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { amount, mode, date } = req.body;

    if (!id || !amount || !date) return res.status(400).json({ error: "id, amount and date are required" });

    await client.query("BEGIN");

    // add payment record
    await client.query(
      `INSERT INTO maal_in_payments (id, maal_in_id, amount, mode, date, created_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4::date, NOW())`,
      [id, amount, mode || "cash", date]
    );

    // recompute payment_status on maal_in
    await client.query(
      `UPDATE maal_in
       SET payment_status = CASE
         WHEN COALESCE(total_amount,0) <= COALESCE(p.total_paid,0) THEN 'paid'
         WHEN COALESCE(p.total_paid,0) > 0 THEN 'partially_paid'
         ELSE 'pending'
       END
       FROM (
         SELECT maal_in_id, SUM(amount) AS total_paid
         FROM maal_in_payments
         WHERE maal_in_id = $1
         GROUP BY maal_in_id
       ) p
       WHERE maal_in.id = $1;`,
      [id]
    );

    await client.query("COMMIT");
    res.status(201).json({ success: true, message: "Payment recorded" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ MaalIn Payment Error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/**
 * GET /api/maalin/range
 * Owner: fetch maal_in between dates (for reports)
 * Query: company_id, godown_id, start_date, end_date
 */
router.get("/range", async (req, res) => {
  try {
    const { company_id, godown_id, start_date, end_date } = req.query;
    if (!company_id || !godown_id) return res.status(400).json({ error: "Missing company_id or godown_id" });

    const s = start_date || "2000-01-01";
    const e = end_date || "2100-12-31";

    const q = `
      SELECT m.*, COALESCE(SUM(i.amount),0) AS items_total_amount, COALESCE(SUM(i.weight),0) AS items_total_weight
      FROM maal_in m
      LEFT JOIN maal_in_items i ON i.maal_in_id = m.id
      WHERE m.company_id = $1 AND m.godown_id = $2
        AND m.date BETWEEN $3::date AND $4::date
      GROUP BY m.id
      ORDER BY m.date DESC;
    `;
    const result = await pool.query(q, [company_id, godown_id, s, e]);
    res.json({ success: true, maal_in: result.rows });
  } catch (err) {
    console.error("❌ MaalIn Range Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/maalin/:id
 * Manager/Owner: delete draft/unwanted maal_in (careful in production)
 */
router.delete("/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    await client.query("BEGIN");
    const del = await client.query(`DELETE FROM maal_in WHERE id = $1 RETURNING *;`, [id]);
    if (del.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "maal_in not found" });
    }
    await client.query("COMMIT");
    res.json({ success: true, message: "maal_in deleted", maal_in: del.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Delete MaalIn Error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

export default router;
