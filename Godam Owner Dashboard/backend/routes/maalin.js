// backend/routes/maalin.js
import express from "express";
import { pool } from "../config/db.js";

const router = express.Router();

// ADD NEW MAAL IN ENTRY
router.post("/add", async (req, res) => {
  try {
    const {
      company_id,
      godown_id,
      date,
      seller_type,
      seller_name,
      scrap_type,
      quantity,
      rate,
      total_amount,
      payment_status,
      payment_mode
    } = req.body;

    if (!company_id || !godown_id || !seller_name || !scrap_type) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const q = `
      INSERT INTO maal_in 
      (id, company_id, godown_id, date, seller_type, seller_name, scrap_type, quantity, rate, total_amount, payment_status, payment_mode, created_at)
      VALUES (
        uuid_generate_v4(), $1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, NOW()
      )
      RETURNING *;
    `;

    const params = [
      company_id,
      godown_id,
      date,
      seller_type,
      seller_name,
      scrap_type,
      quantity,
      rate,
      total_amount,
      payment_status,
      payment_mode
    ];

    const result = await pool.query(q, params);

    return res.status(201).json({
      success: true,
      message: "Maal In entry added",
      maal_in: result.rows[0]
    });

  } catch (err) {
    console.error("❌ MaalIn Add Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});
