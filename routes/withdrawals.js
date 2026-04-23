// routes/withdrawals.js
import express from "express";
import { Op } from "sequelize";
import { sequelize } from "../config/db.js";

import User from "../models/User.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";
import auth from "../middleware/auth.js";
import isAdmin from "../middleware/isAdmin.js";
import { getSettingNumber } from "../utils/appSettings.js";

const router = express.Router();

const toUpper = (v) => String(v || "").trim().toUpperCase();
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function calcDeductions(grossAmount, gstPercent, adminPercent) {
  const gross = round2(grossAmount);
  const gstPct = round2(gstPercent);
  const adminPct = round2(adminPercent);

  const gstAmount = round2((gross * gstPct) / 100);
  const adminFeeAmount = round2((gross * adminPct) / 100);
  const totalDeduction = round2(gstAmount + adminFeeAmount);
  const netAmount = round2(gross - totalDeduction);

  return { gross, gstPct, adminPct, gstAmount, adminFeeAmount, totalDeduction, netAmount };
}

// ===============================
// POST /api/withdrawals
// Body: { amount, payoutMethod: "BANK"|"UPI" }
// amount = GROSS amount requested from wallet
// ===============================
router.post("/", auth, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const userId = req.user.id;

    const amount = toNum(req.body.amount);
    const payoutMethod = toUpper(req.body.payoutMethod); // BANK / UPI

    if (!amount || Number.isNaN(amount) || amount <= 0) {
      throw new Error("Invalid withdrawal amount");
    }

    if (!["BANK", "UPI"].includes(payoutMethod)) {
      throw new Error("payoutMethod must be BANK or UPI");
    }

    // ✅ MIN / MAX from settings
    const MIN_WITHDRAWAL = (await getSettingNumber("MIN_WITHDRAWAL", t)) || 0;
    const MAX_WITHDRAWAL = (await getSettingNumber("MAX_WITHDRAWAL", t)) || 999999999;

    if (Number(amount) < Number(MIN_WITHDRAWAL)) {
      throw new Error(`Minimum withdrawal is ₹${MIN_WITHDRAWAL}`);
    }
    if (Number(amount) > Number(MAX_WITHDRAWAL)) {
      throw new Error(`Maximum withdrawal is ₹${MAX_WITHDRAWAL}`);
    }

    // ✅ GST & Admin % from AppSettings (fallback)
    const GST_PERCENT = await getSettingNumber("GST_PERCENT", t);
    const ADMIN_FEE_PERCENT = await getSettingNumber("ADMIN_FEE_PERCENT", t);

    const gstPct = Number.isFinite(Number(GST_PERCENT)) ? Number(GST_PERCENT) : 5;
    const adminPct = Number.isFinite(Number(ADMIN_FEE_PERCENT)) ? Number(ADMIN_FEE_PERCENT) : 15;

    const fee = calcDeductions(amount, gstPct, adminPct);

    if (fee.netAmount <= 0) {
      throw new Error("Net payout becomes 0 after deductions. Increase withdrawal amount.");
    }

    // Get user details
    const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!user) throw new Error("User not found");

    // Validate details based on method
    if (payoutMethod === "BANK") {
      if (!user.bankAccountNumber || !user.ifscCode || !user.accountHolderName) {
        throw new Error("Bank details missing. Please add bankAccountNumber, ifscCode, accountHolderName");
      }
    }

    if (payoutMethod === "UPI") {
      if (!user.upiId) {
        throw new Error("UPI ID missing. Please add upiId in profile");
      }
    }

    // Get wallet (lock row)
    const wallet = await Wallet.findOne({
      where: { userId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!wallet) throw new Error("Wallet not found");

    // ✅ Check sufficient balance for gross
    if (Number(wallet.balance) < Number(fee.gross)) {
      throw new Error("Insufficient balance");
    }

    // ✅ Deduct gross from balance, move gross to lockedBalance
    const newBal = round2(Number(wallet.balance) - Number(fee.gross));
    const newLocked = round2(Number(wallet.lockedBalance || 0) + Number(fee.gross));

    wallet.balance = newBal;
    wallet.lockedBalance = newLocked;
    wallet.totalBalance = round2(Number(newBal) + Number(newLocked));
    await wallet.save({ transaction: t });

    // prepare payout details
    const bankDetails =
      payoutMethod === "BANK"
        ? {
          bankAccountNumber: user.bankAccountNumber,
          ifscCode: user.ifscCode,
          accountHolderName: user.accountHolderName,
          panNumber: user.panNumber || null,
        }
        : null;

    const upiId = payoutMethod === "UPI" ? user.upiId : null;

    // Create withdrawal transaction (fee breakdown stored in meta)
    const transaction = await WalletTransaction.create(
      {
        walletId: wallet.id,
        type: "DEBIT",
        amount: fee.gross,
        reason: "WITHDRAWAL_REQUEST",
        status: "PENDING",

        payoutMethod,
        bankDetails,
        upiId,

        meta: {
          userId: user.id,
          userName: user.name,
          userEmail: user.email,
          userPhone: user.phone,

          grossAmount: fee.gross,
          gstPercent: fee.gstPct,
          adminFeePercent: fee.adminPct,
          gstAmount: fee.gstAmount,
          adminFeeAmount: fee.adminFeeAmount,
          totalDeduction: fee.totalDeduction,
          netAmount: fee.netAmount,
        },
      },
      { transaction: t }
    );

    await t.commit();

    return res.json({
      msg: "Withdrawal request created successfully",
      withdrawal: {
        id: transaction.id,

        grossAmount: fee.gross,
        gstPercent: fee.gstPct,
        gstAmount: fee.gstAmount,
        adminFeePercent: fee.adminPct,
        adminFeeAmount: fee.adminFeeAmount,
        totalDeduction: fee.totalDeduction,
        netAmount: fee.netAmount,

        status: transaction.status,
        payoutMethod: transaction.payoutMethod,
        bankDetails: transaction.bankDetails || null,
        upiId: transaction.upiId || null,
        createdAt: transaction.createdAt,
      },
      wallet: {
        balance: wallet.balance,
        lockedBalance: wallet.lockedBalance,
        totalBalance: wallet.totalBalance,
      },
    });
  } catch (err) {
    await t.rollback();
    return res.status(400).json({ msg: err.message });
  }
});

