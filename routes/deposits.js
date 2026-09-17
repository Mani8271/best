const express = require("express");
const { Op } = require("sequelize");
const { sequelize } = require("../config/db.js");
const auth = require("../middleware/auth.js");
const isAdmin = require("../middleware/isAdmin.js");
const { uploadDepositProof, getPublicPath } = require("../config/upload.js");
const DepositRequest = require("../models/DepositRequest.js");
const User = require("../models/User.js");
const Wallet = require("../models/Wallet.js");
const WalletTransaction = require("../models/WalletTransaction.js");

const router = express.Router();

const toUpper = (v) => String(v || "").trim().toUpperCase();

/* ==========================================================================
   1. POST /api/deposits
   Create user deposit request (Supports CASH, UPI, BANK with optional proof image)
   ========================================================================== */
router.post("/", auth, (req, res, next) => {
  uploadDepositProof(req, res, (err) => {
    if (err) {
      return res.status(400).json({ msg: err.message || "File upload error" });
    }
    next();
  });
}, async (req, res) => {
  try {
    const userId = req.user.id;
    const amount = Number(req.body.amount);
    const paymode = toUpper(req.body.paymode);
    const { transactionId, upiId, bankName, accountNumber, ifscCode } = req.body;

    if (!amount || Number.isNaN(amount) || amount <= 0) {
      return res.status(400).json({ msg: "Invalid deposit amount" });
    }

    if (!["CASH", "UPI", "BANK"].includes(paymode)) {
      return res.status(400).json({ msg: "paymode must be CASH, UPI, or BANK" });
    }

    let proofPic = null;
    if (req.file) {
      proofPic = getPublicPath(req.file);
    }

    const deposit = await DepositRequest.create({
      userId,
      amount,
      paymode,
      transactionId: transactionId || null,
      upiId: upiId || null,
      bankName: bankName || null,
      accountNumber: accountNumber || null,
      ifscCode: ifscCode || null,
      proofPic,
      status: "PENDING",
    });

    return res.status(201).json({
      msg: "Deposit request created successfully",
      deposit,
    });
  } catch (err) {
    console.error("POST /api/deposits error:", err);
    return res.status(500).json({ msg: err.message || "Server error" });
  }
});

/* ==========================================================================
   2. GET /api/deposits/my-requests
   Get logged-in user's deposit requests
   ========================================================================== */
router.get("/my-requests", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { status } = req.query;

    const where = { userId };
    if (status) where.status = toUpper(status);

    const rows = await DepositRequest.findAll({
      where,
      order: [["createdAt", "DESC"]],
    });

    return res.json({
      total: rows.length,
      deposits: rows,
    });
  } catch (err) {
    console.error("GET /api/deposits/my-requests error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/* ==========================================================================
   3. GET /api/deposits/my-requests/:id
   Get single deposit request by ID for logged-in user
   ========================================================================== */
router.get("/my-requests/:id", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const deposit = await DepositRequest.findOne({
      where: { id, userId },
    });

    if (!deposit) {
      return res.status(404).json({ msg: "Deposit request not found" });
    }

    return res.json({ deposit });
  } catch (err) {
    console.error("GET /api/deposits/my-requests/:id error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/* ==========================================================================
   4. GET /api/deposits (Admin Only)
   Get all deposit requests with filters for admin dashboard
   ========================================================================== */
router.get("/", auth, isAdmin, async (req, res) => {
  try {
    const { status, paymode, search, startDate, endDate } = req.query;

    const where = {};

    if (status) where.status = toUpper(status);
    if (paymode) where.paymode = toUpper(paymode);

    if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);

      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);

      where.createdAt = { [Op.between]: [start, end] };
    }

    const rows = await DepositRequest.findAll({
      where,
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "userID", "name", "email", "phone"],
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    // Filtering by search (user name, phone, userID, transactionId)
    let filtered = rows;
    if (search) {
      const q = search.toLowerCase();
      filtered = rows.filter((d) => {
        const uname = String(d.user?.name || "").toLowerCase();
        const uID = String(d.user?.userID || "").toLowerCase();
        const phone = String(d.user?.phone || "");
        const txnId = String(d.transactionId || "").toLowerCase();
        const amt = String(d.amount || "");

        return (
          uname.includes(q) ||
          uID.includes(q) ||
          phone.includes(q) ||
          txnId.includes(q) ||
          amt.includes(q)
        );
      });
    }

    return res.json({
      total: filtered.length,
      deposits: filtered,
    });
  } catch (err) {
    console.error("GET /api/deposits error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

/* ==========================================================================
   5. PUT /api/deposits/:id/action (Admin Only)
   Approve or Reject deposit request
   ========================================================================== */
router.put("/:id/action", auth, isAdmin, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const adminId = req.user.id;

    const action = toUpper(req.body.action);
    const adminNote = (req.body.adminNote || "").trim();

    if (!["APPROVE", "REJECT"].includes(action)) {
      throw new Error("action must be APPROVE or REJECT");
    }

    if (action === "REJECT" && !adminNote) {
      throw new Error("adminNote is required when rejecting a deposit request");
    }

    const deposit = await DepositRequest.findOne({
      where: { id, status: "PENDING" },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!deposit) {
      throw new Error("Deposit request not found or already processed");
    }

    if (action === "APPROVE") {
      let wallet = await Wallet.findOne({
        where: { userId: deposit.userId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (!wallet) {
        wallet = await Wallet.create(
          { userId: deposit.userId, balance: 0, lockedBalance: 0, totalBalance: 0 },
          { transaction: t }
        );
      }

      const depositAmount = Number(deposit.amount);
      const newBal = Math.round((Number(wallet.balance) + depositAmount + Number.EPSILON) * 100) / 100;
      const lockedBal = Number(wallet.lockedBalance || 0);

      wallet.balance = newBal;
      wallet.totalBalance = Math.round((newBal + lockedBal + Number.EPSILON) * 100) / 100;
      await wallet.save({ transaction: t });

      await WalletTransaction.create(
        {
          walletId: wallet.id,
          type: "CREDIT",
          amount: depositAmount,
          reason: "TOPUP",
          status: "APPROVED",
          transactionId: deposit.transactionId || null,
          meta: {
            depositRequestId: deposit.id,
            paymode: deposit.paymode,
            proofPic: deposit.proofPic,
            adminNote: adminNote || null,
            processedBy: adminId,
          },
        },
        { transaction: t }
      );

      deposit.status = "APPROVED";
      deposit.adminNote = adminNote || deposit.adminNote;
      deposit.processedBy = adminId;
      deposit.processedAt = new Date();
      await deposit.save({ transaction: t });

      await t.commit();
      return res.json({
        msg: "Deposit request approved successfully and wallet credited",
        deposit,
        wallet: {
          balance: wallet.balance,
          totalBalance: wallet.totalBalance,
        },
      });
    }

    // action === "REJECT"
    deposit.status = "REJECTED";
    deposit.adminNote = adminNote;
    deposit.processedBy = adminId;
    deposit.processedAt = new Date();
    await deposit.save({ transaction: t });

    await t.commit();
    return res.json({
      msg: "Deposit request rejected successfully",
      deposit,
    });
  } catch (err) {
    await t.rollback();
    return res.status(400).json({ msg: err.message || "Action failed" });
  }
});

module.exports = router;
