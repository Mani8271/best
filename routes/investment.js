const express = require("express");
const { sequelize } = require("../config/db.js");
const { Op } = require("sequelize");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const auth = require("../middleware/auth.js");
const isAdmin = require("../middleware/isAdmin.js");

const User = require("../models/User.js");
const Wallet = require("../models/Wallet.js");
const WalletTransaction = require("../models/WalletTransaction.js");
const Investment = require("../models/Investment.js");
const InvestmentTransaction = require("../models/InvestmentTransaction.js");
const InvestmentWithdrawal = require("../models/InvestmentWithdrawal.js");
const InvestmentBankDetail = require("../models/InvestmentBankDetail.js");
const AppSetting = require("../models/AppSetting.js");
const { getSettingNumber, getSettingString, updateAppSettingString } = require("../config/settings.js");
const { processDailyPayouts } = require("../utils/dailyPayoutEngine.js");
const { processPayoutTransfers } = require("../utils/payoutTransferEngine.js");

const router = express.Router();

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET || "default_secret_key", { expiresIn: "7d" });

/**
 * Generate unique SD-prefixed User ID / Referral Code (e.g., SD566665)
 */
const generateInvestmentUserID = async (t) => {
  let isUnique = false;
  let newID = "";
  while (!isUnique) {
    const num = Math.floor(100000 + Math.random() * 900000); // 6 digits
    newID = `SD${num}`; // e.g. SD566665
    const existingUser = await User.findOne({
      where: {
        [Op.or]: [{ userID: newID }, { referralCode: newID }],
      },
      transaction: t,
    });
    if (!existingUser) {
      isUnique = true;
    }
  }
  return newID;
};

/* ======================================================================================
   🔑 PUBLIC SPONSOR / USER LOOKUP API (NO AUTH REQUIRED)
====================================================================================== */

/**
 * @route   GET /api/investment/sponsor-info/:userID
 * @desc    Public API (No Auth) to fetch user details (name, userID, etc.) by userID or referralCode
 * @access  Public
 */
router.get(["/sponsor-info/:userID", "/user-info/:userID", "/public-user/:userID"], async (req, res) => {
  try {
    const rawInput = (req.params.userID || req.query.userID || "").trim();
    if (!rawInput) {
      return res.status(400).json({ success: false, msg: "userID or referralCode parameter is required" });
    }

    const user = await User.findOne({
      where: {
        [Op.or]: [
          { userID: rawInput },
          { referralCode: rawInput },
          { userID: rawInput.toUpperCase() },
          { referralCode: rawInput.toUpperCase() },
          { email: rawInput.toLowerCase() },
          { id: isNaN(rawInput) ? 0 : Number(rawInput) },
        ],
      },
      attributes: ["id", "userID", "referralCode", "name", "email", "phone", "userType", "status", "createdAt"],
    });

    if (!user) {
      return res.status(404).json({ success: false, msg: "User / Sponsor not found" });
    }

    return res.status(200).json({
      success: true,
      exists: true,
      userID: user.userID,
      referralCode: user.referralCode,
      name: user.name,
      sponsorName: user.name,
      sponsorID: user.userID,
      email: user.email,
      phone: user.phone,
      userType: user.userType,
      status: user.status,
      user: {
        id: user.id,
        userID: user.userID,
        referralCode: user.referralCode,
        name: user.name,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
        status: user.status,
      },
    });
  } catch (err) {
    console.error("Public Sponsor Info Lookup Error:", err);
    return res.status(500).json({ success: false, msg: err.message });
  }
});

/* ======================================================================================
   🔑 DYNAMIC INVESTMENT REGISTER & LOGIN APIs
====================================================================================== */

/**
 * @route   POST /api/investment/register
 * @desc    Dedicated Register API for Investment Users (Generates SIxxxxxx ID e.g., SI566665).
 * @access  Public
 */
router.post("/register", async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { name, email, phone, password, referralCode } = req.body;

    if (!name || !email || !phone || !password) {
      await t.rollback();
      return res.status(400).json({ msg: "Please enter all required fields: name, email, phone, password." });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanPhone = String(phone).trim();

    // Auto-generate fresh unique SI-prefixed ID (e.g. SI566665)
    const newSI_ID = await generateInvestmentUserID(t);

    // If sponsor referralCode provided, look up sponsor
    let sponsorId = null;
    if (referralCode) {
      const cleanRefCode = String(referralCode).trim();
      const sponsorUser = await User.findOne({
        where: {
          [Op.or]: [
            { referralCode: cleanRefCode },
            { userID: cleanRefCode },
            { referralCode: cleanRefCode.toUpperCase() },
            { userID: cleanRefCode.toUpperCase() },
            { id: isNaN(cleanRefCode) ? 0 : Number(cleanRefCode) },
          ],
        },
        transaction: t,
      });

      if (sponsorUser) {
        sponsorId = sponsorUser.id;
      }
    }

    // Always create a FRESH User record specifically for Investment (plain text password so visible in Admin)
    const user = await User.create(
      {
        name: String(name).trim(),
        email: cleanEmail,
        phone: cleanPhone,
        password: String(password).trim(),
        userID: newSI_ID,
        referralCode: newSI_ID, // SI ID also serves as referral code (e.g. SI566665)
        sponsorId: sponsorId || null,
        role: "USER",
        userType: "INVESTMENT_USER",
        status: "INACTIVE",
      },
      { transaction: t }
    );

    // Automatically initialize Investment record for the user
    const [investment] = await Investment.findOrCreate({
      where: { userId: user.id },
      defaults: {
        totalInvested: 0,
        activeInvestment: 0,
        roiBalance: 0,
        commissionBalance: 0,
        totalWithdrawn: 0,
        status: "ACTIVE",
      },
      transaction: t,
    });

    await t.commit();

    const token = signToken(user.id);

    return res.status(201).json({
      success: true,
      msg: `User registered successfully with Investment ID: ${newSI_ID}`,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        userID: user.userID,
        referralCode: user.referralCode,
        sponsorId: user.sponsorId,
        role: user.role,
        userType: user.userType,
        status: user.status,
      },
      investment: {
        totalInvested: Number(investment.totalInvested || 0),
        activeInvestment: Number(investment.activeInvestment || 0),
        roiBalance: Number(investment.roiBalance || 0),
        commissionBalance: Number(investment.commissionBalance || 0),
        spotBalance: Number(investment.spotBalance || 0),
        referralBalance: Number(investment.spotBalance || 0),
        availableBalance: Number(investment.roiBalance || 0) + Number(investment.commissionBalance || 0),
        status: investment.status,
      },
    });
  } catch (err) {
    await t.rollback();
    console.error("Investment Register Error:", err);
    return res.status(500).json({ msg: "Registration failed", error: err.message });
  }
});

/**
 * @route   POST /api/investment/login
 * @desc    Dedicated Login API for Investment Users (using SIxxxxxx ID/email/phone & password).
 * @access  Public
 */
router.post("/login", async (req, res) => {
  try {
    const { userID, email, phone, password } = req.body;

    const targetLoginId = userID || email || phone;

    if (!targetLoginId || !password) {
      return res.status(400).json({ msg: "Please enter your User ID / Email / Phone and Password." });
    }

    const cleanLoginId = String(targetLoginId).trim();

    // Find user by userID, referralCode, email, or phone
    const user = await User.findOne({
      where: {
        [Op.or]: [
          { userID: cleanLoginId },
          { referralCode: cleanLoginId },
          { email: cleanLoginId.toLowerCase() },
          { phone: cleanLoginId },
        ],
      },
    });

    if (!user) {
      return res.status(400).json({ msg: "Invalid credentials. User not found." });
    }

    // Compare password (supports both bcrypt hash & plain text)
    let isMatch = false;
    const storedPass = String(user.password || "");
    if (storedPass.startsWith("$2a$") || storedPass.startsWith("$2b$") || storedPass.startsWith("$2y$")) {
      isMatch = await bcrypt.compare(String(password), storedPass);
    } else {
      isMatch = (String(password) === storedPass);
    }

    if (!isMatch) {
      return res.status(400).json({ msg: "Invalid credentials. Incorrect password." });
    }

    if (user.status === "INACTIVE_BY_ADMIN") {
      return res.status(403).json({ msg: "Your account has been suspended by admin." });
    }

    // Fetch user's Investment wallet
    let investment = await Investment.findOne({ where: { userId: user.id } });
    if (!investment) {
      investment = await Investment.create({
        userId: user.id,
        totalInvested: 0,
        activeInvestment: 0,
        roiBalance: 0,
        commissionBalance: 0,
        totalWithdrawn: 0,
        status: "ACTIVE",
      });
    }

    // Fetch Bank details saved status & Wallet
    const bankDetails = await InvestmentBankDetail.findOne({ where: { userId: user.id } });
    const userWallet = await Wallet.findOne({ where: { userId: user.id } });

    const token = signToken(user.id);

    return res.status(200).json({
      success: true,
      msg: "Login successful",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        userID: user.userID,
        referralCode: user.referralCode,
        sponsorId: user.sponsorId,
        role: user.role,
        userType: user.userType,
        status: user.status,
      },
      investment: {
        totalInvested: Number(investment.totalInvested || 0),
        activeInvestment: Number(investment.activeInvestment || 0),
        availableBalance: Number(userWallet?.balance || 0),
        roiBalance: Number(investment.roiBalance || 0),
        commissionBalance: Number(investment.commissionBalance || 0),
        spotBalance: Number(investment.spotBalance || 0),
        referralBalance: Number(investment.spotBalance || 0),
        totalWithdrawn: Number(investment.totalWithdrawn || 0),
        status: investment.status,
      },
      hasSavedBankDetails: !!bankDetails,
    });
  } catch (err) {
    console.error("Investment Login Error:", err);
    return res.status(500).json({ msg: "Login failed", error: err.message });
  }
});


/**
 * Helper function to build 4-level downline tree for any root user
 */
async function build4LevelTree(rootUserId) {
  const userInclude = [
    {
      model: Investment,
      required: false, // Include all downline users even if investment wallet is not yet initialized
      attributes: ["totalInvested", "activeInvestment", "status"],
    },
    {
      model: User,
      as: "sponsor",
      attributes: ["id", "name", "userID", "email", "phone", "referralCode"],
    },
  ];

  // Level 1
  const level1Users = await User.findAll({
    where: { sponsorId: rootUserId },
    attributes: ["id", "name", "userID", "email", "phone", "createdAt", "sponsorId", "referralCode"],
    include: userInclude,
  });
  const level1Ids = level1Users.map((u) => u.id);

  // Level 2
  let level2Users = [];
  if (level1Ids.length > 0) {
    level2Users = await User.findAll({
      where: { sponsorId: { [Op.in]: level1Ids } },
      attributes: ["id", "name", "userID", "email", "phone", "createdAt", "sponsorId", "referralCode"],
      include: userInclude,
    });
  }
  const level2Ids = level2Users.map((u) => u.id);

  // Level 3
  let level3Users = [];
  if (level2Ids.length > 0) {
    level3Users = await User.findAll({
      where: { sponsorId: { [Op.in]: level2Ids } },
      attributes: ["id", "name", "userID", "email", "phone", "createdAt", "sponsorId", "referralCode"],
      include: userInclude,
    });
  }
  const level3Ids = level3Users.map((u) => u.id);

  // Level 4
  let level4Users = [];
  if (level3Ids.length > 0) {
    level4Users = await User.findAll({
      where: { sponsorId: { [Op.in]: level3Ids } },
      attributes: ["id", "name", "userID", "email", "phone", "createdAt", "sponsorId", "referralCode"],
      include: userInclude,
    });
  }

  // Format user object with referredBy / sponsor details
  const formatUser = (u) => {
    const raw = u.toJSON ? u.toJSON() : u;
    return {
      ...raw,
      referredBy: raw.sponsor || null,
      sponsor: raw.sponsor || null,
    };
  };

  const formattedLevel1 = level1Users.map(formatUser);
  const formattedLevel2 = level2Users.map(formatUser);
  const formattedLevel3 = level3Users.map(formatUser);
  const formattedLevel4 = level4Users.map(formatUser);

  // Build Nested Hierarchical Tree (Level 1 -> Level 2 -> Level 3 -> Level 4)
  const level4Map = {};
  formattedLevel4.forEach((u) => {
    if (!level4Map[u.sponsorId]) level4Map[u.sponsorId] = [];
    level4Map[u.sponsorId].push({ ...u, referrals: [] });
  });

  const level3Map = {};
  formattedLevel3.forEach((u) => {
    if (!level3Map[u.sponsorId]) level3Map[u.sponsorId] = [];
    level3Map[u.sponsorId].push({
      ...u,
      referrals: level4Map[u.id] || [],
    });
  });

  const level2Map = {};
  formattedLevel2.forEach((u) => {
    if (!level2Map[u.sponsorId]) level2Map[u.sponsorId] = [];
    level2Map[u.sponsorId].push({
      ...u,
      referrals: level3Map[u.id] || [],
    });
  });

  const nestedTree = formattedLevel1.map((u) => ({
    ...u,
    referrals: level2Map[u.id] || [],
  }));

  const allDownlineUsers = [...formattedLevel1, ...formattedLevel2, ...formattedLevel3, ...formattedLevel4];
  const totalDownlines = allDownlineUsers.length;

  let totalActiveInvestment = 0;
  let totalInvested = 0;

  allDownlineUsers.forEach((u) => {
    if (u.Investment) {
      totalActiveInvestment += Number(u.Investment.activeInvestment || 0);
      totalInvested += Number(u.Investment.totalInvested || 0);
    }
  });

  return {
    summary: {
      totalDownlines,
      totalActiveInvestment: Number(totalActiveInvestment.toFixed(2)),
      totalInvested: Number(totalInvested.toFixed(2)),
      levelCounts: {
        level1: formattedLevel1.length,
        level2: formattedLevel2.length,
        level3: formattedLevel3.length,
        level4: formattedLevel4.length,
      },
    },
    tree: {
      level1: formattedLevel1,
      level2: formattedLevel2,
      level3: formattedLevel3,
      level4: formattedLevel4,
    },
    nestedTree,
  };
}

