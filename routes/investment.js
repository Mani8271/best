const express = require("express");
const { sequelize } = require("../config/db.js");
const { Op } = require("sequelize");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const auth = require("../middleware/auth.js");
const isAdmin = require("../middleware/isAdmin.js");

const User = require("../models/User.js");
const Wallet = require("../models/Wallet.js");
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
 * @route   POST /api/investment/admin/settings
 * @desc    Update dynamic investment settings (Min withdrawal, ROI %, Level 1-4 Commission %, Payout Transfer Days).
 * @access  Admin / Master / Staff
 */
router.post("/admin/settings", auth, isAdmin, async (req, res) => {
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

    const targetMinWithdrawal = minWithdrawalAmount !== undefined ? minWithdrawalAmount : value;

    if (targetMinWithdrawal !== undefined) {
      await updateAppSetting("INVESTMENT_MIN_WITHDRAWAL", targetMinWithdrawal);
    }
    if (roiPercent !== undefined) {
      await updateAppSetting("INVESTMENT_ROI_PERCENT", roiPercent);
    }
    if (level1Percent !== undefined) {
      await updateAppSetting("INVESTMENT_LEVEL_1_PERCENT", level1Percent);
    }
    if (level2Percent !== undefined) {
      await updateAppSetting("INVESTMENT_LEVEL_2_PERCENT", level2Percent);
    }
    if (level3Percent !== undefined) {
      await updateAppSetting("INVESTMENT_LEVEL_3_PERCENT", level3Percent);
    }
    if (level4Percent !== undefined) {
      await updateAppSetting("INVESTMENT_LEVEL_4_PERCENT", level4Percent);
    }

    const day1Val = payoutTransferDay1 !== undefined ? payoutTransferDay1 : payoutDay1;
    const day2Val = payoutTransferDay2 !== undefined ? payoutTransferDay2 : payoutDay2;

    if (day1Val !== undefined && Number(day1Val) >= 1 && Number(day1Val) <= 31) {
      await updateAppSetting("PAYOUT_TRANSFER_DAY_1", day1Val);
    }
    if (day2Val !== undefined && Number(day2Val) >= 1 && Number(day2Val) <= 31) {
      await updateAppSetting("PAYOUT_TRANSFER_DAY_2", day2Val);
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
});

/**
 * @route   PUT /api/investment/admin/settings
 * @desc    PUT alias for updating dynamic investment settings.
 * @access  Admin / Master / Staff
 */
router.put("/admin/settings", auth, isAdmin, async (req, res) => {
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

    const targetMinWithdrawal = minWithdrawalAmount !== undefined ? minWithdrawalAmount : value;

    if (targetMinWithdrawal !== undefined) {
      await updateAppSetting("INVESTMENT_MIN_WITHDRAWAL", targetMinWithdrawal);
    }
    if (roiPercent !== undefined) {
      await updateAppSetting("INVESTMENT_ROI_PERCENT", roiPercent);
    }
    if (level1Percent !== undefined) {
      await updateAppSetting("INVESTMENT_LEVEL_1_PERCENT", level1Percent);
    }
    if (level2Percent !== undefined) {
      await updateAppSetting("INVESTMENT_LEVEL_2_PERCENT", level2Percent);
    }
    if (level3Percent !== undefined) {
      await updateAppSetting("INVESTMENT_LEVEL_3_PERCENT", level3Percent);
    }
    if (level4Percent !== undefined) {
      await updateAppSetting("INVESTMENT_LEVEL_4_PERCENT", level4Percent);
    }

    const day1Val = payoutTransferDay1 !== undefined ? payoutTransferDay1 : payoutDay1;
    const day2Val = payoutTransferDay2 !== undefined ? payoutTransferDay2 : payoutDay2;

    if (day1Val !== undefined && Number(day1Val) >= 1 && Number(day1Val) <= 28) {
      await updateAppSetting("PAYOUT_TRANSFER_DAY_1", day1Val);
    }
    if (day2Val !== undefined && Number(day2Val) >= 1 && Number(day2Val) <= 28) {
      await updateAppSetting("PAYOUT_TRANSFER_DAY_2", day2Val);
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
});

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
          sponsorInvestment.commissionBalance = Number(sponsorInvestment.commissionBalance || 0) + commAmount;
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

    const minWithdrawalAmount = await getSettingNumber("INVESTMENT_MIN_WITHDRAWAL", 2500);

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

    const withdrawalWindow = await checkWithdrawalWindow();

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

    const currentRoi = Number(investment.roiBalance || 0);
    const currentComm = Number(investment.commissionBalance || 0);
    const totalAvailable = currentRoi + currentComm;

    if (numAmount > totalAvailable) {
      await t.rollback();
      return res.status(400).json({
        msg: `Insufficient available balance. Available: ₹${totalAvailable.toLocaleString("en-IN")}, Requested: ₹${numAmount.toLocaleString("en-IN")}`,
      });
    }

    // 2. Deduct amount from balances (prioritize ROI balance then commission balance)
    let remainingToDeduct = numAmount;
    if (currentRoi >= remainingToDeduct) {
      investment.roiBalance = currentRoi - remainingToDeduct;
      remainingToDeduct = 0;
    } else {
      investment.roiBalance = 0;
      remainingToDeduct -= currentRoi;
      investment.commissionBalance = currentComm - remainingToDeduct;
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
    const { status } = req.query;

    let whereClause = {};
    if (status && ["PENDING", "APPROVED", "REJECTED"].includes(status.toUpperCase())) {
      whereClause.status = status.toUpperCase();
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
          ],
        },
      ],
      order: [["totalInvested", "DESC"]],
    });

    const investments = rawInvestments.map((inv) => {
      const invObj = inv.toJSON();
      if (invObj.User) {
        const sponsor = invObj.User.sponsor || null;
        invObj.User.sponsorId = invObj.User.sponsorId || (sponsor ? sponsor.id : null);
        invObj.User.sponsorName = sponsor ? sponsor.name : null;
        invObj.User.sponsorUserID = sponsor ? sponsor.userID : null;
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
    // 1. Find duplicate Daily ROI transactions (keep oldest ID)
    const [dupRoiRows] = await sequelize.query(
      `SELECT t1.id, t1.userId, t1.amount
       FROM InvestmentTransactions t1
       JOIN InvestmentTransactions t2 
         ON t1.userId = t2.userId 
         AND DATE(t1.createdAt) = DATE(t2.createdAt)
         AND t1.description LIKE 'Daily ROI payout%'
         AND t2.description LIKE 'Daily ROI payout%'
         AND t1.id > t2.id`,
      { transaction: t }
    );

    // 2. Find duplicate Level Commission transactions (keep oldest ID)
    const [dupCommRows] = await sequelize.query(
      `SELECT t1.id, t1.userId, t1.amount
       FROM InvestmentTransactions t1
       JOIN InvestmentTransactions t2 
         ON t1.userId = t2.userId 
         AND t1.fromUserId = t2.fromUserId
         AND t1.level = t2.level
         AND DATE(t1.createdAt) = DATE(t2.createdAt)
         AND t1.description LIKE 'Level % Daily Commission%'
         AND t2.description LIKE 'Level % Daily Commission%'
         AND t1.id > t2.id`,
      { transaction: t }
    );

    const dupRoiIds = dupRoiRows.map((r) => r.id);
    const dupCommIds = dupCommRows.map((r) => r.id);

    let totalRoiDeducted = 0;
    let totalCommDeducted = 0;

    // Deduct excess ROI balances
    if (dupRoiIds.length > 0) {
      await sequelize.query(
        `UPDATE Investments i
         JOIN (
           SELECT t1.userId, SUM(t1.amount) AS excess_roi
           FROM InvestmentTransactions t1
           JOIN InvestmentTransactions t2 
             ON t1.userId = t2.userId 
             AND DATE(t1.createdAt) = DATE(t2.createdAt)
             AND t1.description LIKE 'Daily ROI payout%'
             AND t2.description LIKE 'Daily ROI payout%'
             AND t1.id > t2.id
           GROUP BY t1.userId
         ) dup ON i.userId = dup.userId
         SET i.roiBalance = GREATEST(0, i.roiBalance - dup.excess_roi)`,
        { transaction: t }
      );
      totalRoiDeducted = dupRoiRows.reduce((sum, r) => sum + Number(r.amount || 0), 0);

      // Delete duplicate ROI transactions
      await sequelize.query(
        `DELETE FROM InvestmentTransactions WHERE id IN (:ids)`,
        { replacements: { ids: dupRoiIds }, transaction: t }
      );
    }

    // Deduct excess Commission balances
    if (dupCommIds.length > 0) {
      await sequelize.query(
        `UPDATE Investments i
         JOIN (
           SELECT t1.userId, SUM(t1.amount) AS excess_comm
           FROM InvestmentTransactions t1
           JOIN InvestmentTransactions t2 
             ON t1.userId = t2.userId 
             AND t1.fromUserId = t2.fromUserId
             AND t1.level = t2.level
             AND DATE(t1.createdAt) = DATE(t2.createdAt)
             AND t1.description LIKE 'Level % Daily Commission%'
             AND t2.description LIKE 'Level % Daily Commission%'
             AND t1.id > t2.id
           GROUP BY t1.userId
         ) dup ON i.userId = dup.userId
         SET i.commissionBalance = GREATEST(0, i.commissionBalance - dup.excess_comm)`,
        { transaction: t }
      );
      totalCommDeducted = dupCommRows.reduce((sum, r) => sum + Number(r.amount || 0), 0);

      // Delete duplicate Commission transactions
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

/**
 * @route   POST /api/investment/admin/trigger-payout-transfer
 * @desc    Manually trigger bi-monthly payout transfer (transfers ROI & Level Commission to main Available Wallet balance).
 * @access  Admin / Master / Staff
 */
router.post("/admin/trigger-payout-transfer", auth, isAdmin, async (req, res) => {
  try {
    const result = await processPayoutTransfers();
    return res.status(200).json({
      success: true,
      msg: `Bi-Monthly Payout Transfer completed successfully for ${result.date}`,
      summary: result,
    });
  } catch (err) {
    console.error("Admin Trigger Payout Transfer Error:", err);
    return res.status(500).json({ msg: "Failed to process payout transfer", error: err.message });
  }
});

module.exports = router;
