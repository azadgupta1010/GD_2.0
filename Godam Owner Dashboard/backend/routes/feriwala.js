// backend/routes/feriwala.js
import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

/* --------------------------------------------------------
   1️⃣ ADD NEW FERIWALA PURCHASE
-------------------------------------------------------- */
router.post("/add", async (req, res) => {
  const client = await pool.connect();

  try {
    const { company_id, godown_id, feriwala_name, scraps, account_id } = req.body;

    if (!company_id || !godown_id || !feriwala_name || !scraps?.length) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (!account_id) {
      return res.status(400).json({ error: "Account ID is required to pay feriwala" });
    }

    const totalAmount = scraps.reduce(
      (sum, s) => sum + Number(s.amount || 0),
      0
    );

    await client.query("BEGIN");

    // Add Feriwala main record
    const mainRecord = await client.query(
      `
      INSERT INTO feriwala_records 
      (id, company_id, godown_id, date, feriwala_name, total_amount, created_at)
      VALUES (
        COALESCE(uuid_generate_v4(), gen_random_uuid()),
        $1, $2, CURRENT_DATE, $3, $4, NOW()
      )
      RETURNING id;
      `,
      [company_id, godown_id, feriwala_name, totalAmount]
    );

    const feriwala_id = mainRecord.rows[0].id;

    // Insert each scrap entry
    for (const s of scraps) {
      await client.query(
        `
        INSERT INTO feriwala_scraps 
        (id, feriwala_id, material, weight, rate, amount)
        VALUES (
          COALESCE(uuid_generate_v4(), gen_random_uuid()),
          $1, $2, $3, $4, $5
        );
        `,
        [feriwala_id, s.material, s.weight, s.rate, s.amount]
      );
    }

    // Add ledger entry for payment
    await client.query(
      `
      INSERT INTO account_transactions 
      (id, company_id, godown_id, account_id, type, amount, category, reference, metadata, created_at)
      VALUES (
        COALESCE(uuid_generate_v4(), gen_random_uuid()),
        $1, $2, $3, 'debit', $4, 'feriwala purchase', $5, '{}', NOW()
      );
      `,
      [
        company_id,
        godown_id,
        account_id,
        totalAmount,
        `Purchase from ${feriwala_name}`,
      ]
    );

    // Update account balance
    await client.query(
      `UPDATE accounts SET balance = balance - $1 WHERE id = $2`,
      [totalAmount, account_id]
    );

    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      feriwala_id,
      message: `Feriwala purchase added successfully`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Feriwala POST Error:", err);
    res.status(500).json({ error: "Internal server error" });
  } finally {
    client.release();
  }
});

/* --------------------------------------------------------
   2️⃣ FETCH ALL FERIWALA PURCHASES (with scrap details)
-------------------------------------------------------- */
router.get("/list", async (req, res) => {
  try {
    const { company_id, godown_id, date } = req.query;

    if (!company_id || !godown_id) {
      return res.status(400).json({
        error: "company_id and godown_id are required",
      });
    }

    // Main purchase records
    const recordQuery = await pool.query(
      `
      SELECT *
      FROM feriwala_records
      WHERE company_id = $1
        AND godown_id = $2
        AND ($3::date IS NULL OR date <= $3::date)
      ORDER BY date DESC;
      `,
      [company_id, godown_id, date || null]
    );

    const feriwalaRecords = recordQuery.rows;

    // Insert scrap items into each record
    for (const r of feriwalaRecords) {
      const scrapQuery = await pool.query(
        `
        SELECT material, weight, rate, amount
        FROM feriwala_scraps
        WHERE feriwala_id = $1;
        `,
        [r.id]
      );
      r.scraps = scrapQuery.rows;
    }

    res.json({ success: true, records: feriwalaRecords });
  } catch (err) {
    console.error("❌ Feriwala GET Error:", err);
    res.status(500).json({ error: "Failed to fetch feriwala records" });
  }
});

export default router;