/* ======================================================================================
   ⚙️ DYNAMIC INVESTMENT ADMIN SETTINGS APIs
====================================================================================== */

/**
 * @route   GET /api/investment/admin/settings
 * @desc    Get all dynamic investment settings (Min withdrawal, ROI %, Level 1-4 Commission %).
 * @access  Admin / Master / Staff
 */
router.get("/admin/settings", auth, isAdmin, async (req, res) => {
  try {
    const minWithdrawalAmount = await getSettingNumber("INVESTMENT_MIN_WITHDRAWAL", 2500);
    const spotPercent = await getSettingNumber("INVESTMENT_SPOT_REFERRAL_PERCENT", 5);
    const roiPercent = await getSettingNumber("INVESTMENT_ROI_PERCENT", 5);
    const level1Percent = await getSettingNumber("INVESTMENT_LEVEL_1_PERCENT", 2);
    const level2Percent = await getSettingNumber("INVESTMENT_LEVEL_2_PERCENT", 1.5);
    const level3Percent = await getSettingNumber("INVESTMENT_LEVEL_3_PERCENT", 1.0);
    const level4Percent = await getSettingNumber("INVESTMENT_LEVEL_4_PERCENT", 0.5);
    const payoutTransferDay1 = await getSettingNumber("PAYOUT_TRANSFER_DAY_1", 10);
    const payoutTransferDay2 = await getSettingNumber("PAYOUT_TRANSFER_DAY_2", 25);

    return res.status(200).json({
      success: true,
      settings: {
        INVESTMENT_MIN_WITHDRAWAL: minWithdrawalAmount,
        minWithdrawalAmount,
        INVESTMENT_ROI_PERCENT: roiPercent,
        roiPercent,
        spotPercent,
        payoutTransferDay1,
        payoutTransferDay2,
        levelCommissions: {
          level1Percent,
          level2Percent,
          level3Percent,
          level4Percent,
        },
      },
    });
  } catch (err) {
    console.error("Get Investment Admin Settings Error:", err);
    return res.status(500).json({ msg: "Failed to fetch admin settings", error: err.message });
  }
});

/**
 * Helper to update key-value pair in AppSetting table
 */
async function updateAppSetting(key, val) {
  if (val !== undefined && !isNaN(Number(val))) {
    const num = Number(val);
    const [setting] = await AppSetting.findOrCreate({
      where: { key },
      defaults: { key, value: String(num) },
    });
    setting.value = String(num);
    await setting.save();
    return num;
  }
  return null;
}

/**
 * Shared handler for POST & PUT /api/investment/admin/settings.
 * Empty / missing fields are left unchanged; invalid values are rejected with 400
 * (so a blank form field can never silently set a percentage to 0).
 */
async function saveInvestmentSettings(req, res) {
  try {
    const {
      minWithdrawalAmount,
      value,
      roiPercent,
      level1Percent,
      level2Percent,
      level3Percent,
      level4Percent,
      payoutTransferDay1,
      payoutTransferDay2,
      payoutDay1,
      payoutDay2,
    } = req.body;

    const isBlank = (v) => v === undefined || v === null || String(v).trim() === "";
    const pick = (a, b) => (isBlank(a) ? b : a);

    const fields = [
      { key: "INVESTMENT_MIN_WITHDRAWAL", label: "Min withdrawal amount", val: pick(minWithdrawalAmount, value), min: 0, max: Infinity },
      { key: "INVESTMENT_ROI_PERCENT", label: "ROI %", val: roiPercent, min: 0, max: 100 },
      { key: "INVESTMENT_LEVEL_1_PERCENT", label: "Level 1 %", val: level1Percent, min: 0, max: 100 },
      { key: "INVESTMENT_LEVEL_2_PERCENT", label: "Level 2 %", val: level2Percent, min: 0, max: 100 },
      { key: "INVESTMENT_LEVEL_3_PERCENT", label: "Level 3 %", val: level3Percent, min: 0, max: 100 },
      { key: "INVESTMENT_LEVEL_4_PERCENT", label: "Level 4 %", val: level4Percent, min: 0, max: 100 },
      // Days capped at 28 so the transfer runs in every month (incl. February)
      { key: "PAYOUT_TRANSFER_DAY_1", label: "Payout transfer day 1", val: pick(payoutTransferDay1, payoutDay1), min: 1, max: 28, integer: true },
      { key: "PAYOUT_TRANSFER_DAY_2", label: "Payout transfer day 2", val: pick(payoutTransferDay2, payoutDay2), min: 1, max: 28, integer: true },
    ].filter((f) => !isBlank(f.val));

    // Validate everything first so a bad field doesn't leave settings half-saved
    for (const f of fields) {
      const num = Number(f.val);
      if (!Number.isFinite(num) || num < f.min || num > f.max || (f.integer && !Number.isInteger(num))) {
        const range = f.max === Infinity ? `>= ${f.min}` : `between ${f.min} and ${f.max}`;
        return res.status(400).json({ msg: `${f.label} must be ${f.integer ? "a whole number " : ""}${range}` });
      }
    }

    for (const f of fields) {
      await updateAppSetting(f.key, f.val);
    }

    const currentMinWithdrawal = await getSettingNumber("INVESTMENT_MIN_WITHDRAWAL", 2500);
    const currentRoi = await getSettingNumber("INVESTMENT_ROI_PERCENT", 5);
    const currentL1 = await getSettingNumber("INVESTMENT_LEVEL_1_PERCENT", 2);
    const currentL2 = await getSettingNumber("INVESTMENT_LEVEL_2_PERCENT", 1.5);
    const currentL3 = await getSettingNumber("INVESTMENT_LEVEL_3_PERCENT", 1.0);
    const currentL4 = await getSettingNumber("INVESTMENT_LEVEL_4_PERCENT", 0.5);
    const currentDay1 = await getSettingNumber("PAYOUT_TRANSFER_DAY_1", 10);
    const currentDay2 = await getSettingNumber("PAYOUT_TRANSFER_DAY_2", 25);

    return res.status(200).json({
      success: true,
      msg: "Dynamic investment settings updated successfully",
      settings: {
        minWithdrawalAmount: currentMinWithdrawal,
        roiPercent: currentRoi,
        payoutTransferDay1: currentDay1,
        payoutTransferDay2: currentDay2,
        levelCommissions: {
          level1Percent: currentL1,
          level2Percent: currentL2,
          level3Percent: currentL3,
          level4Percent: currentL4,
        },
      },
    });
  } catch (err) {
    console.error("Update Investment Admin Settings Error:", err);
    return res.status(500).json({ msg: "Failed to update admin settings", error: err.message });
  }
}

/**
 * @route   POST /api/investment/admin/settings
 * @desc    Update dynamic investment settings (Min withdrawal, ROI %, Level 1-4 Commission %, Payout Transfer Days).
 * @access  Admin / Master / Staff
 */
router.post("/admin/settings", auth, isAdmin, saveInvestmentSettings);

/**
 * @route   PUT /api/investment/admin/settings
 * @desc    PUT alias for updating dynamic investment settings.
 * @access  Admin / Master / Staff
 */
router.put("/admin/settings", auth, isAdmin, saveInvestmentSettings);

/**
 * @route   POST /api/investment/admin/trigger-payout-transfer
 * @desc    Manually trigger bi-monthly payout transfer engine on demand
 * @access  Admin / Master / Staff
 */
router.post("/admin/trigger-payout-transfer", auth, isAdmin, async (req, res) => {
  try {
    const result = await processPayoutTransfers();
    return res.status(200).json({
      msg: "Scheduled payout transfer executed successfully",
      result,
    });
  } catch (err) {
    console.error("Trigger Payout Transfer Error:", err);
    return res.status(500).json({ msg: "Failed to trigger payout transfers", error: err.message });
  }
});

/**
 * @route   POST /api/investment/admin/fix-balances
 * @desc    Recalculate & clean up user balances (Available Balance, ROI Balance, Commission Balance, Spot Balance)
 * @access  Admin / Master / Staff
 */
