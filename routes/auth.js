

// ========================= routes/auth.js (FULL CODE) =========================// routes/auth.js (FULL CODE)  ✅ ROLE=ADMIN direct create ✅ JOIN+PAIR pending until 30k unlock ✅ PairPending + PairMatch
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { sequelize } from "../config/db.js";
import { Op } from "sequelize";

import User from "../models/User.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";

import Referral from "../models/Referral.js";
import ReferralLink from "../models/ReferralLink.js";
import BinaryNode from "../models/BinaryNode.js";

import PairPending from "../models/PairPending.js";
import PairMatch from "../models/PairMatch.js";
import { getSettingNumber } from "../config/settings.js";
import { uploadUserDocs, uploadProfilePic, getPublicPath } from "../config/upload.js";
import auth from "../middleware/auth.js";
import { createDefaultReferralLinks } from "./referrals.js";
import { checkAndGrantAwards } from "../config/awardRewards.js";
import Address from "../models/Address.js";
import Order from "../models/Order.js";
import OrderItem from "../models/OrderItem.js";
import Product from "../models/Product.js";
import optionalAuth from "../middleware/optionalAuth.js";

const router = express.Router();

console.log(
  "AUTH FILE: JOIN + PAIR BONUS (pending until 30k unlock) + PAIR-PENDING + PAIR-MATCH + ADMIN DIRECT CREATE"
);

// const MIN_SPEND_UNLOCK = 30000;


const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "1d" });

const generateReferralCode = () =>
  "R" + Math.random().toString(36).substring(2, 8).toUpperCase();