// ===============================
// GET /api/withdrawals/my-requests
// ===============================
router.get("/my-requests", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { status } = req.query;

    const wallet = await Wallet.findOne({ where: { userId } });
    if (!wallet) return res.status(404).json({ msg: "Wallet not found" });

    const where = {
      walletId: wallet.id,
      reason: { [Op.in]: ["WITHDRAWAL_REQUEST", "WITHDRAWAL_REFUND"] },
    };

    if (status) where.status = toUpper(status);

    const rows = await WalletTransaction.findAll({
      where,
      order: [["createdAt", "DESC"]],
    });

    return res.json({
      total: rows.length,
      withdrawals: rows,
    });
  } catch (err) {
    console.error("GET /api/withdrawals/my-requests error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

// ===============================
// GET /api/withdrawals/:id
// ===============================
router.get("/:id", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const wallet = await Wallet.findOne({ where: { userId } });
    if (!wallet) return res.status(404).json({ msg: "Wallet not found" });

    const transaction = await WalletTransaction.findOne({
      where: {
        id,
        walletId: wallet.id,
        reason: { [Op.in]: ["WITHDRAWAL_REQUEST", "WITHDRAWAL_REFUND"] },
      },
    });

    if (!transaction) return res.status(404).json({ msg: "Withdrawal request not found" });

    return res.json({ withdrawal: transaction });
  } catch (err) {
    console.error("GET /api/withdrawals/:id error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

// ===============================
// GET /api/withdrawals  (Admin)
// ===============================
router.get("/", auth, async (req, res) => {
  try {
    const { status } = req.query;

    const where = { reason: "WITHDRAWAL_REQUEST" };
    if (status) where.status = toUpper(status);

    const rows = await WalletTransaction.findAll({
      where,
      order: [["createdAt", "DESC"]],
      include: [
        {
          model: Wallet,
          as: "wallet",
          include: [
            {
              model: User,
              as: "user",
              attributes: ["id", "userID", "name", "email", "phone"],
            },
          ],
        },
      ],
    });

    return res.json({
      total: rows.length,
      withdrawals: rows,
    });
  } catch (err) {
    console.error("GET /api/withdrawals error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});

// ===============================
// PUT /api/withdrawals/:id/action  (Admin)
// Body:
//   {
//     "action": "APPROVE" | "REJECT",
//     "transactionId": "optional (only for APPROVE)",
//     "adminNote": "optional for APPROVE, required for REJECT"
//   }
// ===============================
router.put("/:id/action", auth, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { id } = req.params;
    const adminId = req.user.id;

    const action = String(req.body.action || "").trim().toUpperCase();
    const transactionId = req.body.transactionId || null;
    const adminNote = (req.body.adminNote || "").trim();

    if (!["APPROVE", "REJECT"].includes(action)) {
      throw new Error("action must be APPROVE or REJECT");
    }

    if (action === "REJECT" && !adminNote) {
      throw new Error("adminNote is required for REJECT");
    }

    const txn = await WalletTransaction.findOne({
      where: { id, reason: "WITHDRAWAL_REQUEST", status: "PENDING" },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!txn) throw new Error("Withdrawal request not found or already processed");

    const wallet = await Wallet.findByPk(txn.walletId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!wallet) throw new Error("Wallet not found");

    const gross = round2(Number(txn.amount));

    if (action === "APPROVE") {
      // money withdrawn => remove from lockedBalance (gross)
      wallet.lockedBalance = round2(Number(wallet.lockedBalance) - gross);
      wallet.totalBalance = round2(Number(wallet.balance) + Number(wallet.lockedBalance));
      await wallet.save({ transaction: t });

      txn.status = "APPROVED";
      txn.transactionId = transactionId;
      txn.adminNote = adminNote || null;
      txn.processedBy = adminId;
      txn.processedAt = new Date();
      await txn.save({ transaction: t });

      await t.commit();
      return res.json({
        msg: "Withdrawal approved successfully",
        withdrawal: txn,
        payoutInfo: {
          grossAmount: gross,
          netAmount: txn.meta?.netAmount ?? null,
          gstAmount: txn.meta?.gstAmount ?? null,
          adminFeeAmount: txn.meta?.adminFeeAmount ?? null,
          totalDeduction: txn.meta?.totalDeduction ?? null,
        },
      });
    }

    // action === "REJECT"
    // Refund: locked -> available (gross)
    wallet.balance = round2(Number(wallet.balance) + gross);
    wallet.lockedBalance = round2(Number(wallet.lockedBalance) - gross);
    wallet.totalBalance = round2(Number(wallet.balance) + Number(wallet.lockedBalance));
    await wallet.save({ transaction: t });

    txn.status = "REJECTED";
    txn.adminNote = adminNote;
    txn.processedBy = adminId;
    txn.processedAt = new Date();
    await txn.save({ transaction: t });

    // Create refund txn
    await WalletTransaction.create(
      {
        walletId: wallet.id,
        type: "CREDIT",
        amount: gross,
        reason: "WITHDRAWAL_REFUND",
        status: "APPROVED",
        meta: {
          originalWithdrawalId: txn.id,
          refundReason: adminNote,
          processedBy: adminId,
        },
      },
      { transaction: t }
    );

    await t.commit();
    return res.json({ msg: "Withdrawal rejected and amount refunded", withdrawal: txn });
  } catch (err) {
    await t.rollback();
    return res.status(400).json({ msg: err.message });
  }
});

export default router;