router.post("/admin/fix-balances", auth, isAdmin, async (req, res) => {
  try {
    const { userId } = req.body;
    let users = [];

    if (userId) {
      const u = await User.findByPk(userId);
      if (u) users = [u];
    } else {
      users = await User.findAll({ attributes: ["id"] });
    }

    let fixedCount = 0;
    for (const userNode of users) {
      const uId = userNode.id;
      const t = await sequelize.transaction();
      try {
        let wallet = await Wallet.findOne({ where: { userId: uId }, transaction: t, lock: t.LOCK.UPDATE });
        if (!wallet) {
          wallet = await Wallet.create({ userId: uId, balance: 0, spotBalance: 0, lockedBalance: 0, totalBalance: 0 }, { transaction: t });
        }

        let investment = await Investment.findOne({ where: { userId: uId }, transaction: t, lock: t.LOCK.UPDATE });
        if (!investment) {
          investment = await Investment.create({ userId: uId, totalInvested: 0, activeInvestment: 0, roiBalance: 0, commissionBalance: 0, spotBalance: 0, totalWithdrawn: 0, status: "ACTIVE" }, { transaction: t });
        }

        // Replay ROI / Commission ledger in order so withdrawals, refunds & payout transfers
        // are applied exactly like the live flows do.
        const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
        const ledger = await InvestmentTransaction.findAll({
          where: { userId: uId, type: ["DAILY_ROI", "DAILY_LEVEL_COMMISSION", "PAYOUT_TRANSFER", "WITHDRAWAL"] },
          order: [["id", "ASC"]],
          transaction: t,
        });

        let newRoiBalance = 0;
        let newCommissionBalance = 0;
        let withdrawnFromWallet = 0; // portion of withdrawal requests deducted directly from Wallet.balance (no WalletTransaction logged)

        for (const txn of ledger) {
          const amt = Number(txn.amount || 0);
          if (txn.type === "DAILY_ROI") {
            newRoiBalance = round2(newRoiBalance + amt);
          } else if (txn.type === "DAILY_LEVEL_COMMISSION") {
            newCommissionBalance = round2(newCommissionBalance + amt);
          } else if (txn.type === "PAYOUT_TRANSFER") {
            newRoiBalance = 0;
            newCommissionBalance = 0;
          } else if (txn.type === "WITHDRAWAL") {
            let meta = txn.meta || {};
            if (typeof meta === "string") {
              try { meta = JSON.parse(meta); } catch { meta = {}; }
            }
            const desc = String(txn.description || "");
            const status = meta.status || (desc.includes("REJECTED") ? "REJECTED" : desc.includes("PAID/APPROVED") ? "APPROVED" : "PENDING");

            if (status === "PENDING") {
              // Withdrawal request: deduct ROI -> Commission -> Wallet (same order as /withdraw/request)
              let remaining = amt;
              const fromRoi = Math.min(newRoiBalance, remaining);
              newRoiBalance = round2(newRoiBalance - fromRoi);
              remaining = round2(remaining - fromRoi);
              const fromComm = Math.min(newCommissionBalance, remaining);
              newCommissionBalance = round2(newCommissionBalance - fromComm);
              remaining = round2(remaining - fromComm);
              withdrawnFromWallet = round2(withdrawnFromWallet + remaining);
            } else if (status === "REJECTED") {
              // Reject flow refunds full amount into ROI balance
              newRoiBalance = round2(newRoiBalance + amt);
            }
          }
        }

        const [spotResult] = await sequelize.query(
          `SELECT SUM(amount) AS sumSpot FROM InvestmentTransactions WHERE userId = :uId AND type = 'LEVEL_COMMISSION' AND (JSON_EXTRACT(meta, '$.isSpotCommission') = true OR description LIKE '%Direct Spot%')`,
          { replacements: { uId }, transaction: t }
        );
        const totalSpotEarned = Math.round((Number(spotResult[0]?.sumSpot || 0) + Number.EPSILON) * 100) / 100;

        const [spotDebitResult] = await sequelize.query(
          `SELECT SUM(amount) AS sumSpotDebits FROM WalletTransactions WHERE walletId = :walletId AND type = 'DEBIT' AND JSON_EXTRACT(meta, '$.walletType') = 'SPOT' AND status IN ('APPROVED', 'PENDING')`,
          { replacements: { walletId: wallet.id }, transaction: t }
        );
        const totalSpotDebits = Math.round((Number(spotDebitResult[0]?.sumSpotDebits || 0) + Number.EPSILON) * 100) / 100;
        const totalSpotBalance = Math.max(0, Math.round((totalSpotEarned - totalSpotDebits + Number.EPSILON) * 100) / 100);

        const [walletBalResult] = await sequelize.query(
          `SELECT 
            SUM(CASE 
              WHEN type = 'CREDIT' AND (JSON_EXTRACT(meta, '$.isPayoutTransfer') = true OR (reason = 'TOPUP' AND JSON_EXTRACT(meta, '$.depositRequestId') IS NULL AND JSON_EXTRACT(meta, '$.isSpotCommission') IS NULL)) THEN amount 
              WHEN type = 'DEBIT' AND (JSON_EXTRACT(meta, '$.walletType') IS NULL OR JSON_EXTRACT(meta, '$.walletType') = 'MAIN') THEN -amount 
              ELSE 0 
            END) AS calcBalance
           FROM WalletTransactions 
           WHERE walletId = :walletId AND status = 'APPROVED'`,
          { replacements: { walletId: wallet.id }, transaction: t }
        );
        const newWalletBalance = Math.max(0, Math.round((Number(walletBalResult[0]?.calcBalance || 0) - withdrawnFromWallet + Number.EPSILON) * 100) / 100);

        investment.roiBalance = newRoiBalance;
        investment.commissionBalance = newCommissionBalance;
        investment.spotBalance = totalSpotBalance;
        await investment.save({ transaction: t });

        wallet.balance = newWalletBalance;
        wallet.spotBalance = totalSpotBalance;
        wallet.totalBalance = Math.round((newWalletBalance + totalSpotBalance + Number(wallet.lockedBalance || 0) + Number.EPSILON) * 100) / 100;
        await wallet.save({ transaction: t });

        await t.commit();
        fixedCount++;
      } catch (e) {
        await t.rollback();
        console.error(`Error fixing balance for user ${uId}:`, e);
      }
    }

    return res.status(200).json({
      success: true,
      msg: `Successfully recalculated & fixed balances for ${fixedCount} user(s).`,
    });
  } catch (err) {
    console.error("Fix Balances Admin API Error:", err);
    return res.status(500).json({ msg: "Failed to fix balances", error: err.message });
  }
});


/**
 * @route   POST /api/investment/admin/topup
 * @desc    Admin loads investment money into a user's Investment Wallet by userID.
 *          Automatically distributes 4-Level commissions to upline sponsors.
 * @access  Admin / Master / Staff
 */
router.post("/admin/topup", auth, isAdmin, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { userID, userId, amount, remark } = req.body;

    const numAmount = Number(amount);

    if (!numAmount || isNaN(numAmount) || numAmount <= 0) {
      await t.rollback();
      return res.status(400).json({
        msg: "Please enter a valid investment amount greater than 0.",
      });
    }

    // Search user by userID string (e.g. SI566665) or primary key id
    let whereClause = {};
    if (userID) {
      whereClause = { userID: String(userID).trim() };
    } else if (userId) {
      whereClause = { id: Number(userId) };
    } else {
      await t.rollback();
      return res.status(400).json({ msg: "Please provide target user ID or userID (e.g., SI566665)" });
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

    // Activate user account if currently INACTIVE
    if (targetUser.status !== "ACTIVE") {
      targetUser.status = "ACTIVE";
      if (!targetUser.activationDate) {
        targetUser.activationDate = new Date();
      }
      await targetUser.save({ transaction: t });
    }

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

    // 3. Direct Sponsor 5% ONE-TIME Spot Commission Distribution on Topup
    const commissionsDistributed = [];

    if (targetUser.sponsorId) {
      const spotPct = await getSettingNumber("INVESTMENT_SPOT_REFERRAL_PERCENT", 5);
      const rate = spotPct / 100;

      if (rate > 0) {
        const sponsor = await User.findByPk(targetUser.sponsorId, {
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        if (sponsor) {
          const commAmount = Number((numAmount * rate).toFixed(2));

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
              createdAdminId: req.user.id,
              description: `Direct Spot Referral Commission (${rate * 100}%) from ${targetUser.name} (${targetUser.userID}) investment of ₹${numAmount.toLocaleString("en-IN")}`,
              meta: {
                level: 1,
                isSpotCommission: true,
                ratePercentage: rate * 100,
                investmentAmount: numAmount,
                investorUserId: targetUser.userID,
                investorName: targetUser.name,
              },
            },
            { transaction: t }
          );

          commissionsDistributed.push({
            level: 1,
            sponsorId: sponsor.id,
            sponsorUserID: sponsor.userID,
            sponsorName: sponsor.name,
            commissionAmount: commAmount,
          });
        }
      }
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
          sponsorId: targetUser.sponsorId,
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

/* ======================================================================================
   🌳 4-LEVEL REFERRAL TREE & SPONSOR ANALYTICS APIs
====================================================================================== */

/**
 * @route   GET /api/investment/referral-info
 * @desc    Get logged-in user's referral code, userID, and referral info.
 * @access  Authenticated User
 */
router.get("/referral-info", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findByPk(userId, {
      attributes: ["id", "name", "userID", "email", "phone", "referralCode", "sponsorId"],
      include: [
        {
          model: User,
          as: "sponsor",
          attributes: ["id", "name", "userID", "referralCode"],
        },
      ],
    });

    const refCode = user.referralCode || user.userID;
    const referralUrl = `https://investment.mysun.in/investment-register?ref=${refCode}`;

    return res.status(200).json({
      success: true,
      referralInfo: {
        userID: user.userID,
        referralCode: refCode,
        sponsor: user.sponsor || null,
        referralLink: referralUrl,
        url: referralUrl,
      },
      url: referralUrl,
    });
  } catch (err) {
    console.error("Get Referral Info Error:", err);
    return res.status(500).json({ success: false, msg: "Failed to fetch referral info", error: err.message });
  }
});

/**
 * @route   GET /api/investment/referral-link
 * @desc    Get logged-in user's investment referral link.
 * @access  Authenticated User
 */
router.get("/referral-link", auth, async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: ["id", "name", "userID", "referralCode"],
    });

    const refCode = user.referralCode || user.userID;
    const referralUrl = `https://investment.mysun.in/investment-register?ref=${refCode}`;

    return res.status(200).json({
      success: true,
      userID: user.userID,
      referralCode: refCode,
      name: user.name,
      url: referralUrl,
      referralUrl,
    });
  } catch (err) {
    console.error("Get Referral Link Error:", err);
    return res.status(500).json({ success: false, msg: err.message });
  }
});

/**
 * @route   GET /api/investment/tree
 * @desc    Get logged-in user's 4-Level Downline Investment Tree.
 * @access  Authenticated User
 */
router.get("/tree", auth, async (req, res) => {
  try {
    const rootUserId = req.user.id;
    const treeData = await build4LevelTree(rootUserId);

    return res.status(200).json({
      success: true,
      ...treeData,
    });
  } catch (err) {
    console.error("Get 4-Level Investment Tree Error:", err);
    return res.status(500).json({ msg: "Failed to fetch 4-level tree", error: err.message });
  }
});

/**
 * @route   GET /api/investment/admin/user-tree/:userID
 * @desc    Admin endpoint to view 4-Level Investment Tree of any user by userID or PK id.
 * @access  Admin / Master / Staff
 */
router.get("/admin/user-tree/:userID", auth, isAdmin, async (req, res) => {
  try {
    const { userID } = req.params;

    const targetUser = await User.findOne({
      where: {
        [Op.or]: [{ userID }, { id: isNaN(userID) ? 0 : Number(userID) }],
      },
      attributes: ["id", "name", "userID", "email", "phone"],
    });

    if (!targetUser) {
      return res.status(404).json({ msg: "User not found" });
    }

    const treeData = await build4LevelTree(targetUser.id);

    return res.status(200).json({
      success: true,
      targetUser,
      ...treeData,
    });
  } catch (err) {
    console.error("Admin View User Tree Error:", err);
    return res.status(500).json({ msg: "Failed to fetch user tree", error: err.message });
  }
});

/* ======================================================================================
   🏦 DEDICATED INVESTMENT BANK DETAILS APIs
====================================================================================== */

/**
 * @route   POST /api/investment/bank-details
 * @desc    Save or update dedicated Investment Bank Details for the logged-in user.
 * @access  Authenticated User
 */
router.post("/bank-details", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { accountNumber, ifscCode, accountHolderName, bankName, branchName, bankPhoto } = req.body;

    if (!accountNumber || !ifscCode || !accountHolderName) {
      return res.status(400).json({
        msg: "accountNumber, ifscCode, and accountHolderName are required",
      });
    }

    const [bankDetail, created] = await InvestmentBankDetail.findOrCreate({
      where: { userId },
      defaults: {
        userId,
        accountNumber: String(accountNumber).trim(),
        ifscCode: String(ifscCode).trim().toUpperCase(),
        accountHolderName: String(accountHolderName).trim(),
        bankName: bankName ? String(bankName).trim() : null,
        branchName: branchName ? String(branchName).trim() : null,
        bankPhoto: bankPhoto || null,
        isVerified: true,
      },
    });

    if (!created) {
      bankDetail.accountNumber = String(accountNumber).trim();
      bankDetail.ifscCode = String(ifscCode).trim().toUpperCase();
      bankDetail.accountHolderName = String(accountHolderName).trim();
      if (bankName !== undefined) bankDetail.bankName = bankName ? String(bankName).trim() : null;
      if (branchName !== undefined) bankDetail.branchName = branchName ? String(branchName).trim() : null;
      if (bankPhoto !== undefined) bankDetail.bankPhoto = bankPhoto || null;
      bankDetail.isVerified = true;
      await bankDetail.save();
    }

    return res.status(200).json({
      success: true,
      msg: created ? "Investment bank details saved successfully" : "Investment bank details updated successfully",
      bankDetails: bankDetail,
    });
  } catch (err) {
    console.error("Save Investment Bank Details Error:", err);
    return res.status(500).json({ msg: "Failed to save bank details", error: err.message });
  }
});

/**
 * @route   PUT /api/investment/bank-details
 * @desc    Edit / Update dedicated Investment Bank Details for the logged-in user.
 * @access  Authenticated User
 */
