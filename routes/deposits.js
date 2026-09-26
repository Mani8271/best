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
const Investment = require("../models/Investment.js");
const InvestmentTransaction = require("../models/InvestmentTransaction.js");
const { getSettingNumber } = require("../utils/appSettings.js");

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
      const depositAmount = Number(deposit.amount);

      // 1. Find or create main Wallet & credit balance
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

      // Deposit amount is credited to Active Investment (investment.activeInvestment), NOT withdrawable Wallet.balance
      const currentBal = Number(wallet.balance || 0);
      const lockedBal = Number(wallet.lockedBalance || 0);
      const spotBal = Number(wallet.spotBalance || 0);

      wallet.totalBalance = Math.round((currentBal + spotBal + lockedBal + Number.EPSILON) * 100) / 100;
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

      // 2. Target User details & Account Activation
      const targetUser = await User.findByPk(deposit.userId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (targetUser) {
        if (targetUser.status !== "ACTIVE") {
          targetUser.status = "ACTIVE";
          if (!targetUser.activationDate) {
            targetUser.activationDate = new Date();
          }
          await targetUser.save({ transaction: t });
        }

        // 3. Investment Wallet Topup
        let [investment] = await Investment.findOrCreate({
          where: { userId: targetUser.id },
          defaults: {
            totalInvested: 0,
            activeInvestment: 0,
            roiBalance: 0,
            commissionBalance: 0,
            totalWithdrawn: 0,
            status: "ACTIVE",
          },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        investment.totalInvested = Number(investment.totalInvested || 0) + depositAmount;
        investment.activeInvestment = Number(investment.activeInvestment || 0) + depositAmount;
        investment.status = "ACTIVE";
        await investment.save({ transaction: t });

        // 4. Log Investment DEPOSIT Transaction
        await InvestmentTransaction.create(
          {
            userId: targetUser.id,
            type: "DEPOSIT",
            amount: depositAmount,
            createdAdminId: adminId,
            description: adminNote || `Deposit of ₹${depositAmount.toLocaleString("en-IN")} approved by Admin (${deposit.paymode})`,
            meta: {
              depositRequestId: deposit.id,
              paymode: deposit.paymode,
              adminId,
              remark: adminNote || null,
            },
          },
          { transaction: t }
        );

        // 5. Direct Sponsor 5% Spot Commission Distribution on Topup
        if (targetUser.sponsorId) {
          const spotPct = await getSettingNumber("INVESTMENT_SPOT_REFERRAL_PERCENT", t);
          const rate = (Number.isFinite(spotPct) && spotPct > 0 ? spotPct : 5) / 100;

          if (rate > 0) {
            const sponsor = await User.findByPk(targetUser.sponsorId, {
              transaction: t,
              lock: t.LOCK.UPDATE,
            });

            if (sponsor) {
              const commAmount = Number((depositAmount * rate).toFixed(2));

              // 1. Credit Sponsor Investment.spotBalance
              let [sponsorInvestment] = await Investment.findOrCreate({
                where: { userId: sponsor.id },
                defaults: {
                  totalInvested: 0,
                  activeInvestment: 0,
                  roiBalance: 0,
                  commissionBalance: 0,
                  spotBalance: 0,
                  totalWithdrawn: 0,
                  status: "ACTIVE",
                },
                transaction: t,
                lock: t.LOCK.UPDATE,
              });

              sponsorInvestment.spotBalance = Number(sponsorInvestment.spotBalance || 0) + commAmount;
              await sponsorInvestment.save({ transaction: t });

              // 2. Credit Sponsor Wallet.spotBalance
              let sponsorWallet = await Wallet.findOne({
                where: { userId: sponsor.id },
                transaction: t,
                lock: t.LOCK.UPDATE,
              });

              if (!sponsorWallet) {
                sponsorWallet = await Wallet.create(
                  { userId: sponsor.id, balance: 0, spotBalance: 0, lockedBalance: 0, totalBalance: 0 },
                  { transaction: t }
                );
              }

              sponsorWallet.spotBalance = Math.round((Number(sponsorWallet.spotBalance || 0) + commAmount + Number.EPSILON) * 100) / 100;
              await sponsorWallet.save({ transaction: t });

              // 3. Log InvestmentTransaction
              await InvestmentTransaction.create(
                {
                  userId: sponsor.id,
                  type: "LEVEL_COMMISSION",
                  amount: commAmount,
                  level: 1,
                  fromUserId: targetUser.id,
                  createdAdminId: adminId,
                  description: `Direct Spot Referral Commission (${rate * 100}%) from ${targetUser.name} (${targetUser.userID || targetUser.id}) deposit of ₹${depositAmount.toLocaleString("en-IN")}`,
                  meta: {
                    level: 1,
                    isSpotCommission: true,
                    ratePercentage: rate * 100,
                    investmentAmount: depositAmount,
                    depositRequestId: deposit.id,
                    investorUserId: targetUser.userID || targetUser.id,
                    investorName: targetUser.name,
                  },
                },
                { transaction: t }
              );

              // 4. Log WalletTransaction
              await WalletTransaction.create(
                {
                  walletId: sponsorWallet.id,
                  type: "CREDIT",
                  amount: commAmount,
                  reason: "TOPUP",
                  status: "APPROVED",
                  meta: {
                    isSpotCommission: true,
                    depositRequestId: deposit.id,
                    investorUserId: targetUser.userID || targetUser.id,
                    investorName: targetUser.name,
                  },
                },
                { transaction: t }
              );
            }
          }
        }
      }

      deposit.status = "APPROVED";
      deposit.adminNote = adminNote || deposit.adminNote;
      deposit.processedBy = adminId;
      deposit.processedAt = new Date();
      await deposit.save({ transaction: t });

      await t.commit();
      return res.json({
        msg: "Deposit request approved successfully. Wallet credited and topup processed.",
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
