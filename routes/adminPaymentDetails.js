const express = require("express");
const auth = require("../middleware/auth.js");
const isAdmin = require("../middleware/isAdmin.js");
const { uploadQrCode, getPublicPath } = require("../config/upload.js");
const AdminUpiDetail = require("../models/AdminUpiDetail.js");
const AdminBankDetail = require("../models/AdminBankDetail.js");

const router = express.Router();

/* ==========================================================================
   0. GET /api/admin-payment-details/active
   Get all active Admin UPI & Bank details (For user deposit selection)
   ========================================================================== */
router.get("/active", async (req, res) => {
  try {
    const upiList = await AdminUpiDetail.findAll({
      where: { isActive: true },
      order: [["createdAt", "DESC"]],
    });

    const bankList = await AdminBankDetail.findAll({
      where: { isActive: true },
      order: [["createdAt", "DESC"]],
    });

    return res.json({
      upi: upiList,
      bank: bankList,
    });
  } catch (err) {
    console.error("GET /api/admin-payment-details/active error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/* ==========================================================================
   ADMIN UPI APIs (POST, GET, EDIT/PUT, DELETE)
   ========================================================================== */

/**
 * 1. POST /api/admin-payment-details/upi
 * Create new Admin UPI Detail with optional QR Code photo upload
 */
router.post("/upi", auth, isAdmin, (req, res, next) => {
  uploadQrCode(req, res, (err) => {
    if (err) return res.status(400).json({ msg: err.message || "File upload error" });
    next();
  });
}, async (req, res) => {
  try {
    const { upiId, payeeName, isActive } = req.body;

    let qrCode = null;
    if (req.file) {
      qrCode = getPublicPath(req.file);
    }

    if (!upiId && !qrCode) {
      return res.status(400).json({ msg: "Either upiId or qrCode photo is required" });
    }

    const activeBool = isActive !== undefined ? String(isActive) === "true" || isActive === true : true;

    const upiDetail = await AdminUpiDetail.create({
      upiId: upiId ? String(upiId).trim() : null,
      payeeName: payeeName ? String(payeeName).trim() : null,
      qrCode,
      isActive: activeBool,
    });

    return res.status(201).json({
      msg: "Admin UPI detail created successfully",
      upiDetail,
    });
  } catch (err) {
    console.error("POST /api/admin-payment-details/upi error:", err);
    return res.status(500).json({ msg: err.message || "Server error" });
  }
});

/**
 * 2. GET /api/admin-payment-details/upi
 * Fetch list of Admin UPI details (Support ?active=true)
 */
router.get("/upi", async (req, res) => {
  try {
    const { active } = req.query;
    const where = {};
    if (active === "true") where.isActive = true;

    const rows = await AdminUpiDetail.findAll({
      where,
      order: [["createdAt", "DESC"]],
    });

    return res.json({
      total: rows.length,
      upiDetails: rows,
    });
  } catch (err) {
    console.error("GET /api/admin-payment-details/upi error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/**
 * 3. GET /api/admin-payment-details/upi/:id
 * Get single Admin UPI detail by ID
 */
router.get("/upi/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const upiDetail = await AdminUpiDetail.findByPk(id);

    if (!upiDetail) {
      return res.status(404).json({ msg: "Admin UPI detail not found" });
    }

    return res.json({ upiDetail });
  } catch (err) {
    console.error("GET /api/admin-payment-details/upi/:id error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/**
 * 4. PUT /api/admin-payment-details/upi/:id
 * Edit Admin UPI detail (Supports updating QR code photo)
 */
router.put("/upi/:id", auth, isAdmin, (req, res, next) => {
  uploadQrCode(req, res, (err) => {
    if (err) return res.status(400).json({ msg: err.message || "File upload error" });
    next();
  });
}, async (req, res) => {
  try {
    const { id } = req.params;
    const { upiId, payeeName, isActive } = req.body;

    const upiDetail = await AdminUpiDetail.findByPk(id);
    if (!upiDetail) {
      return res.status(404).json({ msg: "Admin UPI detail not found" });
    }

    if (upiId !== undefined) upiDetail.upiId = upiId ? String(upiId).trim() : null;
    if (payeeName !== undefined) upiDetail.payeeName = payeeName ? String(payeeName).trim() : null;
    if (isActive !== undefined) upiDetail.isActive = String(isActive) === "true" || isActive === true;

    if (req.file) {
      upiDetail.qrCode = getPublicPath(req.file);
    }

    await upiDetail.save();

    return res.json({
      msg: "Admin UPI detail updated successfully",
      upiDetail,
    });
  } catch (err) {
    console.error("PUT /api/admin-payment-details/upi/:id error:", err);
    return res.status(500).json({ msg: err.message || "Server error" });
  }
});

/**
 * 5. DELETE /api/admin-payment-details/upi/:id
 * Delete Admin UPI detail
 */
router.delete("/upi/:id", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const upiDetail = await AdminUpiDetail.findByPk(id);

    if (!upiDetail) {
      return res.status(404).json({ msg: "Admin UPI detail not found" });
    }

    await upiDetail.destroy();

    return res.json({ msg: "Admin UPI detail deleted successfully" });
  } catch (err) {
    console.error("DELETE /api/admin-payment-details/upi/:id error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/* ==========================================================================
   ADMIN BANK APIs (POST, GET, EDIT/PUT, DELETE)
   ========================================================================== */

/**
 * 1. POST /api/admin-payment-details/bank
 * Create new Admin Bank Detail
 */
router.post("/bank", auth, isAdmin, async (req, res) => {
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
    console.error("POST /api/admin-payment-details/bank error:", err);
    return res.status(500).json({ msg: err.message || "Server error" });
  }
});

/**
 * 2. GET /api/admin-payment-details/bank
 * Fetch list of Admin Bank details (Support ?active=true)
 */
router.get("/bank", async (req, res) => {
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
    console.error("GET /api/admin-payment-details/bank error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/**
 * 3. GET /api/admin-payment-details/bank/:id
 * Get single Admin Bank detail by ID
 */
router.get("/bank/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const bankDetail = await AdminBankDetail.findByPk(id);

    if (!bankDetail) {
      return res.status(404).json({ msg: "Admin Bank detail not found" });
    }

    return res.json({ bankDetail });
  } catch (err) {
    console.error("GET /api/admin-payment-details/bank/:id error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/**
 * 4. PUT /api/admin-payment-details/bank/:id
 * Edit Admin Bank detail
 */
router.put("/bank/:id", auth, isAdmin, async (req, res) => {
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
    console.error("PUT /api/admin-payment-details/bank/:id error:", err);
    return res.status(500).json({ msg: err.message || "Server error" });
  }
});

/**
 * 5. DELETE /api/admin-payment-details/bank/:id
 * Delete Admin Bank detail
 */
router.delete("/bank/:id", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const bankDetail = await AdminBankDetail.findByPk(id);

    if (!bankDetail) {
      return res.status(404).json({ msg: "Admin Bank detail not found" });
    }

    await bankDetail.destroy();

    return res.json({ msg: "Admin Bank detail deleted successfully" });
  } catch (err) {
    console.error("DELETE /api/admin-payment-details/bank/:id error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

module.exports = router;
