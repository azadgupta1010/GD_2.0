import express from "express";
import { pool } from "../config/db.js";


const router = express.Router();

// ✅ Add Maal Out (Sale)
router.post("/add", async (req, res) => {
  const client = await pool.connect();
  try {
    const { company_id, godown_id, buyer, account_id, items } = req.body;
    const totalAmount = items.reduce((sum, i) => sum + parseFloat(i.amount || 0), 0);
    await client.query("BEGIN");

    const sale = await client.query(
      `INSERT INTO maal_out (company_id, godown_id, date, buyer, total_amount, created_at)
       VALUES ($1, $2, CURRENT_DATE, $3, $4, NOW()) RETURNING id;`,
      [company_id, godown_id, buyer, totalAmount]
    );
    const maalOutId = sale.rows[0].id;

    for (const item of items) {
      await client.query(
        `INSERT INTO maal_out_items (maal_out_id, material, weight, rate, amount)
         VALUES ($1, $2, $3, $4, $5);`,
        [maalOutId, item.material, item.weight, item.rate, item.amount]
      );
    }

    await client.query(
      `INSERT INTO account_transactions 
       (company_id, godown_id, account_id, type, amount, category, reference, created_at)
       VALUES ($1, $2, $3, 'credit', $4, 'sale', $5, NOW());`,
      [company_id, godown_id, account_id, totalAmount, `Sale to ${buyer}`]
    );

    await client.query(`UPDATE accounts SET balance = balance + $1 WHERE id = $2`, [
      totalAmount,
      account_id,
    ]);

    await client.query("COMMIT");
    res.json({ success: true, maal_out_id: maalOutId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Maal Out Error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ✅ Get Sales
router.get("/list/:company_id", async (req, res) => {
  try {
    const { company_id } = req.params;
    const result = await pool.query(
      `SELECT mo.id, mo.date, mo.buyer, mo.total_amount,
              json_agg(json_build_object(
                'material', moi.material,
                'weight', moi.weight,
                'rate', moi.rate,
                'amount', moi.amount
              )) AS items
       FROM maal_out mo
       JOIN maal_out_items moi ON mo.id = moi.maal_out_id
       WHERE mo.company_id = $1
       GROUP BY mo.id
       ORDER BY mo.created_at DESC;`,
      [company_id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("❌ Fetch Sales Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