// ========================= WALLET CREDIT (returns txn) =========================
// ✅ JOIN + PAIR both pending rules
async function creditWallet({ userId, amount, reason, meta, t }) {
  const wallet = await Wallet.findOne({
    where: { userId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!wallet) throw new Error("Wallet not found");

  const minSpend = (await getSettingNumber("MIN_SPEND_UNLOCK", t)) || 30000;



  const isUnlocked = (w) =>
    !!w?.isUnlocked && Number(w?.totalSpent || 0) >= Number(minSpend);

  const receiverUnlocked = isUnlocked(wallet);

  let canCredit = true;
  let pendingReason = null;

  // ✅ RULE 1: JOIN BONUS -> sponsor + referred both unlocked
  if (reason === "REFERRAL_JOIN_BONUS") {
    const referredUserId = meta?.referredUserId;

    if (!referredUserId) {
      canCredit = false;
      pendingReason = "MISSING_REFERRED_USER_ID";
    } else {
      const referredWallet = await Wallet.findOne({
        where: { userId: referredUserId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });

      if (!receiverUnlocked) {
        canCredit = false;
        pendingReason = "SPONSOR_NOT_UNLOCKED";
      } else if (!isUnlocked(referredWallet)) {
        canCredit = false;
        pendingReason = "REFERRED_NOT_UNLOCKED";
      }
    }
  }

  // ✅ RULE 2: PAIR BONUS -> upline + left + right all unlocked
  if (reason === "PAIR_BONUS") {
    // If multiple pairs credited in one txn, validate all pairs.
    const pairs =
      Array.isArray(meta?.pairs) && meta.pairs.length
        ? meta.pairs
        : [{ leftUserId: meta?.leftUserId, rightUserId: meta?.rightUserId }];

    if (!receiverUnlocked) {
      canCredit = false;
      pendingReason = "UPLINE_NOT_UNLOCKED";
    } else {
      for (const p of pairs) {
        const leftUserId = p?.leftUserId;
        const rightUserId = p?.rightUserId;

        if (!leftUserId || !rightUserId) {
          canCredit = false;
          pendingReason = "MISSING_LEFT_RIGHT_IDS";
          break;
        }

        const [leftW, rightW] = await Promise.all([
          Wallet.findOne({
            where: { userId: leftUserId },
            transaction: t,
            lock: t.LOCK.UPDATE,
          }),
          Wallet.findOne({
            where: { userId: rightUserId },
            transaction: t,
            lock: t.LOCK.UPDATE,
          }),
        ]);

        if (!isUnlocked(leftW)) {
          canCredit = false;
          pendingReason = "LEFT_NOT_UNLOCKED";
          break;
        }
        if (!isUnlocked(rightW)) {
          canCredit = false;
          pendingReason = "RIGHT_NOT_UNLOCKED";
          break;
        }
      }
    }
  }

  // ✅ If not eligible -> create pending txn + add to lockedBalance
  if (!canCredit) {
    const txn = await WalletTransaction.create(
      {
        walletId: wallet.id,
        type: "CREDIT",
        amount,
        reason,
        meta: {
          ...(meta || {}),
          pending: true,
          pendingReason,
          minSpendRequired: minSpend,
          createdButNotCredited: true,
        },
      },
      { transaction: t }
    );

    wallet.lockedBalance = Number(wallet.lockedBalance || 0) + Number(amount || 0);
    wallet.totalBalance =
      Number(wallet.balance || 0) + Number(wallet.lockedBalance || 0);

    await wallet.save({ transaction: t });
    return txn;
  }

  // ✅ Eligible -> credit wallet balance
  wallet.balance = Number(wallet.balance || 0) + Number(amount || 0);
  wallet.totalBalance =
    Number(wallet.balance || 0) + Number(wallet.lockedBalance || 0);

  await wallet.save({ transaction: t });

  const txn = await WalletTransaction.create(
    {
      walletId: wallet.id,
      type: "CREDIT",
      amount,
      reason,
      meta: meta || null,
    },
    { transaction: t }
  );

  return txn;

}

// ========================= BINARY NODE HELPERS =========================
async function ensureNode(userId, t) {
  let node = await BinaryNode.findOne({
    where: { userId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!node) {
    node = await BinaryNode.create(
      {
        userId,
        parentId: null,
        position: null,
        leftChildId: null,
        rightChildId: null,
      },
      { transaction: t }
    );
  }
  return node;
}

// Spillover placement: go down LEFT/RIGHT path until empty slot
async function findPlacementParent({ sponsorUserId, position, t, lock = true }) {
  let current = await BinaryNode.findOne({
    where: { userId: sponsorUserId },
    transaction: t,
    ...(lock && t ? { lock: t.LOCK.UPDATE } : {}),
  });
  if (!current) throw new Error("Sponsor node not found");

  while (true) {
    if (position === "LEFT") {
      if (!current.leftChildId) return current;

      current = await BinaryNode.findOne({
        where: { userId: current.leftChildId },
        transaction: t,
        ...(lock && t ? { lock: t.LOCK.UPDATE } : {}),
      });
    } else {
      if (!current.rightChildId) return current;

      current = await BinaryNode.findOne({
        where: { userId: current.rightChildId },
        transaction: t,
        ...(lock && t ? { lock: t.LOCK.UPDATE } : {}),
      });
    }

    if (!current) throw new Error("Broken tree: missing node while placing");
  }
}

/**
 * ✅ GET /api/auth/placement-preview
 * Public API to show Sponsor name and Final Placement Parent during registration
 */
router.get("/placement-preview", async (req, res) => {
  try {
    const { sponsorId, position } = req.query;

    if (!sponsorId || !position) {
      return res.status(400).json({ msg: "sponsorId and position are required" });
    }

    const pos = String(position).toUpperCase();
    if (!["LEFT", "RIGHT"].includes(pos)) {
      return res.status(400).json({ msg: "Invalid position. Use LEFT or RIGHT" });
    }

    // 1. Find the Sponsor (The ID entered in the form)
    const sponsor = await User.findOne({
      where: { userID: sponsorId },
      attributes: ["id", "userID", "name"],
    });

    if (!sponsor) {
      return res.status(404).json({ msg: "Sponsor ID not found" });
    }

    // 2. Find the Final Placement Parent (Where the user will land)
    // We use a separate transaction-less call for preview to avoid locking
    const placedParentNode = await findPlacementParent({
      sponsorUserId: sponsor.id,
      position: pos,
      lock: false,
    });

    // 3. Get Placement Parent Details
    const placedParentUser = await User.findByPk(placedParentNode.userId, {
      attributes: ["userID", "name"],
    });

    return res.json({
      sponsorId: sponsor.userID,
      sponsorName: sponsor.name,
      placementParentId: placedParentUser?.userID || "N/A",
      placementParentName: placedParentUser?.name || "N/A",
      position: pos,
    });
  } catch (err) {
    console.error("Placement Preview Error:", err);
    return res.status(500).json({ msg: err.message });
  }
});

// ========================= PAIRING (PairPending + PairMatch) =========================
async function triggerMatchesForUpline({ uplineUserId, t }) {
  const uplineUser = await User.findByPk(uplineUserId, {
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!uplineUser) return;

  const PAIR_BONUS = (await getSettingNumber("PAIR_BONUS", t)) || 3000;

  // 1) find FIFO unused left & right (ONLY Entrepreneurs)
  const leftUnused = await PairPending.findAll({
    where: {
      uplineUserId: uplineUser.id,
      side: "LEFT",
      isUsed: false,
      isFlushed: false,
    },
    include: [{
      model: User,
      as: 'downline',
      where: { userType: 'ENTREPRENEUR' },
      attributes: ['id', 'userType']
    }],
    order: [["id", "ASC"]],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  const rightUnused = await PairPending.findAll({
    where: {
      uplineUserId: uplineUser.id,
      side: "RIGHT",
      isUsed: false,
      isFlushed: false,
    },
    include: [{
      model: User,
      as: 'downline',
      where: { userType: 'ENTREPRENEUR' },
      attributes: ['id', 'userType']
    }],
    order: [["id", "ASC"]],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  const canMake = Math.min(leftUnused.length, rightUnused.length);

  if (canMake > 0) {
    const DAILY_PAIR_CEILING = (await getSettingNumber("DAILY_PAIR_CEILING", t)) || 17;

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);

    const todayCount = await PairMatch.count({
      where: {
        uplineUserId: uplineUser.id,
        matchedAt: { [Op.gte]: start, [Op.lt]: end },
      },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    const remainingToday = Math.max(0, Number(DAILY_PAIR_CEILING) - Number(todayCount || 0));
    const allowed = Math.min(canMake, remainingToday);
    const flushCount = Math.max(0, canMake - allowed);

    const createdMatches = [];
    if (allowed > 0) {
      const pairs = [];
      for (let i = 0; i < allowed; i++) {
        pairs.push({ leftP: leftUnused[i], rightP: rightUnused[i] });
      }

      const leftIds = pairs.map((p) => p.leftP.downlineUserId);
      const rightIds = pairs.map((p) => p.rightP.downlineUserId);

      const [leftUsers, rightUsers] = await Promise.all([
        User.findAll({
          where: { id: leftIds },
          attributes: ["id", "name"],
          transaction: t,
        }),
        User.findAll({
          where: { id: rightIds },
          attributes: ["id", "name"],
          transaction: t,
        }),
      ]);

      const leftMap = new Map(leftUsers.map((u) => [u.id, u]));
      const rightMap = new Map(rightUsers.map((u) => [u.id, u]));

      for (const p of pairs) {
        const leftDownId = p.leftP.downlineUserId;
        const rightDownId = p.rightP.downlineUserId;

        const m = await PairMatch.create(
          {
            uplineUserId: uplineUser.id,
            leftUserId: leftDownId,
            rightUserId: rightDownId,
            bonusEach: PAIR_BONUS,
            amount: PAIR_BONUS,
            matchedAt: new Date(),
          },
          { transaction: t }
        );

        await p.leftP.update({ isUsed: true, usedInPairMatchId: m.id }, { transaction: t });
        await p.rightP.update({ isUsed: true, usedInPairMatchId: m.id }, { transaction: t });

        createdMatches.push({
          row: m,
          leftName: leftMap.get(m.leftUserId)?.name || null,
          rightName: rightMap.get(m.rightUserId)?.name || null,
        });
      }

      const txn = await creditWallet({
        userId: uplineUser.id,
        amount: allowed * PAIR_BONUS,
        reason: "PAIR_BONUS",
        meta: {
          each: PAIR_BONUS,
          newPairs: allowed,
          dailyCeiling: DAILY_PAIR_CEILING,
          todayAlreadyMatched: todayCount,
          flushedPairs: flushCount,
          pairs: createdMatches.map((x) => ({
            pairMatchId: x.row.id,
            leftUserId: x.row.leftUserId,
            leftUserName: x.leftName,
            rightUserId: x.row.rightUserId,
            rightUserName: x.rightName,
            matchedAt: x.row.matchedAt,
          })),
        },
        t,
      });

      for (const x of createdMatches) {
        await x.row.update({ walletTransactionId: txn.id }, { transaction: t });
      }

      uplineUser.paidPairs = Number(uplineUser.paidPairs || 0) + allowed;
    }

    if (flushCount > 0) {
      const now = new Date();
      // Use original unused arrays to determine the side lengths for tie-breaker
      const leftLen = leftUnused.length; 
      const rightLen = rightUnused.length;

      for (let i = allowed; i < canMake; i++) {
        const l = leftUnused[i];
        const r = rightUnused[i];

        // ✅ BUSINESS RULE: Flush out logic for Daily Ceiling
        // The smaller side (or the side that caused the extra potential pairs) is flushed out,
        // while the bigger side stays as Carry Forward.
        if (leftLen < rightLen) {
          // Left is smaller, flush it. Right remains Carry Forward.
          await l.update({ isUsed: true, usedInPairMatchId: null, isFlushed: true, flushedAt: now, flushReason: "DAILY_CEILING" }, { transaction: t });
        } else {
          // Right is smaller OR Equal: Flush Right only, Left stays Carry Forward.
          await r.update({ isUsed: true, usedInPairMatchId: null, isFlushed: true, flushedAt: now, flushReason: "DAILY_CEILING" }, { transaction: t });
        }
      }
    }
  }

  await uplineUser.save({ transaction: t });
  await checkAndGrantAwards({ userId: uplineUser.id, t });
}

async function updateUplineCountsAndBonuses({
  startParentUserId,
  placedPosition,
  newlyJoinedUserId,
  t,
}) {
  const newlyJoinedUser = await User.findByPk(newlyJoinedUserId, { transaction: t });
  const isEnt = newlyJoinedUser?.userType === "ENTREPRENEUR";

  const PAIR_BONUS = await getSettingNumber("PAIR_BONUS", t) || 3000;
  let node = await BinaryNode.findOne({
    where: { userId: startParentUserId },
    transaction: t,
  });

  let pos = placedPosition;

  while (node) {
    const uplineUser = await User.findByPk(node.userId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!uplineUser) break;

    // 1) increment counts
    if (pos === "LEFT") {
      uplineUser.leftCount = Number(uplineUser.leftCount || 0) + 1;
      if (isEnt) uplineUser.leftEntCount = Number(uplineUser.leftEntCount || 0) + 1;
    } else {
      uplineUser.rightCount = Number(uplineUser.rightCount || 0) + 1;
      if (isEnt) uplineUser.rightEntCount = Number(uplineUser.rightEntCount || 0) + 1;
    }

    // 2) store pending entry (exact downline id)
    await PairPending.create(
      {
        uplineUserId: uplineUser.id,
        side: pos,
        downlineUserId: newlyJoinedUserId,
        isUsed: false,
      },
      { transaction: t }
    );

    // 3) Process matches (only Entrepreneurs match now)
    await triggerMatchesForUpline({ uplineUserId: uplineUser.id, t });

    // move up
    const currentNode = await BinaryNode.findOne({
      where: { userId: uplineUser.id },
      transaction: t,
    });

    pos = currentNode?.position;
    if (!currentNode?.parentId) break;

    node = await BinaryNode.findOne({
      where: { userId: currentNode.parentId },
      transaction: t,
    });
  }
}

// Helper for tree traversal in auth.js
async function getAllBinaryDownlineIds(rootUserId) {
  let ids = [];
  let queue = [rootUserId];
  while (queue.length > 0) {
    const batch = queue.splice(0, 50);
    const nodes = await (await import("../models/BinaryNode.js")).default.findAll({
      where: { userId: { [Op.in]: batch } },
      attributes: ["userId", "leftChildId", "rightChildId"]
    });
    nodes.forEach(n => {
      ids.push(n.userId);
      if (n.leftChildId) queue.push(n.leftChildId);
      if (n.rightChildId) queue.push(n.rightChildId);
    });
  }
  return ids;
}

/**
 * ✅ NEW: Triggered when user UPGRADES to ENTREPRENEUR
 * Increments upline entrepreneur counts and unlocks pending PAIR_BONUS if possible.
 */
export async function updateUplineEntrepreneurCounts({ newlyUpgradedUserId, t }) {
  const bnode = await BinaryNode.findOne({ where: { userId: newlyUpgradedUserId }, transaction: t });
  if (!bnode || !bnode.parentId) return;

  let pos = bnode.position;
  let parentId = bnode.parentId;

  while (parentId) {
    const upline = await User.findByPk(parentId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!upline) break;

    // 1) Increment Ent Count
    if (pos === "LEFT") upline.leftEntCount = Number(upline.leftEntCount || 0) + 1;
    else upline.rightEntCount = Number(upline.rightEntCount || 0) + 1;
    await upline.save({ transaction: t });

    // 2) Trigger potential matches
    await triggerMatchesForUpline({ uplineUserId: upline.id, t });

    // 3) Check for unlocks (if they were already matched previously)
    const availablePairs = Math.min(upline.leftEntCount, upline.rightEntCount);
    const used = Number(upline.unlockedPairsCount || 0);

    if (availablePairs > used) {
      const moreToUnlock = availablePairs - used;
      const wallet = await Wallet.findOne({ where: { userId: upline.id }, transaction: t, lock: t.LOCK.UPDATE });

      if (wallet) {
        const pendingTxns = await WalletTransaction.findAll({
          where: {
            walletId: wallet.id,
            reason: "PAIR_BONUS",
            "meta.pending": true
          },
          order: [["id", "ASC"]],
          limit: moreToUnlock,
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        for (const txn of pendingTxns) {
          const amt = Number(txn.amount || 0);
          wallet.lockedBalance = Math.max(0, Number(wallet.lockedBalance || 0) - amt);
          wallet.balance = Number(wallet.balance || 0) + amt;
          wallet.totalBalance = Number(wallet.balance) + Number(wallet.lockedBalance);

          // ✅ Find the Nth entrepreneur on the OTHER side to show correct names in Wallet
          const uplineNode = await BinaryNode.findOne({ where: { userId: upline.id }, transaction: t });
          const otherSideRootId = (pos === "LEFT") ? uplineNode.rightChildId : uplineNode.leftChildId;

          let otherEntName = "Team Member";
          if (otherSideRootId) {
            const otherSideIds = await getAllBinaryDownlineIds(otherSideRootId); // existing helper from reports logic
            const otherEnt = await User.findOne({
              where: { id: { [Op.in]: otherSideIds }, userType: 'ENTREPRENEUR' },
              order: [['activationDate', 'ASC']],
              offset: used,
              transaction: t
            });
            if (otherEnt) otherEntName = otherEnt.name;
          }

          const newlyUpgradedUser = await User.findByPk(newlyUpgradedUserId, { transaction: t });
          const leftName = (pos === "LEFT") ? newlyUpgradedUser.name : otherEntName;
          const rightName = (pos === "RIGHT") ? newlyUpgradedUser.name : otherEntName;

          txn.meta = {
            ...txn.meta,
            pending: false,
            unlockedAt: new Date(),
            unlockedByUpgradeId: newlyUpgradedUserId,
            // Update names to reflect actual entrepreneurs
            pairs: [{
              ...(txn.meta?.pairs?.[0] || {}),
              leftUserName: leftName,
              rightUserName: rightName,
              isActualUnlockPair: true
            }]
          };
          await txn.save({ transaction: t });
          upline.unlockedPairsCount = (upline.unlockedPairsCount || 0) + 1;
        }
        await wallet.save({ transaction: t });
        await upline.save({ transaction: t });
      }
    }

    const currNode = await BinaryNode.findOne({ where: { userId: parentId }, transaction: t });
    if (!currNode || !currNode.parentId) break;
    pos = currNode.position;
    parentId = currNode.parentId;
  }
}


router.post("/register", (req, res) => {
  uploadUserDocs(req, res, async (err) => {
    console.log("REQ HEADERS =>", req.headers["content-type"]);
    console.log("REQ BODY =>", req.body);
    console.log("REQ FILE =>", req.file);

    const t = await sequelize.transaction();

    try {
      if (err) return res.status(400).json({ msg: err.message });

      const { name, email, phone, password } = req.body;
      const referralCode = req.body.referralCode;

      const userType = req.body.userType;
      const {
        bankAccountNumber, ifscCode, accountHolderName, panNumber, upiId,
        gender, dateOfBirth, bankName, bankBranch, bankAccountType, adharNumber, nomineeName, nomineeRelation, nomineePhone
      } = req.body;

      const profilePic = getPublicPath(req.files?.profilePic?.[0]);
      const bankPhoto = getPublicPath(req.files?.bankPhoto?.[0]);
      const panPhoto = getPublicPath(req.files?.panPhoto?.[0]);
      const aadharPhoto = getPublicPath(req.files?.aadharPhoto?.[0]);


      if (!name || !email || !phone || !password) {
        throw new Error("name,email,phone,password required");
      }

      // prevent duplicates
      // 7 accounts limit per email and phone
      const emailCount = await User.count({ where: { email }, transaction: t });
      if (emailCount >= 7) throw new Error("Email already reached its 7-account limit");

      const phoneCount = await User.count({ where: { phone }, transaction: t });
      if (phoneCount >= 7) throw new Error("Phone number already reached its 7-account limit");

      // unique referralCode
      let myCode = generateReferralCode();
      while (
        await User.findOne({ where: { referralCode: myCode }, transaction: t })
      ) {
        myCode = generateReferralCode();
      }

      // role
      const requestedRole = String(req.body.role || "USER").toUpperCase();
      const allowedRoles = ["USER", "ADMIN", "MASTER", "STAFF"];
      const roleToSave = allowedRoles.includes(requestedRole) ? requestedRole : "USER";

      // create user
      const user = await User.create(
        {
          name,
          email,
          phone,
          password,
          referralCode: myCode,
          role: roleToSave,
          ...(userType ? { userType } : {}),
          ...(profilePic ? { profilePic } : {}),
          ...(bankPhoto ? { bankPhoto } : {}),
          ...(panPhoto ? { panPhoto } : {}),
          ...(aadharPhoto ? { aadharPhoto } : {}),
          ...(bankAccountNumber ? { bankAccountNumber } : {}),
          ...(ifscCode ? { ifscCode } : {}),
          ...(accountHolderName ? { accountHolderName } : {}),
          ...(panNumber ? { panNumber } : {}),
          ...(upiId ? { upiId } : {}),
          ...(gender ? { gender } : {}),
          ...(dateOfBirth ? { dateOfBirth } : {}),
          ...(bankName ? { bankName } : {}),
          ...(bankBranch ? { bankBranch } : {}),
          ...(bankAccountType ? { bankAccountType } : {}),
          ...(adharNumber ? { adharNumber } : {}),
          ...(nomineeName ? { nomineeName } : {}),
          ...(nomineeRelation ? { nomineeRelation } : {}),
          ...(nomineePhone ? { nomineePhone } : {}),
        },
        { transaction: t }
      );

      // create wallet
      await Wallet.create(
        {
          userId: user.id,
          balance: 0,
          lockedBalance: 0,
          totalBalance: 0,
          totalSpent: 0,
          isUnlocked: false,
        },
        { transaction: t }
      );

      // create binary node
      await BinaryNode.create(
        {
          userId: user.id,
          userPkId: user.userID,
          userType: user.userType || userType || null,
          joiningDate: new Date(),
          parentId: null,
          position: null,
          leftChildId: null,
          rightChildId: null,
        },
        { transaction: t }
      );

      // ✅ AUTO GENERATE BOTH LINKS FOR EVERY USER
      await createDefaultReferralLinks(user.id, t);

      // ADMIN shortcut
      if (roleToSave === "ADMIN") {
        await t.commit();
        const token = signToken(user.id);
        return res.json({
          msg: "Registered",
          token,
          user: {
            id: user.id,

            name: user.name,
            role: user.role,
            email: user.email,

            phone: user.phone,
            referralCode: user.referralCode,
            bankAccountNumber: user.bankAccountNumber,
            ifscCode: user.ifscCode,
            accountHolderName: user.accountHolderName,
            panNumber: user.panNumber,
            upiId: user.upiId,
          },
        });
      }

      // ================= APPLY REFERRAL =================
      if (referralCode) {
        const link = await ReferralLink.findOne({
          where: { code: referralCode, isActive: true },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!link) throw new Error("Invalid referral code");

        const sponsor = await User.findByPk(link.sponsorId, {
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
        if (!sponsor) throw new Error("Sponsor not found");

        const pos = String(link.position || "").toUpperCase();
        if (!["LEFT", "RIGHT"].includes(pos))
          throw new Error("Invalid referral position");

        user.sponsorId = sponsor.id;
        await user.save({ transaction: t });

        await ensureNode(sponsor.id, t);

        const placedParent = await findPlacementParent({
          sponsorUserId: sponsor.id,
          position: pos,
          t,
        });

        const refRow = await Referral.create(
          {
            sponsorId: sponsor.id,
            referredUserId: user.id,
            position: pos,
            joinBonusPaid: false,
          },
          { transaction: t }
        );

        const myNode = await BinaryNode.findOne({
          where: { userId: user.id },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });

        myNode.parentId = placedParent.userId;
        myNode.position = pos;
        await myNode.save({ transaction: t });

        if (pos === "LEFT") placedParent.leftChildId = user.id;
        else placedParent.rightChildId = user.id;
        await placedParent.save({ transaction: t });

        if (!refRow.joinBonusPaid) {
          const JOIN_BONUS = (await getSettingNumber("JOIN_BONUS", t)) || 5000;
          const txn = await creditWallet({
            userId: sponsor.id,
            amount: JOIN_BONUS,
            reason: "REFERRAL_JOIN_BONUS",
            meta: {
              referredUserId: user.id,
              referredName: user.name,
              placedUnderUserId: placedParent.userId,
              placedPosition: pos,
            },
            t,
          });

          if (txn?.meta?.pending !== true) {
            refRow.joinBonusPaid = true;
            await refRow.save({ transaction: t });
          }
        }

        await updateUplineCountsAndBonuses({
          startParentUserId: placedParent.userId,
          placedPosition: pos,
          newlyJoinedUserId: user.id,
          t,
        });
      }

      await t.commit();

      const token = signToken(user.id);
      return res.json({
        msg: "Registered",
        token,
        user: {
          id: user.id,
          name: user.name,
          role: user.role,
          userID: user.userID,
          email: user.email,
          phone: user.phone,
          userType: user.userType,
          profilePic: user.profilePic,
          referralCode: user.referralCode,
          bankAccountNumber: user.bankAccountNumber,
          ifscCode: user.ifscCode,
          accountHolderName: user.accountHolderName,
          panNumber: user.panNumber,
          upiId: user.upiId,
          nomineeName: user.nomineeName,
          nomineeRelation: user.nomineeRelation,
          nomineePhone: user.nomineePhone,
        },
      });
    } catch (err) {
      await t.rollback();
      return res.status(400).json({ msg: err.message });
    }
  });
});


// ========================= PLACEMENT REGISTER =========================
// POST /api/auth/placement-register
// Body: { name, email, phone, password, parentId, position, userType, ... }
router.post("/placement-register", optionalAuth, (req, res) => {
  uploadUserDocs(req, res, async (err) => {
    const t = await sequelize.transaction();

    try {
      if (err) return res.status(400).json({ msg: err.message });

      const { name, email, phone, password, position, role } = req.body;
      const registeredByUserId = req.user?.id || null; // logged-in user id (null if guest)

      // Accept either 'parentId' or 'referralCode' as the placement parent identifier
      const parentId = req.body.parentId || req.body.referralCode;

      const userType = req.body.userType;
      const {
        bankAccountNumber, ifscCode, accountHolderName, panNumber, upiId,
        gender, dateOfBirth, bankName, bankBranch, bankAccountType, adharNumber, nomineeName, nomineeRelation, nomineePhone
      } = req.body;

      const profilePic = getPublicPath(req.files?.profilePic?.[0]);
      const bankPhoto = getPublicPath(req.files?.bankPhoto?.[0]);
      const panPhoto = getPublicPath(req.files?.panPhoto?.[0]);
      const aadharPhoto = getPublicPath(req.files?.aadharPhoto?.[0]);

      if (!name || !email || !phone || !password || !parentId || !position) {
        throw new Error("name, email, phone, password, parentId (or referralCode), and position are required");
      }

      if (!["LEFT", "RIGHT"].includes(position.toUpperCase())) {
        throw new Error("Invalid position. Must be LEFT or RIGHT");
      }

      const pos = position.toUpperCase();

      // 1. Find the actual placement parent using spillover logic (go down the selected position until empty)
      const parentUser = await User.findOne({
        where: { userID: parentId },
        transaction: t,
      });

      if (!parentUser) {
        throw new Error("Placement parent user not found");
      }

      // Use the existing findPlacementParent helper for spillover
      const placedParent = await findPlacementParent({
        sponsorUserId: parentUser.id,
        position: pos,
        t,
      });

      // 2. Prevent duplicates
      // 7 accounts limit per email and phone
      const emailCount = await User.count({ where: { email }, transaction: t });
      if (emailCount >= 7) throw new Error("Email already reached its 7-account limit");

      const phoneCount = await User.count({ where: { phone }, transaction: t });
      if (phoneCount >= 7) throw new Error("Phone number already reached its 7-account limit");

      // 3. Unique referralCode
      let myCode = generateReferralCode();
      while (
        await User.findOne({ where: { referralCode: myCode }, transaction: t })
      ) {
        myCode = generateReferralCode();
      }

      // 4. Create user
      const user = await User.create(
        {
          name,
          email,
          phone,
          password,
          referralCode: myCode,
          role: String(role || "USER").toUpperCase(),
          sponsorId: parentUser.id, // bonus receiver = entered parentId user
          ...(userType ? { userType } : {}),
          ...(profilePic ? { profilePic } : {}),
          ...(bankPhoto ? { bankPhoto } : {}),
          ...(panPhoto ? { panPhoto } : {}),
          ...(aadharPhoto ? { aadharPhoto } : {}),
          ...(bankAccountNumber ? { bankAccountNumber } : {}),
          ...(ifscCode ? { ifscCode } : {}),
          ...(accountHolderName ? { accountHolderName } : {}),
          ...(panNumber ? { panNumber } : {}),
          ...(upiId ? { upiId } : {}),
          ...(gender ? { gender } : {}),
          ...(dateOfBirth ? { dateOfBirth } : {}),
          ...(bankName ? { bankName } : {}),
          ...(bankBranch ? { bankBranch } : {}),
          ...(bankAccountType ? { bankAccountType } : {}),
          ...(adharNumber ? { adharNumber } : {}),
          ...(nomineeName ? { nomineeName } : {}),
          ...(nomineeRelation ? { nomineeRelation } : {}),
          ...(nomineePhone ? { nomineePhone } : {}),
        },
        { transaction: t }
      );

      // 5. Create wallet
      await Wallet.create(
        {
          userId: user.id,
          balance: 0,
          lockedBalance: 0,
          totalBalance: 0,
          totalSpent: 0,
          isUnlocked: false,
        },
        { transaction: t }
      );

      // 6. Create binary node and link to parent
      await BinaryNode.create(
        {
          userId: user.id,
          userPkId: user.userID,
          userType: user.userType || userType || null,
          joiningDate: new Date(),
          parentId: placedParent.userId,
          position: pos,
          leftChildId: null,
          rightChildId: null,
        },
        { transaction: t }
      );

      // Link parent to this new child
      if (pos === "LEFT") placedParent.leftChildId = user.id;
      else placedParent.rightChildId = user.id;
      await placedParent.save({ transaction: t });

      // 7. Create Referral record
      // sponsorId = entered parentId user (they get the bonus)
      const refRow = await Referral.create(
        {
          sponsorId: parentUser.id,
          referredUserId: user.id,
          position: pos,
          joinBonusPaid: false,
        },
        { transaction: t }
      );

      // 8. Auto-generate referral links
      await createDefaultReferralLinks(user.id, t);

      // 9. Credit JOIN BONUS to parentId user (the entered userId gets the bonus)
      const JOIN_BONUS = (await getSettingNumber("JOIN_BONUS", t)) || 5000;

      const txn = await creditWallet({
        userId: parentUser.id,
        amount: JOIN_BONUS,
        reason: "REFERRAL_JOIN_BONUS",
        meta: {
          referredUserId: user.id,
          referredName: user.name,
          placedUnderUserId: placedParent.userId,
          placedPosition: pos,
          registeredBy: registeredByUserId, // logged-in user who registered this member
        },
        t,
      });

      if (txn?.meta?.pending !== true) {
        refRow.joinBonusPaid = true;
        await refRow.save({ transaction: t });
      }

      // 10. Update upline counts and PAIR BONUS
      await updateUplineCountsAndBonuses({
        startParentUserId: placedParent.userId,
        placedPosition: pos,
        newlyJoinedUserId: user.id,
        t,
      });

      await t.commit();

      return res.json({
        msg: "User registered and placed successfully",
        user: {
          id: user.id,
          name: user.name,
          userID: user.userID,
          email: user.email,
          phone: user.phone,
          referralCode: user.referralCode,
        },
        placement: {
          parentId: parentUser.userID,       // enter చేసిన userId
          parentName: parentUser.name,       // parent user పేరు
          position: pos,                     // LEFT or RIGHT
          placedUnderUserID: placedParent.userPkId || parentUser.userID, // actual placed under (spillover తో)
        },
      });
    } catch (err) {
      await t.rollback();
      return res.status(400).json({ msg: err.message });
    }
  });
});


// ========================= LOGIN =========================
// router.post("/login", async (req, res) => {
//   try {
//     const { email, password } = req.body;
//     if (!email || !password)
//       return res.status(400).json({ msg: "email,password required" });

//     const user = await User.findOne({ where: { email } });
//     if (!user) return res.status(400).json({ msg: "Invalid credentials" });

//     const ok = await bcrypt.compare(password, user.password);
//     if (!ok) return res.status(400).json({ msg: "Invalid credentials" });

//     const token = signToken(user.id);
//     return res.json({
//       msg: "Logged in",
//       token,
//       user: {
//         id: user.id,
//         name: user.name,
//         role: user.role,
//         email: user.email,
//         phone: user.phone,
//         referralCode: user.referralCode,
//       },
//     });
//   } catch (err) {
//     return res.status(500).json({ msg: err.message });
//   }
// });


// ✅ LOGIN WITH userID OR email
// Body: { login: "BW000123" OR "test@gmail.com", password: "123456" }


router.post("/login", async (req, res) => {
  try {
    const { userID, password } = req.body;

    if (!userID || !password) {
      return res.status(400).json({ msg: "userID and password required" });
    }

    const input = String(userID).trim();

    const user = await User.findOne({
      where: {
        [Op.or]: [{ userID: input }, { email: input }],
      },
    });

    if (!user) {
      return res.status(400).json({ msg: "Invalid userID or password" });
    }

    if (String(password) !== String(user.password)) {
      return res.status(400).json({ msg: "Invalid userID or password" });
    }

    if (user.status === "INACTIVE") {
      return res.status(403).json({ msg: "Your account is inactive. Please contact admin." });
    }

    const token = signToken(user.id);

    return res.json({
      msg: "Logged in",
      token,
      user: {
        id: user.id,
        userID: user.userID,
        name: user.name,
        role: user.role,
        email: user.email,
        phone: user.phone,
        userType: user.userType,
        status: user.status,
        profilePic: user.profilePic,
        referralCode: user.referralCode,
      },
    });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});

// ✅ GET /api/auth/welcome-letter
// Returns data for the welcome letter of the logged-in user
router.get("/welcome-letter", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Fetch User details (including sponsor)
    const user = await User.findByPk(userId, {
      attributes: ["id", "userID", "name", "createdAt", "sponsorId"],
      include: [
        {
          model: User,
          as: "sponsor",
          attributes: ["userID", "name", "phone"],
        },
      ],
    });

    if (!user) return res.status(404).json({ msg: "User not found" });

    // 2. Fetch Any Active Address (prefer default)
    let address = await Address.findOne({
      where: { userId, isDefault: true, isActive: true },
      attributes: ["house", "area", "pincode"],
    });

    if (!address) {
      address = await Address.findOne({
        where: { userId, isActive: true },
        attributes: ["house", "area", "pincode"],
        order: [["createdAt", "DESC"]],
      });
    }

    // 3. Fetch Binary Position
    const binaryNode = await BinaryNode.findOne({
      where: { userId },
      attributes: ["position"],
    });

    // 4. Fetch Latest Paid Product
    // Look for the latest PAID order to find the product selected
    const latestOrder = await Order.findOne({
      where: { userId, paymentStatus: "SUCCESS" },
      order: [["createdAt", "DESC"]],
      include: [
        {
          model: OrderItem,
          include: [{ model: Product, attributes: ["name"] }],
        },
      ],
    });

    let productName = "N/A";
    if (latestOrder && latestOrder.OrderItems && latestOrder.OrderItems.length > 0) {
      productName = latestOrder.OrderItems[0].Product?.name || "N/A";
    }

    // 5. Format response
    const formatDate = (date) => {
      if (!date) return "N/A";
      const d = new Date(date);
      const day = String(d.getDate()).padStart(2, "0");
      const months = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
      ];
      const month = months[d.getMonth()];
      const year = d.getFullYear();
      let hours = d.getHours();
      const minutes = String(d.getMinutes()).padStart(2, "0");
      const seconds = String(d.getSeconds()).padStart(2, "0");
      const ampm = hours >= 12 ? "PM" : "AM";
      hours = hours % 12;
      hours = hours ? hours : 12; // the hour '0' should be '12'
      return `${day}-${month}-${year} ${hours}:${minutes}:${seconds} ${ampm}`;
    };

    let introducer = "N/A";
    let introducerName = "N/A";
    let introducerPhone = "N/A";

    if (user.sponsor) {
      introducer = user.sponsor.userID;
      introducerName = user.sponsor.name;
      introducerPhone = user.sponsor.phone;
    } else {
      // Fallback: check Referral table
      const refRecord = await Referral.findOne({
        where: { referredUserId: userId },
        include: [{ model: User, as: "sponsor", attributes: ["userID", "name", "phone"] }],
      });
      if (refRecord && refRecord.sponsor) {
        introducer = refRecord.sponsor.userID;
        introducerName = refRecord.sponsor.name;
        introducerPhone = refRecord.sponsor.phone;
      }
    }

    const welcomeData = {
      userName: user.userID,
      dateOfJoining: formatDate(user.createdAt),
      name: user.name,
      address: address ? `${address.house}, ${address.area}` : "N/A",
      city: "N/A",
      district: "N/A",
      state: "N/A",
      country: "India",
      pinCode: address ? address.pincode : "N/A",
      introducer,
      introducerName,
      introducerPhone,
      placedIn: binaryNode ? (binaryNode.position === "LEFT" ? "L" : "R") : "N/A",
      productSelected: productName,
    };

    return res.json(welcomeData);
  } catch (err) {
    console.error("GET /welcome-letter error:", err);
    return res.status(500).json({ msg: "Server error" });
  }
});




export default router;