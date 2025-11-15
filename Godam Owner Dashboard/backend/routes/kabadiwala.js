// ✅ Kabadiwala Routes
import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

// =============================================
// 🟢 Add New Kabadiwala Purchase Record
// =============================================
router.post("/add", async (req, res) => {
  const client = await pool.connect();

  try {
    const { company_id, godown_id, kabadiwala_name, scraps, account_id } = req.body;

    // ✅ Basic Validation
    if (!company_id || !godown_id || !kabadiwala_name || !Array.isArray(scraps) || scraps.length === 0) {
      return res.status(400).json({ error: "Missing required fields or empty scrap list." });
    }

    // ✅ Calculate total amount
    const totalAmount = scraps.reduce((sum, s) => sum + (parseFloat(s.amount) || 0), 0);

    await client.query("BEGIN");

    // ✅ 1️⃣ Insert Kabadiwala record
    const recordRes = await client.query(
      `INSERT INTO kabadiwala_records 
        (id, company_id, godown_id, date, kabadiwala_name, total_amount, created_at)
       VALUES (uuid_generate_v4(), $1, $2, CURRENT_DATE, $3, $4, NOW())
       RETURNING id;`,
      [company_id, godown_id, kabadiwala_name, totalAmount]
    );

    const kabadiwala_id = recordRes.rows[0].id;

    // ✅ 2️⃣ Insert Scrap Items
    const insertScrapQuery = `
      INSERT INTO kabadiwala_scraps (id, kabadiwala_id, material, weight, rate, amount)
      VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5);
    `;
    for (const s of scraps) {
      await client.query(insertScrapQuery, [
        kabadiwala_id,
        s.material,
        parseFloat(s.weight),
        parseFloat(s.rate),
        parseFloat(s.amount),
      ]);
    }

    // ✅ 3️⃣ Log in Account Transactions
    await client.query(
      `INSERT INTO account_transactions 
        (id, company_id, godown_id, account_id, type, amount, category, reference, metadata, created_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, 'debit', $4, 'kabadiwala purchase', $5, '{}', NOW());`,
      [
        company_id,
        godown_id,
        account_id,
        totalAmount,
        `Purchase from ${kabadiwala_name}`,
      ]
    );

    // ✅ 4️⃣ Update Account Balance
    await client.query(
      `UPDATE accounts SET balance = balance - $1 WHERE id = $2;`,
      [totalAmount, account_id]
    );

    await client.query("COMMIT");
    console.log(`✅ Kabadiwala purchase recorded for ${kabadiwala_name}`);

    res.status(201).json({ success: true, kabadiwala_id });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Kabadiwala Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// =============================================
// 🟣 Get All Kabadiwala Records (Optional)
// =============================================
router.get("/list/:company_id", async (req, res) => {
  try {
    const { company_id } = req.params;
    const result = await pool.query(
      `SELECT kr.id, kr.kabadiwala_name, kr.total_amount, kr.date,
              json_agg(
                json_build_object(
                  'material', ks.material,
                  'weight', ks.weight,
                  'rate', ks.rate,
                  'amount', ks.amount
                )
              ) AS scraps
       FROM kabadiwala_records kr
       JOIN kabadiwala_scraps ks ON kr.id = ks.kabadiwala_id
       WHERE kr.company_id = $1
       GROUP BY kr.id
       ORDER BY kr.date DESC;`,
      [company_id]
    );

    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("❌ Fetch Kabadiwala Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
