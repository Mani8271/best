const express = require("express");
const { sequelize } = require("../config/db.js");
const { Op } = require("sequelize");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const auth = require("../middleware/auth.js");
const isAdmin = require("../middleware/isAdmin.js");

const User = require("../models/User.js");
const Investment = require("../models/Investment.js");
const InvestmentTransaction = require("../models/InvestmentTransaction.js");
const InvestmentWithdrawal = require("../models/InvestmentWithdrawal.js");
const InvestmentBankDetail = require("../models/InvestmentBankDetail.js");
const AppSetting = require("../models/AppSetting.js");
const { getSettingNumber, getSettingString, updateAppSettingString } = require("../config/settings.js");
const { processDailyPayouts } = require("../utils/dailyPayoutEngine.js");

const router = express.Router();

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET || "default_secret_key", { expiresIn: "7d" });

/**
 * Generate unique SI-prefixed User ID / Referral Code (e.g., SI566665)
 */
const generateInvestmentUserID = async (t) => {
  let isUnique = false;
  let newID = "";
  while (!isUnique) {
    const num = Math.floor(100000 + Math.random() * 900000); // 6 digits
    newID = `SI${num}`; // e.g. SI566665
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

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Always create a FRESH User record specifically for Investment
    const user = await User.create(
      {
        name: String(name).trim(),
        email: cleanEmail,
        phone: cleanPhone,
        password: hashedPassword,
        userID: newSI_ID,
        referralCode: newSI_ID, // SI ID also serves as referral code (e.g. SI566665)
        sponsorId: sponsorId || null,
        role: "USER",
        userType: "INVESTMENT_USER",
        status: "ACTIVE",
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

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ msg: "Invalid credentials. Incorrect password." });
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

    // Fetch Bank details saved status
    const bankDetails = await InvestmentBankDetail.findOne({ where: { userId: user.id } });

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
        roiBalance: Number(investment.roiBalance || 0),
        commissionBalance: Number(investment.commissionBalance || 0),
        totalWithdrawn: Number(investment.totalWithdrawn || 0),
        availableBalance: Number(investment.roiBalance || 0) + Number(investment.commissionBalance || 0),
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
  const investmentInclude = [
    {
      model: Investment,
      required: false, // Include all downline users even if investment wallet is not yet initialized
      attributes: ["totalInvested", "activeInvestment", "status"],
    },
  ];

  // Level 1
  const level1Users = await User.findAll({
    where: { sponsorId: rootUserId },
    attributes: ["id", "name", "userID", "email", "phone", "createdAt", "sponsorId"],
    include: investmentInclude,
  });

  const level1Ids = level1Users.map((u) => u.id);

  // Level 2
  let level2Users = [];
  if (level1Ids.length > 0) {
    level2Users = await User.findAll({
      where: { sponsorId: { [Op.in]: level1Ids } },
      attributes: ["id", "name", "userID", "email", "phone", "createdAt", "sponsorId"],
      include: investmentInclude,
    });
  }
  const level2Ids = level2Users.map((u) => u.id);

  // Level 3
  let level3Users = [];
  if (level2Ids.length > 0) {
    level3Users = await User.findAll({
      where: { sponsorId: { [Op.in]: level2Ids } },
      attributes: ["id", "name", "userID", "email", "phone", "createdAt", "sponsorId"],
      include: investmentInclude,
    });
  }
  const level3Ids = level3Users.map((u) => u.id);

  // Level 4
  let level4Users = [];
  if (level3Ids.length > 0) {
    level4Users = await User.findAll({
      where: { sponsorId: { [Op.in]: level3Ids } },
      attributes: ["id", "name", "userID", "email", "phone", "createdAt", "sponsorId"],
      include: investmentInclude,
    });
  }


  const allDownlineUsers = [...level1Users, ...level2Users, ...level3Users, ...level4Users];
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
      totalActiveInvestment,
      totalInvested,
      levelCounts: {
        level1: level1Users.length,
        level2: level2Users.length,
        level3: level3Users.length,
        level4: level4Users.length,
      },
    },
    tree: {
      level1: level1Users,
      level2: level2Users,
      level3: level3Users,
      level4: level4Users,
    },
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
    const roiPercent = await getSettingNumber("INVESTMENT_ROI_PERCENT", 5);
    const level1Percent = await getSettingNumber("INVESTMENT_LEVEL_1_PERCENT", 2);
    const level2Percent = await getSettingNumber("INVESTMENT_LEVEL_2_PERCENT", 1);
    const level3Percent = await getSettingNumber("INVESTMENT_LEVEL_3_PERCENT", 0.5);
    const level4Percent = await getSettingNumber("INVESTMENT_LEVEL_4_PERCENT", 0.25);

    return res.status(200).json({
      success: true,
      settings: {
        INVESTMENT_MIN_WITHDRAWAL: minWithdrawalAmount,
        minWithdrawalAmount,
        INVESTMENT_ROI_PERCENT: roiPercent,
        roiPercent,
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
 * @desc    Update dynamic investment settings (Min withdrawal, ROI %, Level 1-4 Commission %).
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

    const currentMinWithdrawal = await getSettingNumber("INVESTMENT_MIN_WITHDRAWAL", 2500);
    const currentRoi = await getSettingNumber("INVESTMENT_ROI_PERCENT", 5);
    const currentL1 = await getSettingNumber("INVESTMENT_LEVEL_1_PERCENT", 5);
    const currentL2 = await getSettingNumber("INVESTMENT_LEVEL_2_PERCENT", 1);
    const currentL3 = await getSettingNumber("INVESTMENT_LEVEL_3_PERCENT", 0.5);
    const currentL4 = await getSettingNumber("INVESTMENT_LEVEL_4_PERCENT", 0.25);

    return res.status(200).json({
      success: true,
      msg: "Dynamic investment settings updated successfully",
      settings: {
        minWithdrawalAmount: currentMinWithdrawal,
        roiPercent: currentRoi,
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

    const currentMinWithdrawal = await getSettingNumber("INVESTMENT_MIN_WITHDRAWAL", 2500);
    const currentRoi = await getSettingNumber("INVESTMENT_ROI_PERCENT", 5);
    const currentL1 = await getSettingNumber("INVESTMENT_LEVEL_1_PERCENT", 5);
    const currentL2 = await getSettingNumber("INVESTMENT_LEVEL_2_PERCENT", 1);
    const currentL3 = await getSettingNumber("INVESTMENT_LEVEL_3_PERCENT", 0.5);
    const currentL4 = await getSettingNumber("INVESTMENT_LEVEL_4_PERCENT", 0.25);

    return res.status(200).json({
      success: true,
      msg: "Dynamic investment settings updated successfully",
      settings: {
        minWithdrawalAmount: currentMinWithdrawal,
        roiPercent: currentRoi,
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

    // 3. Direct Sponsor 5% Commission Distribution (Level 1 Only)
    const commissionsDistributed = [];

    if (targetUser.sponsorId) {
      const level1Pct = await getSettingNumber("INVESTMENT_LEVEL_1_PERCENT", 5);
      const rate = level1Pct / 100;

      if (rate > 0) {
        const sponsor = await User.findByPk(targetUser.sponsorId, {
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        if (sponsor) {
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
              level: 1,
              fromUserId: targetUser.id,
              createdAdminId: req.user.id,
              description: `Direct Referral Commission (${rate * 100}%) from ${targetUser.name} (${targetUser.userID}) investment of ₹${numAmount.toLocaleString("en-IN")}`,
              meta: {
                level: 1,
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

    return res.status(200).json({
      success: true,
      referralInfo: {
        userID: user.userID,
        referralCode: user.referralCode,
        sponsor: user.sponsor || null,
        referralLink: `http://localhost:3000/register?ref=${user.referralCode}`,
      },
    });
  } catch (err) {
    console.error("Get Referral Info Error:", err);
    return res.status(500).json({ msg: "Failed to fetch referral info", error: err.message });
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

    // 0. Check withdrawal window dates
    const windowCheck = await checkWithdrawalWindow();
    if (!windowCheck.isAllowedNow) {
      await t.rollback();
      return res.status(400).json({
        msg: windowCheck.message,
        withdrawalWindow: windowCheck,
      });
    }

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

module.exports = router;