router.put("/bank-details", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { accountNumber, ifscCode, accountHolderName, bankName, branchName, bankPhoto } = req.body;

    let bankDetail = await InvestmentBankDetail.findOne({
      where: { userId },
    });

    if (!bankDetail) {
      if (!accountNumber || !ifscCode || !accountHolderName) {
        return res.status(400).json({
          msg: "No existing bank details found. Please provide accountNumber, ifscCode, and accountHolderName to create.",
        });
      }

      bankDetail = await InvestmentBankDetail.create({
        userId,
        accountNumber: String(accountNumber).trim(),
        ifscCode: String(ifscCode).trim().toUpperCase(),
        accountHolderName: String(accountHolderName).trim(),
        bankName: bankName ? String(bankName).trim() : null,
        branchName: branchName ? String(branchName).trim() : null,
        bankPhoto: bankPhoto || null,
        isVerified: true,
      });
    } else {
      if (accountNumber !== undefined) bankDetail.accountNumber = String(accountNumber).trim();
      if (ifscCode !== undefined) bankDetail.ifscCode = String(ifscCode).trim().toUpperCase();
      if (accountHolderName !== undefined) bankDetail.accountHolderName = String(accountHolderName).trim();
      if (bankName !== undefined) bankDetail.bankName = bankName ? String(bankName).trim() : null;
      if (branchName !== undefined) bankDetail.branchName = branchName ? String(branchName).trim() : null;
      if (bankPhoto !== undefined) bankDetail.bankPhoto = bankPhoto || null;
      bankDetail.isVerified = true;
      await bankDetail.save();
    }

    return res.status(200).json({
      success: true,
      msg: "Investment bank details updated successfully",
      bankDetails: bankDetail,
    });
  } catch (err) {
    console.error("Edit Investment Bank Details Error:", err);
    return res.status(500).json({ msg: "Failed to update bank details", error: err.message });
  }
});

/**
 * @route   GET /api/investment/bank-details
 * @desc    Get logged-in user's saved Investment Bank Details.
 * @access  Authenticated User
 */
router.get("/bank-details", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const bankDetail = await InvestmentBankDetail.findOne({
      where: { userId },
    });

    return res.status(200).json({
      success: true,
      bankDetails: bankDetail || null,
    });
  } catch (err) {
    console.error("Get Investment Bank Details Error:", err);
    return res.status(500).json({ msg: "Failed to fetch bank details", error: err.message });
  }
});

/**
 * @route   GET /api/investment/my-wallet
 * @desc    Get current user's investment wallet balance, earnings, saved bank details, and transaction history.
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

    const bankDetails = await InvestmentBankDetail.findOne({
      where: { userId },
    });

    const userWallet = await Wallet.findOne({ where: { userId } });

    const minWithdrawalAmount = await getSettingNumber("INVESTMENT_MIN_WITHDRAWAL", 2500);

    const roiBalance = Number(investment.roiBalance || 0);
    const commissionBalance = Number(investment.commissionBalance || 0);
    // Wallet.spotBalance is the withdrawable source of truth for spot/referral earnings
    const spotBalance = Number(userWallet ? userWallet.spotBalance || 0 : investment.spotBalance || 0);
    const referralBalance = spotBalance;
    const walletBalance = Number(userWallet?.balance || 0);
    const availableBalance = walletBalance;

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

    const withdrawalWindow = await checkWithdrawalWindow();

    return res.status(200).json({
      success: true,
      user,
      investment: {
        totalInvested: Number(investment.totalInvested || 0),
        activeInvestment: Number(investment.activeInvestment || 0),
        roiBalance,
        commissionBalance,
        spotBalance,
        referralBalance,
        totalWithdrawn: Number(investment.totalWithdrawn || 0),
        availableBalance,
        minWithdrawalAmount,
        monthlyEstRoi: Number(investment.activeInvestment || 0) * 0.05,
        status: investment.status,
      },
      withdrawalWindow,
      hasSavedBankDetails: !!bankDetails,
      bankDetails: bankDetails || null,
      transactions: recentTransactions,
    });
  } catch (err) {
    console.error("Get My Investment Wallet Error:", err);
    return res.status(500).json({ msg: "Failed to fetch investment wallet details", error: err.message });
  }
});

/* Shared helpers for ROI / Referral history APIs */
const istDate = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const istTime = (d) => new Date(d).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true }).toUpperCase();
const parseMeta = (m) => {
  if (typeof m === "string") {
    try { return JSON.parse(m); } catch { return {}; }
  }
  return m || {};
};
const getPaging = (query = {}) => ({
  page: Math.max(1, Number(query.page) || 1),
  limit: Math.max(1, Math.min(Number(query.limit) || 10, 100)), // Default 10 items per page
});
const paginate = (items, page, limit) => {
  const totalItems = items.length;
  const totalPages = Math.ceil(totalItems / limit);
  return {
    currentPage: page,
    limit,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
    transactions: items.slice((page - 1) * limit, page * limit),
  };
};
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Admin routes accept either userID string (e.g. SI566665) or numeric id */
const findUserByIdOrUserID = (userID) =>
  User.findOne({
    where: { [Op.or]: [{ userID }, { id: isNaN(userID) ? 0 : Number(userID) }] },
    attributes: ["id", "name", "userID"],
  });

/**
 * ROI credits that make up the user's current ROI balance, i.e. DAILY_ROI entries for payout dates
 * after the latest payout transfer (scheduled day 10/25 from settings, or the user's last PAYOUT_TRANSFER).
 */
async function getRoiCycleHistory(userId, query = {}) {
  const { page, limit } = getPaging(query);
  const pad = (n) => String(n).padStart(2, "0");

  // 1. Latest scheduled payout day on or before today (IST)
  const todayStr = istDate(new Date());
  const [y, m, d] = todayStr.split("-").map(Number);
  const payoutDays = [
    await getSettingNumber("PAYOUT_TRANSFER_DAY_1", 10),
    await getSettingNumber("PAYOUT_TRANSFER_DAY_2", 25),
  ].sort((a, b) => a - b);

  let cycleStartAfter;
  const pastDaysThisMonth = payoutDays.filter((day) => day <= d);
  if (pastDaysThisMonth.length > 0) {
    cycleStartAfter = `${y}-${pad(m)}-${pad(Math.max(...pastDaysThisMonth))}`;
  } else {
    const prevY = m === 1 ? y - 1 : y;
    const prevM = m === 1 ? 12 : m - 1;
    cycleStartAfter = `${prevY}-${pad(prevM)}-${pad(Math.max(...payoutDays))}`;
  }

  // 2. User's last actual payout transfer (covers manual admin-triggered transfers)
  const lastTransfer = await InvestmentTransaction.findOne({
    where: { userId, type: "PAYOUT_TRANSFER" },
    order: [["id", "DESC"]],
  });
  if (lastTransfer) {
    const transferDate = parseMeta(lastTransfer.meta).date || istDate(lastTransfer.createdAt);
    if (transferDate > cycleStartAfter) cycleStartAfter = transferDate;
  }

  const investment = await Investment.findOne({ where: { userId }, attributes: ["roiBalance"] });

  const rows = await InvestmentTransaction.findAll({
    where: { userId, type: "DAILY_ROI" },
    order: [["id", "DESC"]],
  });

  const transactions = [];
  let totalCredited = 0;
  for (const row of rows) {
    const meta = parseMeta(row.meta);
    const forDate = meta.date || istDate(row.createdAt);
    if (forDate <= cycleStartAfter) continue;

    const amount = Number(row.amount || 0);
    totalCredited += amount;
    transactions.push({
      id: row.id,
      amount,
      type: "CREDIT",
      date: istDate(row.createdAt),
      time: istTime(row.createdAt),
      forDate,
      activeInvestment: meta.activeInvestment !== undefined ? Number(meta.activeInvestment) : null,
      description: row.description,
    });
  }

  return {
    roiBalance: Number(investment?.roiBalance || 0),
    cycleStartAfter,
    totalCredited: round2(totalCredited),
    ...paginate(transactions, page, limit),
  };
}

/**
 * Full Referral (Spot) wallet history: spot commission credits + spot wallet withdrawals, newest first.
 * Balance is Wallet.spotBalance (the withdrawable source of truth).
 * Optional query: type=CREDIT|DEBIT to filter.
 */
async function getReferralHistory(userId, query = {}) {
  const { page, limit } = getPaging(query);
  const typeFilter = String(query.type || "").trim().toUpperCase();

  const wallet = await Wallet.findOne({ where: { userId } });

  // Credits: Direct Spot Referral Commissions (matched by description too, in case old rows have a blank type)
  const creditRows = await InvestmentTransaction.findAll({
    where: {
      userId,
      [Op.or]: [
        { type: "LEVEL_COMMISSION" },
        { description: { [Op.like]: "Direct Spot Referral Commission%" } },
      ],
    },
    include: [{ model: User, as: "fromUser", attributes: ["id", "name", "userID"] }],
  });

  const items = [];
  let totalEarned = 0;
  for (const row of creditRows) {
    const meta = parseMeta(row.meta);
    const isSpot = meta.isSpotCommission === true || String(row.description || "").includes("Direct Spot");
    if (!isSpot) continue;

    const amount = Number(row.amount || 0);
    totalEarned += amount;
    items.push({
      id: `C-${row.id}`,
      type: "CREDIT",
      category: "REFERRAL_COMMISSION",
      amount,
      status: "APPROVED",
      fromName: row.fromUser?.name || meta.investorName || null,
      fromUserID: row.fromUser?.userID || meta.investorUserId || null,
      investmentAmount: meta.investmentAmount !== undefined ? Number(meta.investmentAmount) : null,
      ratePercentage: meta.ratePercentage !== undefined ? Number(meta.ratePercentage) : null,
      date: istDate(row.createdAt),
      time: istTime(row.createdAt),
      createdAt: row.createdAt,
      description: row.description,
    });
  }

  // Debits: withdrawal requests made from the SPOT wallet (REJECTED ones were refunded to the spot balance)
  let totalWithdrawn = 0;
  if (wallet) {
    const withdrawalRows = await WalletTransaction.findAll({
      where: { walletId: wallet.id, type: "DEBIT", reason: "WITHDRAWAL_REQUEST" },
    });

    for (const row of withdrawalRows) {
      const meta = parseMeta(row.meta);
      if (meta.walletType !== "SPOT") continue;

      const amount = Number(row.amount || 0);
      if (row.status !== "REJECTED") totalWithdrawn += amount;
      items.push({
        id: `D-${row.id}`,
        type: "DEBIT",
        category: "WITHDRAWAL",
        amount,
        status: row.status,
        netAmount: meta.netAmount !== undefined ? Number(meta.netAmount) : null,
        totalDeduction: meta.totalDeduction !== undefined ? Number(meta.totalDeduction) : null,
        payoutMethod: row.payoutMethod || null,
        transactionId: row.transactionId || null,
        adminNote: row.adminNote || null,
        date: istDate(row.createdAt),
        time: istTime(row.createdAt),
        createdAt: row.createdAt,
        description:
          row.status === "REJECTED"
            ? `Withdrawal of ₹${amount.toLocaleString("en-IN")} rejected, amount returned to referral balance`
            : `Withdrawal of ₹${amount.toLocaleString("en-IN")} (${row.status})`,
      });
    }
  }

  const filtered = typeFilter === "CREDIT" || typeFilter === "DEBIT" ? items.filter((i) => i.type === typeFilter) : items;
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return {
    referralBalance: Number(wallet?.spotBalance || 0),
    totalEarned: round2(totalEarned),
    totalWithdrawn: round2(totalWithdrawn),
    ...paginate(filtered, page, limit),
  };
}

/**
 * @route   GET /api/investment/referral-history
 * @desc    Logged-in user's Referral (Spot) balance + all referral credits & withdrawals, paginated.
 * @access  Authenticated User
 * Query:   page=1&limit=10&type=CREDIT|DEBIT
 */
router.get("/referral-history", auth, async (req, res) => {
  try {
    const result = await getReferralHistory(req.user.id, req.query);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("Get Referral History Error:", err);
    return res.status(500).json({ success: false, msg: "Failed to fetch referral history", error: err.message });
  }
});

/**
 * @route   GET /api/investment/admin/referral-history/:userID
 * @desc    Admin: any user's Referral (Spot) balance + all referral credits & withdrawals, paginated.
 * @access  Admin / Master / Staff
 */
router.get("/admin/referral-history/:userID", auth, isAdmin, async (req, res) => {
  try {
    const targetUser = await findUserByIdOrUserID(req.params.userID);
    if (!targetUser) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    const result = await getReferralHistory(targetUser.id, req.query);
    return res.status(200).json({
      success: true,
      user: { id: targetUser.id, name: targetUser.name, userID: targetUser.userID },
      ...result,
    });
  } catch (err) {
    console.error("Admin Get Referral History Error:", err);
    return res.status(500).json({ success: false, msg: "Failed to fetch referral history", error: err.message });
  }
});

/**
 * All withdrawals of a user, newest first, from both flows:
 *  - INVESTMENT: InvestmentWithdrawal requests (POST /api/investment/withdraw/request)
 *  - WALLET / SPOT: WalletTransaction WITHDRAWAL_REQUEST debits (POST /api/withdrawals)
 * Optional query: status=PENDING|APPROVED|REJECTED to filter.
 */
