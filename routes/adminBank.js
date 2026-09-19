const express = require("express");
const auth = require("../middleware/auth.js");
const isAdmin = require("../middleware/isAdmin.js");
const AdminBankDetail = require("../models/AdminBankDetail.js");

const router = express.Router();

/* ==========================================================================
   ADMIN BANK APIs (POST, GET, EDIT/PUT, DELETE)
   ========================================================================== */

/**
 * 1. POST /api/admin-bank
 * Create new Admin Bank Detail
 */
router.post("/", auth, isAdmin, async (req, res) => {
  try {
    const { bankName, accountHolderName, accountNumber, ifscCode, branchName, accountType, isActive } = req.body;

    if (!bankName || !accountHolderName || !accountNumber || !ifscCode) {
      return res.status(400).json({ msg: "bankName, accountHolderName, accountNumber, and ifscCode are required" });
    }

    const activeBool = isActive !== undefined ? String(isActive) === "true" || isActive === true : true;

    const bankDetail = await AdminBankDetail.create({
      bankName: String(bankName).trim(),
      accountHolderName: String(accountHolderName).trim(),
      accountNumber: String(accountNumber).trim(),
      ifscCode: String(ifscCode).trim(),
      branchName: branchName ? String(branchName).trim() : null,
      accountType: accountType ? String(accountType).trim() : null,
      isActive: activeBool,
    });

    return res.status(201).json({
      msg: "Admin Bank detail created successfully",
      bankDetail,
    });
  } catch (err) {
    console.error("POST /api/admin-bank error:", err);
    return res.status(500).json({ msg: err.message || "Server error" });
  }
});

/**
 * 2. GET /api/admin-bank
 * Fetch list of Admin Bank details (Supports ?active=true)
 */
router.get("/", async (req, res) => {
  try {
    const { active } = req.query;
    const where = {};
    if (active === "true") where.isActive = true;

    const rows = await AdminBankDetail.findAll({
      where,
      order: [["createdAt", "DESC"]],
    });

    return res.json({
      total: rows.length,
      bankDetails: rows,
    });
  } catch (err) {
    console.error("GET /api/admin-bank error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/**
 * 3. GET /api/admin-bank/:id
 * Get single Admin Bank detail by ID
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const bankDetail = await AdminBankDetail.findByPk(id);

    if (!bankDetail) {
      return res.status(404).json({ msg: "Admin Bank detail not found" });
    }

    return res.json({ bankDetail });
  } catch (err) {
    console.error("GET /api/admin-bank/:id error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/**
 * 4. PUT /api/admin-bank/:id
 * Edit Admin Bank detail
 */
router.put("/:id", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { bankName, accountHolderName, accountNumber, ifscCode, branchName, accountType, isActive } = req.body;

    const bankDetail = await AdminBankDetail.findByPk(id);
    if (!bankDetail) {
      return res.status(404).json({ msg: "Admin Bank detail not found" });
    }

    if (bankName !== undefined) bankDetail.bankName = String(bankName).trim();
    if (accountHolderName !== undefined) bankDetail.accountHolderName = String(accountHolderName).trim();
    if (accountNumber !== undefined) bankDetail.accountNumber = String(accountNumber).trim();
    if (ifscCode !== undefined) bankDetail.ifscCode = String(ifscCode).trim();
    if (branchName !== undefined) bankDetail.branchName = branchName ? String(branchName).trim() : null;
    if (accountType !== undefined) bankDetail.accountType = accountType ? String(accountType).trim() : null;
    if (isActive !== undefined) bankDetail.isActive = String(isActive) === "true" || isActive === true;

    await bankDetail.save();

    return res.json({
      msg: "Admin Bank detail updated successfully",
      bankDetail,
    });
  } catch (err) {
    console.error("PUT /api/admin-bank/:id error:", err);
    return res.status(500).json({ msg: err.message || "Server error" });
  }
});

/**
 * 5. DELETE /api/admin-bank/:id
 * Delete Admin Bank detail
 */
router.delete("/:id", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bankDetail = await AdminBankDetail.findByPk(id);

    if (!bankDetail) {
      return res.status(404).json({ msg: "Admin Bank detail not found" });
    }

    await bankDetail.destroy();

    return res.json({ msg: "Admin Bank detail deleted successfully" });
  } catch (err) {
    console.error("DELETE /api/admin-bank/:id error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

module.exports = router;
