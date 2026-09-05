const express = require("express");
const { sequelize } = require("../config/db.js");
const { Op } = require("sequelize");
const auth = require("../middleware/auth.js");
const isAdmin = require("../middleware/isAdmin.js");

const User = require("../models/User.js");
const Investment = require("../models/Investment.js");
const InvestmentTransaction = require("../models/InvestmentTransaction.js");

const router = express.Router();

// Level commission percentage rates
const LEVEL_COMMISSION_RATES = {
  1: 0.02,   // 2.0%
  2: 0.01,   // 1.0%
  3: 0.005,  // 0.5%
  4: 0.0025, // 0.25%
};

/**
 * @route   POST /api/investment/admin/topup
 * @desc    Admin loads investment money into a user's Investment Wallet using userID or user pk ID.
 *          Automatically distributes 4-Level commissions to upline sponsors.
 * @access  Admin / Master / Staff
 */
router.post("/admin/topup", auth, isAdmin, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { userID, userId, amount, remark } = req.body;

    const numAmount = Number(amount);
    if (!numAmount || isNaN(numAmount) || numAmount < 50000) {
      await t.rollback();
      return res.status(400).json({
        msg: "Minimum investment amount is ₹50,000",
      });
    }

    // Search user by userID string (e.g. S123456) or primary key id
    let whereClause = {};
    if (userID) {
      whereClause = { userID: String(userID).trim() };
    } else if (userId) {
      whereClause = { id: Number(userId) };
    } else {
      await t.rollback();
      return res.status(400).json({ msg: "Please provide target user ID or userID (e.g., S123456)" });
    }

    const targetUser = await User.findOne({
      where: whereClause,
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!targetUser) {
      await t.rollback();
      return res.status(404).json({ msg: "User not found with the provided ID" });
    }

    // 1. Find or create Investment wallet for target user
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

    investment.totalInvested = Number(investment.totalInvested || 0) + numAmount;
    investment.activeInvestment = Number(investment.activeInvestment || 0) + numAmount;
    investment.status = "ACTIVE";
    await investment.save({ transaction: t });

    // 2. Log DEPOSIT transaction
    const depositTxn = await InvestmentTransaction.create(
      {
        userId: targetUser.id,
        type: "DEPOSIT",
        amount: numAmount,
        createdAdminId: req.user.id,
        description: remark || `Investment deposit of ₹${numAmount.toLocaleString("en-IN")} added by Admin`,
        meta: {
          adminId: req.user.id,
          adminName: req.user.name || "Admin",
          remark: remark || null,
        },
      },
      { transaction: t }
    );

    // 3. Traversal Upline 4-Levels for Commission Distribution
    const commissionsDistributed = [];
    let currentUserId = targetUser.id;

    for (let level = 1; level <= 4; level++) {
      const currentUserNode = await User.findByPk(currentUserId, {
        attributes: ["id", "sponsorId", "name", "userID"],
        transaction: t,
      });

      if (!currentUserNode || !currentUserNode.sponsorId) {
        break; // Reached top of tree
      }

      const sponsor = await User.findByPk(currentUserNode.sponsorId, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (!sponsor) {
        break;
      }

      const rate = LEVEL_COMMISSION_RATES[level] || 0;
      if (rate > 0) {
        const commAmount = Number((numAmount * rate).toFixed(2));

        let [sponsorInvestment] = await Investment.findOrCreate({
          where: { userId: sponsor.id },
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

        sponsorInvestment.commissionBalance = Number(sponsorInvestment.commissionBalance || 0) + commAmount;
        await sponsorInvestment.save({ transaction: t });

        await InvestmentTransaction.create(
          {
            userId: sponsor.id,
            type: "LEVEL_COMMISSION",
            amount: commAmount,
            level,
            fromUserId: targetUser.id,
            createdAdminId: req.user.id,
            description: `Level ${level} Commission (${(rate * 100).toFixed(2)}%) from ${targetUser.name} (${targetUser.userID}) investment of ₹${numAmount.toLocaleString("en-IN")}`,
            meta: {
              level,
              ratePercentage: rate * 100,
              investmentAmount: numAmount,
              investorUserId: targetUser.userID,
              investorName: targetUser.name,
            },
          },
          { transaction: t }
        );

        commissionsDistributed.push({
          level,
          sponsorId: sponsor.id,
          sponsorUserID: sponsor.userID,
          sponsorName: sponsor.name,
          commissionAmount: commAmount,
        });
      }

      currentUserId = sponsor.id;
    }

    await t.commit();

    return res.status(200).json({
      success: true,
      msg: `Investment of ₹${numAmount.toLocaleString("en-IN")} successfully added for user ${targetUser.name} (${targetUser.userID})`,
      data: {
        targetUser: {
          id: targetUser.id,
          name: targetUser.name,
          userID: targetUser.userID,
        },
        investment: {
          totalInvested: Number(investment.totalInvested),
          activeInvestment: Number(investment.activeInvestment),
        },
        depositTransactionId: depositTxn.id,
        commissionsDistributed,
      },
    });
  } catch (err) {
    await t.rollback();
    console.error("Investment Topup Error:", err);
    return res.status(500).json({ msg: "Failed to process investment topup", error: err.message });
  }
});

/**
 * @route   GET /api/investment/my-wallet
 * @desc    Get current user's investment wallet balance, earnings, and transaction history.
 * @access  Authenticated User
 */
router.get("/my-wallet", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findByPk(userId, {
      attributes: ["id", "name", "userID", "email", "phone", "referralCode"],
    });

    let investment = await Investment.findOne({
      where: { userId },
    });

    if (!investment) {
      investment = {
        totalInvested: "0.00",
        activeInvestment: "0.00",
        roiBalance: "0.00",
        commissionBalance: "0.00",
        totalWithdrawn: "0.00",
        status: "INACTIVE",
      };
    }

    const roiBalance = Number(investment.roiBalance || 0);
    const commissionBalance = Number(investment.commissionBalance || 0);
    const availableBalance = roiBalance + commissionBalance;

    const recentTransactions = await InvestmentTransaction.findAll({
      where: { userId },
      include: [
        {
          model: User,
          as: "fromUser",
          attributes: ["id", "name", "userID"],
        },
      ],
      order: [["createdAt", "DESC"]],
      limit: 30,
    });

    return res.status(200).json({
      success: true,
      user,
      investment: {
        totalInvested: Number(investment.totalInvested || 0),
        activeInvestment: Number(investment.activeInvestment || 0),
        roiBalance,
        commissionBalance,
        totalWithdrawn: Number(investment.totalWithdrawn || 0),
        availableBalance,
        monthlyEstRoi: Number(investment.activeInvestment || 0) * 0.05,
        status: investment.status,
      },
      transactions: recentTransactions,
    });
  } catch (err) {
    console.error("Get My Investment Wallet Error:", err);
    return res.status(500).json({ msg: "Failed to fetch investment wallet details", error: err.message });
  }
});