async function getWithdrawalHistory(userId, query = {}) {
  const { page, limit } = getPaging(query);
  const statusFilter = String(query.status || "").trim().toUpperCase();

  const items = [];

  const investmentRows = await InvestmentWithdrawal.findAll({ where: { userId } });
  for (const row of investmentRows) {
    const amount = Number(row.amount || 0);
    items.push({
      id: `I-${row.id}`,
      source: "INVESTMENT",
      amount,
      netAmount: amount,
      totalDeduction: 0,
      status: row.status,
      payoutMethod: "BANK",
      transactionId: row.utrNumber || null,
      adminNote: row.adminRemark || null,
      bankName: row.bankName || null,
      bankAccountNumber: row.bankAccountNumber || null,
      ifscCode: row.ifscCode || null,
      accountHolderName: row.accountHolderName || null,
      processedAt: row.processedAt || null,
      date: istDate(row.createdAt),
      time: istTime(row.createdAt),
      createdAt: row.createdAt,
      description: `Withdrawal of ₹${amount.toLocaleString("en-IN")} (${row.status})`,
    });
  }

  const wallet = await Wallet.findOne({ where: { userId } });
  if (wallet) {
    const walletRows = await WalletTransaction.findAll({
      where: { walletId: wallet.id, type: "DEBIT", reason: "WITHDRAWAL_REQUEST" },
    });
    for (const row of walletRows) {
      const meta = parseMeta(row.meta);
      const amount = Number(row.amount || 0);
      items.push({
        id: `W-${row.id}`,
        source: meta.walletType === "SPOT" ? "SPOT" : "WALLET",
        amount,
        netAmount: meta.netAmount !== undefined ? Number(meta.netAmount) : amount,
        totalDeduction: meta.totalDeduction !== undefined ? Number(meta.totalDeduction) : 0,
        gstAmount: meta.gstAmount !== undefined ? Number(meta.gstAmount) : null,
        adminFeeAmount: meta.adminFeeAmount !== undefined ? Number(meta.adminFeeAmount) : null,
        status: row.status,
        payoutMethod: row.payoutMethod || null,
        transactionId: row.transactionId || null,
        adminNote: row.adminNote || null,
        processedAt: row.processedAt || null,
        date: istDate(row.createdAt),
        time: istTime(row.createdAt),
        createdAt: row.createdAt,
        description:
          row.status === "REJECTED"
            ? `Withdrawal of ₹${amount.toLocaleString("en-IN")} rejected, amount refunded`
            : `Withdrawal of ₹${amount.toLocaleString("en-IN")} (${row.status})`,
      });
    }
  }

  const summary = { totalWithdrawn: 0, totalNetPaid: 0, pendingAmount: 0, rejectedAmount: 0 };
  for (const i of items) {
    if (i.status === "APPROVED") {
      summary.totalWithdrawn += i.amount;
      summary.totalNetPaid += i.netAmount;
    } else if (i.status === "PENDING") {
      summary.pendingAmount += i.amount;
    } else if (i.status === "REJECTED") {
      summary.rejectedAmount += i.amount;
    }
  }

  const filtered = ["PENDING", "APPROVED", "REJECTED"].includes(statusFilter)
    ? items.filter((i) => i.status === statusFilter)
    : items;
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return {
    totalWithdrawn: round2(summary.totalWithdrawn),
    totalNetPaid: round2(summary.totalNetPaid),
    pendingAmount: round2(summary.pendingAmount),
    rejectedAmount: round2(summary.rejectedAmount),
    ...paginate(filtered, page, limit),
  };
}

/**
 * @route   GET /api/investment/withdrawal-history
 * @desc    Logged-in user's withdrawal totals + all withdrawal transactions (investment, wallet & spot), paginated.
 * @access  Authenticated User
 * Query:   page=1&limit=10&status=PENDING|APPROVED|REJECTED
 */
router.get("/withdrawal-history", auth, async (req, res) => {
  try {
    const result = await getWithdrawalHistory(req.user.id, req.query);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("Get Withdrawal History Error:", err);
    return res.status(500).json({ success: false, msg: "Failed to fetch withdrawal history", error: err.message });
  }
});

/**
 * @route   GET /api/investment/admin/withdrawal-history/:userID
 * @desc    Admin: any user's withdrawal totals + all withdrawal transactions, paginated.
 * @access  Admin / Master / Staff
 */
router.get("/admin/withdrawal-history/:userID", auth, isAdmin, async (req, res) => {
  try {
    const targetUser = await findUserByIdOrUserID(req.params.userID);
    if (!targetUser) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    const result = await getWithdrawalHistory(targetUser.id, req.query);
    return res.status(200).json({
      success: true,
      user: { id: targetUser.id, name: targetUser.name, userID: targetUser.userID },
      ...result,
    });
  } catch (err) {
    console.error("Admin Get Withdrawal History Error:", err);
    return res.status(500).json({ success: false, msg: "Failed to fetch withdrawal history", error: err.message });
  }
});

const AVAILABLE_CATEGORY_LABELS = {
  PAYOUT_TRANSFER: "Payout transfer",
  TOPUP: "Wallet top-up",
  PAIR_BONUS: "Pair bonus",
  DOWNLINE_PAIR_BONUS: "Downline pair bonus",
  REFERRAL_JOIN_BONUS: "Referral join bonus",
  REFUND: "Refund",
  WITHDRAWAL_REFUND: "Withdrawal refund",
  WITHDRAWAL: "Withdrawal",
  ORDER_PAYMENT: "Order payment",
};

/**
 * Available (main Wallet.balance) history: every WalletTransaction that moved Wallet.balance, newest first.
 * Excluded because they never touch Wallet.balance:
 *  - deposit TOPUPs (meta.depositRequestId) -> credited to activeInvestment
 *  - spot commission TOPUPs (meta.isSpotCommission) and SPOT withdrawals / their refunds -> spotBalance
 *  - still-pending bonuses (meta.pending) -> lockedBalance until released
 * Optional query: type=CREDIT|DEBIT to filter.
 */
async function getAvailableBalanceHistory(userId, query = {}) {
  const { page, limit } = getPaging(query);
  const typeFilter = String(query.type || "").trim().toUpperCase();

  const wallet = await Wallet.findOne({ where: { userId } });
  const rows = wallet ? await WalletTransaction.findAll({ where: { walletId: wallet.id } }) : [];

  const withdrawalWalletType = new Map();
  for (const row of rows) {
    if (row.reason === "WITHDRAWAL_REQUEST") withdrawalWalletType.set(row.id, parseMeta(row.meta).walletType);
  }

  const items = [];
  let totalCredited = 0;
  let totalDebited = 0;
  for (const row of rows) {
    const meta = parseMeta(row.meta);

    if (meta.pending === true || meta.depositRequestId || meta.isSpotCommission) continue;
    if (row.reason === "WITHDRAWAL_REQUEST" && meta.walletType === "SPOT") continue;
    if (row.reason === "WITHDRAWAL_REFUND" && withdrawalWalletType.get(Number(meta.originalWithdrawalId)) === "SPOT") continue;

    let category = row.reason;
    if (meta.isPayoutTransfer) category = "PAYOUT_TRANSFER";
    else if (row.reason === "WITHDRAWAL_REQUEST") category = "WITHDRAWAL";

    const amount = Number(row.amount || 0);
    if (row.type === "CREDIT") totalCredited += amount;
    else totalDebited += amount;

    let description = AVAILABLE_CATEGORY_LABELS[category] || category;
    if (category === "PAYOUT_TRANSFER") {
      description += ` (ROI: ₹${Number(meta.transferredRoi || 0).toLocaleString("en-IN")}, Comm: ₹${Number(meta.transferredCommission || 0).toLocaleString("en-IN")})`;
    } else if (category === "WITHDRAWAL") {
      description += ` (${row.status})`;
    }

    items.push({
      id: row.id,
      type: row.type,
      category,
      amount,
      status: row.status || "APPROVED",
      netAmount: category === "WITHDRAWAL" && meta.netAmount !== undefined ? Number(meta.netAmount) : null,
      totalDeduction: category === "WITHDRAWAL" && meta.totalDeduction !== undefined ? Number(meta.totalDeduction) : null,
      transactionId: row.transactionId || null,
      adminNote: row.adminNote || null,
      orderId: row.orderId || null,
      date: istDate(row.createdAt),
      time: istTime(row.createdAt),
      createdAt: row.createdAt,
      description,
    });
  }

  const filtered = typeFilter === "CREDIT" || typeFilter === "DEBIT" ? items.filter((i) => i.type === typeFilter) : items;
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return {
    availableBalance: Number(wallet?.balance || 0),
    totalCredited: round2(totalCredited),
    totalDebited: round2(totalDebited),
    ...paginate(filtered, page, limit),
  };
}

/**
 * @route   GET /api/investment/available-balance-history
 * @desc    Logged-in user's Available (Wallet) balance + every credit/debit that moved it, paginated.
 * @access  Authenticated User
 * Query:   page=1&limit=10&type=CREDIT|DEBIT
 */
router.get("/available-balance-history", auth, async (req, res) => {
  try {
    const result = await getAvailableBalanceHistory(req.user.id, req.query);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("Get Available Balance History Error:", err);
    return res.status(500).json({ success: false, msg: "Failed to fetch available balance history", error: err.message });
  }
});

/**
 * @route   GET /api/investment/admin/available-balance-history/:userID
 * @desc    Admin: any user's Available (Wallet) balance + every credit/debit that moved it, paginated.
 * @access  Admin / Master / Staff
 */
router.get("/admin/available-balance-history/:userID", auth, isAdmin, async (req, res) => {
  try {
    const targetUser = await findUserByIdOrUserID(req.params.userID);
    if (!targetUser) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    const result = await getAvailableBalanceHistory(targetUser.id, req.query);
    return res.status(200).json({
      success: true,
      user: { id: targetUser.id, name: targetUser.name, userID: targetUser.userID },
      ...result,
    });
  } catch (err) {
    console.error("Admin Get Available Balance History Error:", err);
    return res.status(500).json({ success: false, msg: "Failed to fetch available balance history", error: err.message });
  }
});

/* ======================================================================================
   📊 LEVEL INCENTIVE APIs (Level 1-4 downline members & daily level commission history)
====================================================================================== */

const MAX_INCENTIVE_LEVEL = 4;

class ApiError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

const sendApiError = (res, err, logLabel) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ success: false, msg: err.message });
  }
  console.error(`${logLabel}:`, err);
  return res.status(500).json({ success: false, msg: "Failed to fetch level incentives", error: err.message });
};

const parseLevel = (value) => {
  const level = Number(value);
  if (!Number.isInteger(level) || level < 1 || level > MAX_INCENTIVE_LEVEL) {
    throw new ApiError(400, `Level must be between 1 and ${MAX_INCENTIVE_LEVEL}`);
  }
  return level;
};

async function getLevelRates() {
  return {
    1: await getSettingNumber("INVESTMENT_LEVEL_1_PERCENT", 2),
    2: await getSettingNumber("INVESTMENT_LEVEL_2_PERCENT", 1.5),
    3: await getSettingNumber("INVESTMENT_LEVEL_3_PERCENT", 1.0),
    4: await getSettingNumber("INVESTMENT_LEVEL_4_PERCENT", 0.5),
  };
}

/** Downline users per level via Users.sponsorId: index 0 = Level 1 (direct referrals) ... index 3 = Level 4 */
async function getDownlineLevels(userId) {
  const levels = [];
  const visited = new Set([userId]);
  let currentIds = [userId];

  for (let level = 1; level <= MAX_INCENTIVE_LEVEL; level++) {
    if (currentIds.length === 0) {
      levels.push([]);
      continue;
    }
    const users = (
      await User.findAll({
        where: { sponsorId: currentIds },
        attributes: ["id", "name", "userID", "status"],
        order: [["id", "ASC"]],
      })
    ).filter((u) => !visited.has(u.id)); // guard against bad sponsor loops

    users.forEach((u) => visited.add(u.id));
    levels.push(users);
    currentIds = users.map((u) => u.id);
  }
  return levels;
}

/** Whether the viewer currently earns level commissions (same rule as dailyPayoutEngine) */
async function isIncentiveEligible(userId) {
  const [user, investment] = await Promise.all([
    User.findByPk(userId, { attributes: ["id", "status"] }),
    Investment.findOne({ where: { userId }, attributes: ["status", "activeInvestment"] }),
  ]);
  return (
    !!user &&
    user.status !== "INACTIVE_BY_ADMIN" &&
    !!investment &&
    investment.status === "ACTIVE" &&
    Number(investment.activeInvestment || 0) > 0
  );
}

