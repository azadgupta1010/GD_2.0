// backend/routes/labour.js
import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/* ===================================================
   🟢 1. Add New Labour / Contractor (Owner)
=================================================== */
router.post("/add", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      company_id,
      godown_id,
      name,
      contact,
      role,
      worker_type,
      daily_wage,
      monthly_salary,
      per_kg_rate,
      status = "Active",
      created_by,
    } = req.body;

    if (!company_id || !godown_id || !name) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await client.query("BEGIN");

    // Insert labour
    const result = await client.query(
      `INSERT INTO labour
       (id, company_id, godown_id, name, contact, role, worker_type, daily_wage, monthly_salary, per_kg_rate, status, created_by, created_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       RETURNING *;`,
      [
        company_id,
        godown_id,
        name,
        contact || null,
        role || null,
        worker_type || "Labour",
        daily_wage || 0,
        monthly_salary || 0,
        per_kg_rate || 0,
        status,
        created_by || null,
      ]
    );

    const labourId = result.rows[0].id;

    // Create salary summary row
    await client.query(
      `INSERT INTO labour_salary_summary
       (id, company_id, godown_id, labour_id, month, year, total_days, present_days, total_earned, total_paid, net_balance, created_at)
       VALUES (uuid_generate_v4(), $1, $2, $3,
               EXTRACT(MONTH FROM NOW()), EXTRACT(YEAR FROM NOW()),
               0, 0, 0, 0, 0, NOW());`,
      [company_id, godown_id, labourId]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "Labour added successfully",
      labour: result.rows[0],
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Add Labour Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
   🟣 2. Fetch all labour / contractors
=================================================== */
router.get("/all", async (req, res) => {
  try {
    const { company_id, godown_id } = req.query;

    const result = await pool.query(
      `SELECT l.*,
        COALESCE(SUM(w.amount), 0) AS total_withdrawn,
        COALESCE(SUM(s.amount), 0) AS total_salary_earned
       FROM labour l
       LEFT JOIN labour_withdrawals w ON l.id = w.labour_id
       LEFT JOIN labour_salary s ON l.id = s.labour_id
       WHERE l.company_id=$1 AND l.godown_id=$2
       GROUP BY l.id
       ORDER BY l.created_at DESC;`,
      [company_id, godown_id]
    );

    res.json({ success: true, labour: result.rows });
  } catch (err) {
    console.error("❌ Fetch Labour Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ===================================================
   🟠 3. Manager — Mark Attendance
=================================================== */
router.post("/attendance/mark", async (req, res) => {
  const client = await pool.connect();

  try {
    const { company_id, godown_id, labour_id, date, status } = req.body;

    await client.query("BEGIN");

    // Prevent duplicates
    const exists = await client.query(
      `SELECT id FROM attendance WHERE labour_id=$1 AND date=$2`,
      [labour_id, date]
    );

    if (exists.rowCount > 0) {
      return res.status(400).json({ error: "Attendance already marked" });
    }

    // Insert attendance
    await client.query(
      `INSERT INTO attendance
       (id, company_id, godown_id, labour_id, date, status, created_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, NOW());`,
      [company_id, godown_id, labour_id, date, status]
    );

    // Auto-daily salary if present
    if (status.toLowerCase() === "present") {
      const wage = await client.query(
        `SELECT daily_wage FROM labour WHERE id=$1`,
        [labour_id]
      );

      const dailyWage = wage.rows[0]?.daily_wage || 0;

      await client.query(
        `INSERT INTO labour_salary
         (id, company_id, godown_id, labour_id, date, amount, paid, created_at)
         VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, false, NOW());`,
        [company_id, godown_id, labour_id, date, dailyWage]
      );
    }

    await client.query("COMMIT");

    res.json({ success: true, message: `Attendance marked: ${status}` });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Attendance Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/* ===================================================
   🟡 4. Salary / Advance Payment
=================================================== */
router.post("/payment", async (req, res) => {
  try {
    const { company_id, godown_id, labour_id, amount, date, mode, type } = req.body;

    await pool.query(
      `INSERT INTO labour_withdrawals
       (id, company_id, godown_id, labour_id, date, amount, mode, type, created_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        company_id,
        godown_id,
        labour_id,
        date,
        amount,
        mode || "cash",
        type || "salary",
      ]
    );

    res.json({ success: true, message: "Payment recorded successfully" });
  } catch (err) {
    console.error("❌ Payment Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