/**
 * @route   GET /api/investment/admin/user-investment/:userID
 * @desc    Admin endpoint to view investment wallet of any specified user by userID or PK id.
 * @access  Admin / Master / Staff
 */
router.get("/admin/user-investment/:userID", auth, isAdmin, async (req, res) => {
  try {
    const { userID } = req.params;

    const targetUser = await User.findOne({
      where: {
        [Op.or]: [{ userID }, { id: isNaN(userID) ? 0 : Number(userID) }],
      },
      attributes: ["id", "name", "userID", "email", "phone", "sponsorId"],
    });

    if (!targetUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    const investment = await Investment.findOne({
      where: { userId: targetUser.id },
    });

    const transactions = await InvestmentTransaction.findAll({
      where: { userId: targetUser.id },
      include: [
        {
          model: User,
          as: "fromUser",
          attributes: ["id", "name", "userID"],
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    return res.status(200).json({
      success: true,
      targetUser,
      investment: investment || {
        totalInvested: 0,
        activeInvestment: 0,
        roiBalance: 0,
        commissionBalance: 0,
        totalWithdrawn: 0,
        status: "INACTIVE",
      },
      transactions,
    });
  } catch (err) {
    console.error("Admin View User Investment Error:", err);
    return res.status(500).json({ msg: "Failed to fetch user investment details", error: err.message });
  }
});

/**
 * @route   GET /api/investment/admin/all-investments
 * @desc    Admin summary list of all investment accounts.
 * @access  Admin / Master / Staff
 */
router.get("/admin/all-investments", auth, isAdmin, async (req, res) => {
  try {
    const investments = await Investment.findAll({
      include: [
        {
          model: User,
          attributes: ["id", "name", "userID", "email", "phone"],
        },
      ],
      order: [["totalInvested", "DESC"]],
    });

    return res.status(200).json({
      success: true,
      count: investments.length,
      investments,
    });
  } catch (err) {
    console.error("Admin Get All Investments Error:", err);
    return res.status(500).json({ msg: "Failed to fetch all investments", error: err.message });
  }
});

module.exports = router;