/** Builds per-member rows (investment, per-day incentive, total earned) for one level */
async function buildLevelMembers(viewerId, level, members, ratePercent, eligible) {
  const memberIds = members.map((m) => m.id);
  if (memberIds.length === 0) return [];

  const investments = await Investment.findAll({
    where: { userId: memberIds },
    attributes: ["userId", "status", "activeInvestment"],
  });
  const investmentByUser = new Map(investments.map((i) => [i.userId, i]));

  const earnedRows = await InvestmentTransaction.findAll({
    where: { userId: viewerId, type: "DAILY_LEVEL_COMMISSION", level, fromUserId: memberIds },
    attributes: ["fromUserId", [sequelize.fn("SUM", sequelize.col("amount")), "earned"]],
    group: ["fromUserId"],
    raw: true,
  });
  const earnedByUser = new Map(earnedRows.map((r) => [Number(r.fromUserId), Number(r.earned || 0)]));

  return members.map((m) => {
    const inv = investmentByUser.get(m.id);
    const activeInvestment = inv && inv.status === "ACTIVE" ? Number(inv.activeInvestment || 0) : 0;
    const earning = eligible && m.status !== "INACTIVE_BY_ADMIN" && activeInvestment > 0;
    return {
      userId: m.id,
      userID: m.userID,
      name: m.name,
      activeInvestment,
      incentivePerDay: earning ? round2(activeInvestment * (ratePercent / 100 / 30)) : 0,
      totalEarned: round2(earnedByUser.get(m.id) || 0),
    };
  });
}

/** Screen 1: Level 1-4 cards (members, amount, incentive per day, total earned) */
async function getLevelIncentiveSummary(viewerId) {
  const [downline, rates, eligible] = await Promise.all([
    getDownlineLevels(viewerId),
    getLevelRates(),
    isIncentiveEligible(viewerId),
  ]);

  const levels = [];
  for (let level = 1; level <= MAX_INCENTIVE_LEVEL; level++) {
    const rows = await buildLevelMembers(viewerId, level, downline[level - 1], rates[level], eligible);
    levels.push({
      level,
      ratePercent: rates[level],
      members: rows.length,
      activeMembers: rows.filter((r) => r.activeInvestment > 0).length,
      totalAmount: round2(rows.reduce((s, r) => s + r.activeInvestment, 0)),
      incentivePerDay: round2(rows.reduce((s, r) => s + r.incentivePerDay, 0)),
      totalEarned: round2(rows.reduce((s, r) => s + r.totalEarned, 0)),
    });
  }

  return { eligible, levels };
}

/** Screen 2: members of one level, paginated (highest investment first) */
async function getLevelIncentiveMembers(viewerId, levelParam, query = {}) {
  const level = parseLevel(levelParam);
  const { page, limit } = getPaging(query);
  const [downline, rates, eligible] = await Promise.all([
    getDownlineLevels(viewerId),
    getLevelRates(),
    isIncentiveEligible(viewerId),
  ]);

  const rows = await buildLevelMembers(viewerId, level, downline[level - 1], rates[level], eligible);
  rows.sort((a, b) => b.activeInvestment - a.activeInvestment || String(a.name).localeCompare(String(b.name)));

  const { transactions: members, ...paging } = paginate(rows, page, limit);
  return { eligible, level, ratePercent: rates[level], ...paging, members };
}

/** Screen 3: one member's daily commission history at that level, with running total, paginated */
async function getLevelIncentiveMemberTransactions(viewerId, levelParam, memberParam, query = {}) {
  const level = parseLevel(levelParam);
  const { page, limit } = getPaging(query);
  const newestFirst = String(query.order || "").toLowerCase() === "desc";

  const member = await findUserByIdOrUserID(memberParam);
  const downline = await getDownlineLevels(viewerId);
  if (!member || !downline[level - 1].some((m) => m.id === member.id)) {
    throw new ApiError(404, `Member not found in Level ${level}`);
  }

  const memberInvestment = await Investment.findOne({ where: { userId: member.id }, attributes: ["activeInvestment"] });

  const rows = await InvestmentTransaction.findAll({
    where: { userId: viewerId, type: "DAILY_LEVEL_COMMISSION", level, fromUserId: member.id },
    order: [["id", "ASC"]],
  });

  let runningTotal = 0;
  const items = rows.map((row) => {
    const meta = parseMeta(row.meta);
    const amount = Number(row.amount || 0);
    runningTotal = round2(runningTotal + amount);
    return {
      id: row.id,
      date: meta.date || istDate(row.createdAt),
      time: istTime(row.createdAt),
      amount,
      runningTotal,
      investorActiveInvestment: meta.investorActiveInvestment !== undefined ? Number(meta.investorActiveInvestment) : null,
      ratePercentage: meta.ratePercentage !== undefined ? Number(meta.ratePercentage) : null,
    };
  });
  if (newestFirst) items.reverse();

  return {
    level,
    member: {
      userId: member.id,
      userID: member.userID,
      name: member.name,
      activeInvestment: Number(memberInvestment?.activeInvestment || 0),
    },
    totalEarned: runningTotal,
    ...paginate(items, page, limit),
  };
}

/** Resolves the target user for admin level-incentive routes */
async function resolveAdminTarget(userIDParam) {
  const targetUser = await findUserByIdOrUserID(userIDParam);
  if (!targetUser) throw new ApiError(404, "User not found");
  return { user: { id: targetUser.id, name: targetUser.name, userID: targetUser.userID }, id: targetUser.id };
}

/**
 * @route   GET /api/investment/level-incentives
 * @desc    Level 1-4 incentive cards for the logged-in user.
 * @access  Authenticated User
 */
router.get("/level-incentives", auth, async (req, res) => {
  try {
    const result = await getLevelIncentiveSummary(req.user.id);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    return sendApiError(res, err, "Get Level Incentives Error");
  }
});

/**
 * @route   GET /api/investment/level-incentives/:level/members
 * @desc    Members of one level with their investment & incentive, paginated.
 * @access  Authenticated User
 * Query:   page=1&limit=10
 */
router.get("/level-incentives/:level/members", auth, async (req, res) => {
  try {
    const result = await getLevelIncentiveMembers(req.user.id, req.params.level, req.query);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    return sendApiError(res, err, "Get Level Incentive Members Error");
  }
});

/**
 * @route   GET /api/investment/level-incentives/:level/members/:memberId/transactions
 * @desc    Daily commission history from one member (with running total), paginated.
 * @access  Authenticated User
 * Query:   page=1&limit=10&order=asc|desc (default asc = oldest first)
 */
router.get("/level-incentives/:level/members/:memberId/transactions", auth, async (req, res) => {
  try {
    const result = await getLevelIncentiveMemberTransactions(req.user.id, req.params.level, req.params.memberId, req.query);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    return sendApiError(res, err, "Get Level Incentive Transactions Error");
  }
});

/**
 * @route   GET /api/investment/admin/level-incentives/:userID
 * @desc    Admin: Level 1-4 incentive cards for any user.
 * @access  Admin / Master / Staff
 */
router.get("/admin/level-incentives/:userID", auth, isAdmin, async (req, res) => {
  try {
    const target = await resolveAdminTarget(req.params.userID);
    const result = await getLevelIncentiveSummary(target.id);
    return res.status(200).json({ success: true, user: target.user, ...result });
  } catch (err) {
    return sendApiError(res, err, "Admin Get Level Incentives Error");
  }
});

/**
 * @route   GET /api/investment/admin/level-incentives/:userID/:level/members
 * @desc    Admin: members of one level for any user, paginated.
 * @access  Admin / Master / Staff
 */
router.get("/admin/level-incentives/:userID/:level/members", auth, isAdmin, async (req, res) => {
  try {
    const target = await resolveAdminTarget(req.params.userID);
    const result = await getLevelIncentiveMembers(target.id, req.params.level, req.query);
    return res.status(200).json({ success: true, user: target.user, ...result });
  } catch (err) {
    return sendApiError(res, err, "Admin Get Level Incentive Members Error");
  }
});

/**
 * @route   GET /api/investment/admin/level-incentives/:userID/:level/members/:memberId/transactions
 * @desc    Admin: daily commission history from one member for any user, paginated.
 * @access  Admin / Master / Staff
 */
router.get("/admin/level-incentives/:userID/:level/members/:memberId/transactions", auth, isAdmin, async (req, res) => {
  try {
    const target = await resolveAdminTarget(req.params.userID);
    const result = await getLevelIncentiveMemberTransactions(target.id, req.params.level, req.params.memberId, req.query);
    return res.status(200).json({ success: true, user: target.user, ...result });
  } catch (err) {
    return sendApiError(res, err, "Admin Get Level Incentive Transactions Error");
  }
});

/**
 * @route   GET /api/investment/roi-history
 * @desc    Logged-in user's ROI balance + ROI credits since the last payout.
 * @access  Authenticated User
 */
router.get("/roi-history", auth, async (req, res) => {
  try {
    const result = await getRoiCycleHistory(req.user.id, req.query);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    console.error("Get ROI History Error:", err);
    return res.status(500).json({ success: false, msg: "Failed to fetch ROI history", error: err.message });
  }
});

/**
 * @route   GET /api/investment/admin/roi-history/:userID
 * @desc    Admin: any user's ROI balance + ROI credits since the last payout (by userID string or numeric id).
 * @access  Admin / Master / Staff
 */
router.get("/admin/roi-history/:userID", auth, isAdmin, async (req, res) => {
  try {
    const targetUser = await findUserByIdOrUserID(req.params.userID);
    if (!targetUser) {
      return res.status(404).json({ success: false, msg: "User not found" });
    }

    const result = await getRoiCycleHistory(targetUser.id, req.query);
    return res.status(200).json({
      success: true,
      user: { id: targetUser.id, name: targetUser.name, userID: targetUser.userID },
      ...result,
    });
  } catch (err) {
    console.error("Admin Get ROI History Error:", err);
    return res.status(500).json({ success: false, msg: "Failed to fetch ROI history", error: err.message });
  }
});

/**
 * @route   GET /api/investment/my-transactions
 * @desc    Get current logged-in user's investment transaction history with pagination & optional type/date filters.
 * @access  Authenticated User
 * Query:   page=1&limit=10&type=DAILY_ROI&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
router.get("/my-transactions", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 10, 100)); // Default 10 items per page
    const offset = (page - 1) * limit;

    const { type, startDate, endDate, date, today } = req.query;

    const where = { userId };

    if (type && String(type).trim() !== "") {
      where.type = String(type).trim().toUpperCase();
    }

    if (today === "true") {
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);

      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 59, 999);

      where.createdAt = { [Op.between]: [startOfToday, endOfToday] };
    } else if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);

      const end = new Date(date);
      end.setHours(23, 59, 59, 999);

      where.createdAt = { [Op.between]: [start, end] };
    } else if (startDate && endDate) {
      const start = new Date(startDate);
      start.setHours(0, 0, 0, 0);

      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);

      where.createdAt = { [Op.between]: [start, end] };
    }

    const { count, rows } = await InvestmentTransaction.findAndCountAll({
      where,
      include: [
        {
          model: User,
          as: "fromUser",
          attributes: ["id", "name", "userID"],
        },
      ],
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

    const totalPages = Math.ceil(count / limit);

    return res.status(200).json({
      success: true,
      currentPage: page,
      limit,
      totalItems: count,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      transactions: rows,
    });
  } catch (err) {
    console.error("Get My Investment Transactions Error:", err);
    return res.status(500).json({ success: false, msg: "Failed to fetch transactions", error: err.message });
  }
});

/* ======================================================================================
   🗓️ INVESTMENT WITHDRAWAL DATES / WINDOW CONFIGURATION APIs
====================================================================================== */

/**
 * Helper function to check if withdrawal window is open today
 */
