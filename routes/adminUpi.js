const express = require("express");
const auth = require("../middleware/auth.js");
const isAdmin = require("../middleware/isAdmin.js");
const { uploadQrCode, getPublicPath } = require("../config/upload.js");
const AdminUpiDetail = require("../models/AdminUpiDetail.js");

const router = express.Router();

/* ==========================================================================
   ADMIN UPI APIs (POST, GET, EDIT/PUT, DELETE)
   ========================================================================== */

/**
 * 1. POST /api/admin-upi
 * Create new Admin UPI Detail with optional QR Code photo upload
 */
router.post("/", auth, isAdmin, (req, res, next) => {
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
    console.error("POST /api/admin-upi error:", err);
    return res.status(500).json({ msg: err.message || "Server error" });
  }
});

/**
 * 2. GET /api/admin-upi
 * Fetch list of Admin UPI details (Supports ?active=true)
 */
router.get("/", async (req, res) => {
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
    console.error("GET /api/admin-upi error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/**
 * 3. GET /api/admin-upi/:id
 * Get single Admin UPI detail by ID
 */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const upiDetail = await AdminUpiDetail.findByPk(id);

    if (!upiDetail) {
      return res.status(404).json({ msg: "Admin UPI detail not found" });
    }

    return res.json({ upiDetail });
  } catch (err) {
    console.error("GET /api/admin-upi/:id error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/**
 * 4. PUT /api/admin-upi/:id
 * Edit Admin UPI detail (Supports updating QR code photo)
 */
router.put("/:id", auth, isAdmin, (req, res, next) => {
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
    console.error("PUT /api/admin-upi/:id error:", err);
    return res.status(500).json({ msg: err.message || "Server error" });
  }
});

/**
 * 5. DELETE /api/admin-upi/:id
 * Delete Admin UPI detail
 */
router.delete("/:id", auth, isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const upiDetail = await AdminUpiDetail.findByPk(id);

    if (!upiDetail) {
      return res.status(404).json({ msg: "Admin UPI detail not found" });
    }

    await upiDetail.destroy();

    return res.json({ msg: "Admin UPI detail deleted successfully" });
  } catch (err) {
    console.error("DELETE /api/admin-upi/:id error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

module.exports = router;