async function checkWithdrawalWindow() {
  const startDateStr = await getSettingString("INVESTMENT_WITHDRAWAL_START_DATE", "");
  const endDateStr = await getSettingString("INVESTMENT_WITHDRAWAL_END_DATE", "");
  const enabledStr = await getSettingString("INVESTMENT_WITHDRAWAL_ENABLED", "true");

  const isEnabled = enabledStr.toLowerCase() !== "false";

  if (!isEnabled) {
    return {
      isAllowedNow: false,
      isEnabled: false,
      startDate: startDateStr || null,
      endDate: endDateStr || null,
      message: "Withdrawal requests are currently disabled by Admin.",
    };
  }

  if (!startDateStr || !endDateStr) {
    return {
      isAllowedNow: true,
      isEnabled: true,
      startDate: startDateStr || null,
      endDate: endDateStr || null,
      message: "Withdrawals are open.",
    };
  }

  const today = new Date();
  const todayStr = today.toISOString().split("T")[0]; // YYYY-MM-DD
  const todayDay = today.getDate(); // 1 to 31

  let isAllowedNow = false;

  // Check if dates are formatted as YYYY-MM-DD (e.g. 2026-09-10 to 2026-09-15)
  if (startDateStr.includes("-") && endDateStr.includes("-")) {
    isAllowedNow = todayStr >= startDateStr && todayStr <= endDateStr;
  } else {
    // Check if dates are formatted as day numbers (e.g. "10" and "15")
    const startDay = Number(startDateStr);
    const endDay = Number(endDateStr);
    if (!isNaN(startDay) && !isNaN(endDay)) {
      if (startDay <= endDay) {
        isAllowedNow = todayDay >= startDay && todayDay <= endDay;
      } else {
        isAllowedNow = todayDay >= startDay || todayDay <= endDay;
      }
    } else {
      isAllowedNow = true;
    }
  }

  return {
    isAllowedNow,
    isEnabled: true,
    date1: startDateStr,
    date2: endDateStr,
    startDate: startDateStr,
    endDate: endDateStr,
    message: isAllowedNow
      ? `Withdrawals are open from ${startDateStr} to ${endDateStr}.`
      : `Withdrawals are currently closed. Allowed withdrawal window is from ${startDateStr} to ${endDateStr}.`,
  };
}

/**
 * @route   GET /api/investment/withdrawal-window
 * @desc    Get current withdrawal window dates configuration and live open/closed status.
 * @access  Authenticated User / Admin
 */
router.get("/withdrawal-window", auth, async (req, res) => {
  try {
    const windowInfo = await checkWithdrawalWindow();
    return res.status(200).json({
      success: true,
      withdrawalWindow: windowInfo,
    });
  } catch (err) {
    console.error("Get Withdrawal Window Error:", err);
    return res.status(500).json({ msg: "Failed to fetch withdrawal window dates", error: err.message });
  }
});

/**
 * @route   POST /api/investment/admin/withdrawal-window
 * @desc    Admin sets 2 withdrawal dates (date1 and date2) and optionally enables/disables withdrawals.
 *          Payload body: { date1: "2026-09-10", date2: "2026-09-15" } or day of month numbers: { date1: "10", date2: "15" }.
 * @access  Admin / Master / Staff
 */
router.post("/admin/withdrawal-window", auth, isAdmin, async (req, res) => {
  try {
    const { date1, date2, startDate, endDate, isEnabled } = req.body;

    const targetDate1 = date1 !== undefined ? date1 : startDate;
    const targetDate2 = date2 !== undefined ? date2 : endDate;

    if (targetDate1 !== undefined) {
      await updateAppSettingString("INVESTMENT_WITHDRAWAL_START_DATE", targetDate1);
    }
    if (targetDate2 !== undefined) {
      await updateAppSettingString("INVESTMENT_WITHDRAWAL_END_DATE", targetDate2);
    }
    if (isEnabled !== undefined) {
      await updateAppSettingString("INVESTMENT_WITHDRAWAL_ENABLED", isEnabled ? "true" : "false");
    }

    const windowInfo = await checkWithdrawalWindow();

    return res.status(200).json({
      success: true,
      msg: "Withdrawal window dates updated successfully",
      withdrawalWindow: windowInfo,
    });
  } catch (err) {
    console.error("Update Admin Withdrawal Window Error:", err);
    return res.status(500).json({ msg: "Failed to update withdrawal window dates", error: err.message });
  }
});

/**
 * PUT alias for updating withdrawal window
 */
router.put("/admin/withdrawal-window", auth, isAdmin, async (req, res) => {
  req.url = "/admin/withdrawal-window";
  return router.handle(req, res);
});

/* ======================================================================================
   💸 INVESTMENT WITHDRAWAL WORKFLOW APIs
====================================================================================== */

/**
 * @route   POST /api/investment/withdraw/request
 * @desc    User submits an investment withdrawal request.
 *          Minimum withdrawal limit is checked dynamically via Admin settings (default ₹2,500).
 *          Automatically fetches and attaches the user's saved InvestmentBankDetail.
 *          Deducts amount from available investment wallet balance and sets status to PENDING.
 * @access  Authenticated User
 */
router.post("/withdraw/request", auth, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const userId = req.user.id;
    const { amount } = req.body;

    const numAmount = Number(amount);
    const MIN_WITHDRAWAL = await getSettingNumber("INVESTMENT_MIN_WITHDRAWAL", 2500);

    if (!numAmount || isNaN(numAmount) || numAmount < MIN_WITHDRAWAL) {
      await t.rollback();
      return res.status(400).json({
        msg: `Minimum withdrawal amount is ₹${MIN_WITHDRAWAL.toLocaleString("en-IN")}`,
      });
    }

    // 1. Check if user has saved InvestmentBankDetail
    const bankDetail = await InvestmentBankDetail.findOne({
      where: { userId },
      transaction: t,
    });

    if (!bankDetail) {
      await t.rollback();
      return res.status(400).json({
        msg: "Please save your Investment Bank Details first at POST /api/investment/bank-details before requesting a withdrawal.",
      });
    }

    let investment = await Investment.findOne({
      where: { userId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!investment) {
      await t.rollback();
      return res.status(400).json({ msg: "No active investment wallet found" });
    }

    let wallet = await Wallet.findOne({
      where: { userId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    const currentRoi = Number(investment.roiBalance || 0);
    const currentComm = Number(investment.commissionBalance || 0);
    const currentWalletBal = Number(wallet?.balance || 0);
    const totalAvailable = currentRoi + currentComm + currentWalletBal;

    if (numAmount > totalAvailable) {
      await t.rollback();
      return res.status(400).json({
        msg: `Insufficient available balance. Available: ₹${totalAvailable.toLocaleString("en-IN")}, Requested: ₹${numAmount.toLocaleString("en-IN")}`,
      });
    }

    // 2. Deduct amount from balances (prioritize ROI balance -> commission balance -> wallet balance)
    let remainingToDeduct = numAmount;
    if (currentRoi >= remainingToDeduct) {
      investment.roiBalance = currentRoi - remainingToDeduct;
      remainingToDeduct = 0;
    } else {
      investment.roiBalance = 0;
      remainingToDeduct -= currentRoi;
      if (currentComm >= remainingToDeduct) {
        investment.commissionBalance = currentComm - remainingToDeduct;
        remainingToDeduct = 0;
      } else {
        investment.commissionBalance = 0;
        remainingToDeduct -= currentComm;
        if (wallet) {
          wallet.balance = Math.max(0, currentWalletBal - remainingToDeduct);
          await wallet.save({ transaction: t });
        }
      }
    }

    await investment.save({ transaction: t });

    // 3. Create InvestmentWithdrawal record with attached bank details from InvestmentBankDetail
    const withdrawalReq = await InvestmentWithdrawal.create(
      {
        userId,
        investmentId: investment.id,
        amount: numAmount,
        status: "PENDING",
        bankAccountNumber: bankDetail.accountNumber,
        ifscCode: bankDetail.ifscCode,
        accountHolderName: bankDetail.accountHolderName,
        bankName: bankDetail.bankName,
      },
      { transaction: t }
    );

    // 4. Create audit transaction log
    await InvestmentTransaction.create(
      {
        userId,
        type: "WITHDRAWAL",
        amount: numAmount,
        description: `Withdrawal request of ₹${numAmount.toLocaleString("en-IN")} submitted (Status: PENDING)`,
        meta: {
          withdrawalId: withdrawalReq.id,
          status: "PENDING",
          bankAccountNumber: bankDetail.accountNumber,
          ifscCode: bankDetail.ifscCode,
          accountHolderName: bankDetail.accountHolderName,
        },
      },
      { transaction: t }
    );

    await t.commit();

    return res.status(201).json({
      success: true,
      msg: `Withdrawal request of ₹${numAmount.toLocaleString("en-IN")} submitted successfully using your saved Investment Bank Details. Pending Admin manual payout.`,
      withdrawal: withdrawalReq,
      attachedBankDetails: {
        accountNumber: bankDetail.accountNumber,
        ifscCode: bankDetail.ifscCode,
        accountHolderName: bankDetail.accountHolderName,
        bankName: bankDetail.bankName,
      },
    });
  } catch (err) {
    await t.rollback();
    console.error("Investment Withdraw Request Error:", err);
    return res.status(500).json({ msg: "Failed to submit withdrawal request", error: err.message });
  }
});

/**
 * @route   GET /api/investment/withdraw/my-requests
 * @desc    Get current user's investment withdrawal history with live status updates.
 * @access  Authenticated User
 */
router.get("/withdraw/my-requests", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const withdrawals = await InvestmentWithdrawal.findAll({
      where: { userId },
      order: [["createdAt", "DESC"]],
    });

    return res.status(200).json({
      success: true,
      count: withdrawals.length,
      withdrawals,
    });
  } catch (err) {
    console.error("Get My Withdrawals Error:", err);
    return res.status(500).json({ msg: "Failed to fetch withdrawal requests", error: err.message });
  }
});

/**
 * @route   GET /api/investment/admin/withdrawals
 * @desc    Admin lists all investment withdrawal requests with optional status filter (PENDING, APPROVED, REJECTED, ALL).
 * @access  Admin / Master / Staff
 */
router.get("/admin/withdrawals", auth, isAdmin, async (req, res) => {
  try {
    const { status, fromDate, toDate, from, to } = req.query;

    let whereClause = {};
    if (status && status.toUpperCase() !== "ALL" && ["PENDING", "APPROVED", "REJECTED"].includes(status.toUpperCase())) {
      whereClause.status = status.toUpperCase();
    }

    const startDateStr = fromDate || from;
    const endDateStr = toDate || to;

    if (startDateStr || endDateStr) {
      whereClause.createdAt = {};
      if (startDateStr) {
        const start = new Date(startDateStr);
        if (!isNaN(start.getTime())) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(String(startDateStr).trim())) {
            start.setHours(0, 0, 0, 0);
          }
          whereClause.createdAt[Op.gte] = start;
        }
      }
      if (endDateStr) {
        const end = new Date(endDateStr);
        if (!isNaN(end.getTime())) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(String(endDateStr).trim())) {
            end.setHours(23, 59, 59, 999);
          }
          whereClause.createdAt[Op.lte] = end;
        }
      }
    }

    const withdrawals = await InvestmentWithdrawal.findAll({
      where: whereClause,
      include: [
        {
          model: User,
          attributes: ["id", "name", "userID", "email", "phone"],
        },
      ],
      order: [["createdAt", "DESC"]],
    });

    return res.status(200).json({
      success: true,
      count: withdrawals.length,
      withdrawals,
    });
  } catch (err) {
    console.error("Admin Get Withdrawals Error:", err);
    return res.status(500).json({ msg: "Failed to fetch withdrawal requests", error: err.message });
  }
});

/**
 * @route   PUT /api/investment/admin/withdrawals/:id/process
 * @desc    Admin processes a withdrawal request: APPROVE (with UTR reference) or REJECT (refunds balance).
 * @access  Admin / Master / Staff
 */
router.post("/admin/withdrawals/:id/process", auth, isAdmin, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const withdrawalId = req.params.id;
    const { action, utrNumber, adminRemark } = req.body;

    if (!action || !["APPROVE", "REJECT"].includes(action.toUpperCase())) {
      await t.rollback();
      return res.status(400).json({ msg: "Action must be APPROVE or REJECT" });
    }

    const withdrawal = await InvestmentWithdrawal.findByPk(withdrawalId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!withdrawal) {
      await t.rollback();
      return res.status(404).json({ msg: "Withdrawal request not found" });
    }

    if (withdrawal.status !== "PENDING") {
      await t.rollback();
      return res.status(400).json({
        msg: `Withdrawal request has already been processed with status: ${withdrawal.status}`,
      });
    }

    const isApprove = action.toUpperCase() === "APPROVE";
    const numAmount = Number(withdrawal.amount);

    if (isApprove) {
      withdrawal.status = "APPROVED";
      withdrawal.utrNumber = utrNumber || `UTR-${Date.now()}`;
      withdrawal.adminRemark = adminRemark || "Payout sent manually by Admin";
      withdrawal.processedByAdminId = req.user.id;
      withdrawal.processedAt = new Date();
      await withdrawal.save({ transaction: t });

      // Update totalWithdrawn in Investment wallet
      let investment = await Investment.findOne({
        where: { userId: withdrawal.userId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (investment) {
        investment.totalWithdrawn = Number(investment.totalWithdrawn || 0) + numAmount;
        await investment.save({ transaction: t });
      }

      // Log successful transaction
      await InvestmentTransaction.create(
        {
          userId: withdrawal.userId,
          type: "WITHDRAWAL",
          amount: numAmount,
          createdAdminId: req.user.id,
          description: `Withdrawal of ₹${numAmount.toLocaleString("en-IN")} PAID/APPROVED (UTR: ${withdrawal.utrNumber})`,
          meta: {
            withdrawalId: withdrawal.id,
            status: "APPROVED",
            utrNumber: withdrawal.utrNumber,
            adminRemark: withdrawal.adminRemark,
          },
        },
        { transaction: t }
      );
    } else {
      // REJECT: Refund money back to user's investment wallet
      withdrawal.status = "REJECTED";
      withdrawal.adminRemark = adminRemark || "Withdrawal request rejected by Admin";
      withdrawal.processedByAdminId = req.user.id;
      withdrawal.processedAt = new Date();
      await withdrawal.save({ transaction: t });

      let investment = await Investment.findOne({
        where: { userId: withdrawal.userId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (investment) {
        investment.roiBalance = Number(investment.roiBalance || 0) + numAmount;
        await investment.save({ transaction: t });
      }

      // Log refund transaction
      await InvestmentTransaction.create(
        {
          userId: withdrawal.userId,
          type: "WITHDRAWAL",
          amount: numAmount,
          createdAdminId: req.user.id,
          description: `Withdrawal request of ₹${numAmount.toLocaleString("en-IN")} REJECTED by Admin. Amount refunded to wallet.`,
          meta: {
            withdrawalId: withdrawal.id,
            status: "REJECTED",
            adminRemark: withdrawal.adminRemark,
          },
        },
        { transaction: t }
      );
    }

    await t.commit();

    return res.status(200).json({
      success: true,
      msg: `Withdrawal request successfully ${isApprove ? "APPROVED" : "REJECTED"}.`,
      withdrawal,
    });
  } catch (err) {
    await t.rollback();
    console.error("Process Withdrawal Error:", err);
    return res.status(500).json({ msg: "Failed to process withdrawal request", error: err.message });
  }
});

/**
 * PUT alias for processing withdrawal
 */
router.put("/admin/withdrawals/:id/process", auth, isAdmin, async (req, res) => {
  req.url = `/admin/withdrawals/${req.params.id}/process`;
  return router.handle(req, res);
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

    const bankDetails = await InvestmentBankDetail.findOne({
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

    const withdrawals = await InvestmentWithdrawal.findAll({
      where: { userId: targetUser.id },
      order: [["createdAt", "DESC"]],
    });

    return res.status(200).json({
      success: true,
      targetUser,
      bankDetails: bankDetails || null,
      investment: investment || {
        totalInvested: 0,
        activeInvestment: 0,
        roiBalance: 0,
        commissionBalance: 0,
        totalWithdrawn: 0,
        status: "INACTIVE",
      },
      withdrawals,
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
    const rawInvestments = await Investment.findAll({
      include: [
        {
          model: User,
          attributes: ["id", "name", "userID", "email", "phone", "sponsorId"],
          include: [
            {
              model: User,
              as: "sponsor",
              attributes: ["id", "name", "userID", "email", "phone"],
            },
            {
              model: Wallet,
              attributes: [
                "id",
                "balance",
                "spotBalance",
                "lockedBalance",
                "totalBalance",
                "totalSpent",
                "isUnlocked",
              ],
            },
          ],
        },
      ],
      order: [["totalInvested", "DESC"]],
    });

    const investments = rawInvestments.map((inv) => {
      const invObj = inv.toJSON();

      const walletObj = invObj.User?.Wallet || invObj.User?.wallet || null;

      const walletBalance = walletObj ? String(walletObj.balance ?? "0.00") : "0.00";
      const walletSpotBalance = walletObj ? String(walletObj.spotBalance ?? "0.00") : "0.00";
      const walletLockedBalance = walletObj ? String(walletObj.lockedBalance ?? "0.00") : "0.00";
      const walletTotalBalance = walletObj ? String(walletObj.totalBalance ?? "0.00") : "0.00";
      const walletTotalSpent = walletObj ? String(walletObj.totalSpent ?? "0.00") : "0.00";
      const walletIsUnlocked = walletObj ? Boolean(walletObj.isUnlocked) : false;

      const roiBalance = String(invObj.roiBalance ?? "0.00");
      const commissionBalance = String(invObj.commissionBalance ?? "0.00");
      const referralBalance = commissionBalance;
      const spotBalance = String(invObj.spotBalance ?? "0.00");

      const totalAvailableBalance = (
        Number(roiBalance) +
        Number(commissionBalance) +
        Number(spotBalance) +
        Number(walletBalance)
      ).toFixed(2);

      const totalAllBalances = (
        Number(roiBalance) +
        Number(commissionBalance) +
        Number(spotBalance) +
        Number(walletTotalBalance)
      ).toFixed(2);

      // Attach all wallet and balance params directly on invObj
      invObj.referralBalance = referralBalance;
      invObj.commissionBalance = commissionBalance;
      invObj.availableBalance = walletBalance;
      invObj.walletBalance = walletBalance;
      invObj.walletSpotBalance = walletSpotBalance;
      invObj.walletLockedBalance = walletLockedBalance;
      invObj.walletTotalBalance = walletTotalBalance;
      invObj.walletTotalSpent = walletTotalSpent;
      invObj.walletIsUnlocked = walletIsUnlocked;
      invObj.totalAvailableBalance = totalAvailableBalance;
      invObj.totalAllBalances = totalAllBalances;

      const formattedWallet = walletObj || {
        id: null,
        userId: invObj.userId,
        balance: "0.00",
        spotBalance: "0.00",
        lockedBalance: "0.00",
        totalBalance: "0.00",
        totalSpent: "0.00",
        isUnlocked: false,
      };

      invObj.wallet = formattedWallet;
      invObj.Wallet = formattedWallet;

      if (invObj.User) {
        const sponsor = invObj.User.sponsor || null;
        invObj.User.sponsorId = invObj.User.sponsorId || (sponsor ? sponsor.id : null);
        invObj.User.sponsorName = sponsor ? sponsor.name : null;
        invObj.User.sponsorUserID = sponsor ? sponsor.userID : null;

        invObj.User.walletBalance = walletBalance;
        invObj.User.availableBalance = walletBalance;
        invObj.User.referralBalance = referralBalance;
        invObj.User.commissionBalance = commissionBalance;
        invObj.User.roiBalance = roiBalance;
        invObj.User.spotBalance = spotBalance;
        invObj.User.walletSpotBalance = walletSpotBalance;
        invObj.User.walletLockedBalance = walletLockedBalance;
        invObj.User.walletTotalBalance = walletTotalBalance;
        invObj.User.wallet = formattedWallet;
        invObj.User.Wallet = formattedWallet;
      }

      return invObj;
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

/**
 * @route   POST /api/investment/admin/trigger-daily-payout
 * @desc    Manually trigger Daily ROI and Daily Level Commission payouts for today.
 * @access  Admin / Master / Staff
 */
router.post("/admin/trigger-daily-payout", auth, isAdmin, async (req, res) => {
  try {
    const result = await processDailyPayouts();
    return res.status(200).json({
      success: true,
      msg: `Daily ROI & Level Commissions processing completed for ${result.date}`,
      summary: result,
    });
  } catch (err) {
    console.error("Admin Trigger Daily Payout Error:", err);
    return res.status(500).json({ msg: "Failed to process daily payout", error: err.message });
  }
});

/**
 * @route   POST /api/investment/admin/cleanup-duplicate-payouts
 * @desc    Find and clean up duplicate Daily ROI and Level Commission transactions & adjust balances.
 * @access  Admin / Master / Staff
 */
router.post("/admin/cleanup-duplicate-payouts", auth, isAdmin, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    // Duplicates are grouped by the IST payout date stored in meta.date (not UTC createdAt),
    // keeping the oldest ID per group. Each duplicate row appears exactly once.
    const payoutDate = "JSON_UNQUOTE(JSON_EXTRACT(meta, '$.date'))";

    // 1. Find duplicate Daily ROI transactions (same user, same payout date)
    const [dupRoiRows] = await sequelize.query(
      `SELECT tx.id, tx.userId, tx.amount
       FROM InvestmentTransactions tx
       JOIN (
         SELECT userId, ${payoutDate} AS payDate, MIN(id) AS keepId
         FROM InvestmentTransactions
         WHERE type = 'DAILY_ROI' AND JSON_EXTRACT(meta, '$.date') IS NOT NULL
         GROUP BY userId, payDate
         HAVING COUNT(*) > 1
       ) g ON tx.userId = g.userId
         AND tx.type = 'DAILY_ROI'
         AND JSON_UNQUOTE(JSON_EXTRACT(tx.meta, '$.date')) = g.payDate
         AND tx.id <> g.keepId`,
      { transaction: t }
    );

    // 2. Find duplicate Level Commission transactions (same sponsor, investor, level, payout date)
    const [dupCommRows] = await sequelize.query(
      `SELECT tx.id, tx.userId, tx.amount
       FROM InvestmentTransactions tx
       JOIN (
         SELECT userId, fromUserId, level, ${payoutDate} AS payDate, MIN(id) AS keepId
         FROM InvestmentTransactions
         WHERE type = 'DAILY_LEVEL_COMMISSION' AND JSON_EXTRACT(meta, '$.date') IS NOT NULL
         GROUP BY userId, fromUserId, level, payDate
         HAVING COUNT(*) > 1
       ) g ON tx.userId = g.userId
         AND tx.fromUserId = g.fromUserId
         AND tx.level = g.level
         AND tx.type = 'DAILY_LEVEL_COMMISSION'
         AND JSON_UNQUOTE(JSON_EXTRACT(tx.meta, '$.date')) = g.payDate
         AND tx.id <> g.keepId`,
      { transaction: t }
    );

    const sumByUser = (rows) => {
      const map = new Map();
      for (const r of rows) map.set(r.userId, (map.get(r.userId) || 0) + Number(r.amount || 0));
      return map;
    };

    const dupRoiIds = dupRoiRows.map((r) => r.id);
    const dupCommIds = dupCommRows.map((r) => r.id);

    let totalRoiDeducted = 0;
    let totalCommDeducted = 0;

    // Deduct excess ROI balances & delete duplicate ROI transactions
    if (dupRoiIds.length > 0) {
      for (const [uId, excess] of sumByUser(dupRoiRows)) {
        await sequelize.query(
          `UPDATE Investments SET roiBalance = GREATEST(0, roiBalance - :excess) WHERE userId = :uId`,
          { replacements: { uId, excess: Number(excess.toFixed(2)) }, transaction: t }
        );
        totalRoiDeducted += excess;
      }

      await sequelize.query(
        `DELETE FROM InvestmentTransactions WHERE id IN (:ids)`,
        { replacements: { ids: dupRoiIds }, transaction: t }
      );
    }

    // Deduct excess Commission balances & delete duplicate Commission transactions
    if (dupCommIds.length > 0) {
      for (const [uId, excess] of sumByUser(dupCommRows)) {
        await sequelize.query(
          `UPDATE Investments SET commissionBalance = GREATEST(0, commissionBalance - :excess) WHERE userId = :uId`,
          { replacements: { uId, excess: Number(excess.toFixed(2)) }, transaction: t }
        );
        totalCommDeducted += excess;
      }

      await sequelize.query(
        `DELETE FROM InvestmentTransactions WHERE id IN (:ids)`,
        { replacements: { ids: dupCommIds }, transaction: t }
      );
    }

    await t.commit();

    return res.status(200).json({
      success: true,
      msg: `Duplicate payout cleanup completed successfully!`,
      summary: {
        deletedRoiTransactions: dupRoiIds.length,
        totalRoiDeducted: Number(totalRoiDeducted.toFixed(2)),
        deletedCommTransactions: dupCommIds.length,
        totalCommDeducted: Number(totalCommDeducted.toFixed(2)),
      },
    });
  } catch (err) {
    await t.rollback();
    console.error("Cleanup Duplicate Payouts Error:", err);
    return res.status(500).json({ msg: "Failed to cleanup duplicate payouts", error: err.message });
  }
});

module.exports = router;
