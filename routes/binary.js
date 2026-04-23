import express from "express";
import auth from "../middleware/auth.js";
import isAdmin from "../middleware/isAdmin.js";
import { Op } from "sequelize";

import User from "../models/User.js";
import BinaryNode from "../models/BinaryNode.js";
import PairPending from "../models/PairPending.js";
import PairMatch from "../models/PairMatch.js";

const router = express.Router();

/* ========================= HELPERS ========================= */

// ✅ Ensures BinaryNode exists AND keeps snapshot fields in sync (userPkId + userType)
async function ensureNode(userId, t = null) {
  if (!userId) return null;

  const opts = t ? { transaction: t } : {};

  // latest user snapshot
  const u = await User.findByPk(userId, {
    attributes: ["id", "userID", "userType", "createdAt"],
    ...opts,
  });

  const latestUserPkId = u?.userID || String(userId);
  const latestUserType = u?.userType || null;
  const latestJoining = u?.createdAt || new Date();

  let node = await BinaryNode.findOne({ where: { userId }, ...opts });

  if (!node) {
    node = await BinaryNode.create(
      {
        userId,
        userPkId: latestUserPkId,
        userType: latestUserType,
        joiningDate: latestJoining,

        parentId: null,
        position: null,
        leftChildId: null,
        rightChildId: null,
      },
      opts
    );
    return node;
  }

  const needUpdate =
    String(node.userPkId || "") !== String(latestUserPkId) ||
    String(node.userType || "") !== String(latestUserType || "");

  if (needUpdate) {
    await node.update(
      {
        userPkId: latestUserPkId,
        userType: latestUserType,
      },
      opts
    );
  }

  return node;
}

// ✅ Optimized buildTree with DEPTH LIMIT and BATCH QUERIES
async function buildTreeOptimized(rootUserId, maxDepth = 4) {
  const depthLimit = Math.min(Math.max(1, maxDepth), 100); // Supports up to 100 levels now!

  const allNodesMap = new Map(); // userId -> BinaryNode
  const allUsersMap = new Map(); // userId -> User

  let currentLevelIds = [rootUserId];

  for (let d = 0; d <= depthLimit; d++) {
    if (currentLevelIds.length === 0) break;

    // Batch fetch BinaryNodes
    const nodes = await BinaryNode.findAll({
      where: { userId: { [Op.in]: currentLevelIds } }
    });

    // Batch fetch Users
    const users = await User.findAll({
      where: { id: { [Op.in]: currentLevelIds } },
      attributes: ["id", "userID", "name", "referralCode", "userType", "createdAt", "sponsorId"]
    });

    const sponsorIds = users.map(u => u.sponsorId).filter(id => id);
    const sponsors = sponsorIds.length > 0
      ? await User.findAll({ where: { id: { [Op.in]: sponsorIds } }, attributes: ["id", "userID", "name"] })
      : [];

    const sponsorMap = new Map();
    sponsors.forEach(s => sponsorMap.set(s.id, s));

    nodes.forEach(n => allNodesMap.set(n.userId, n));
    users.forEach(u => {
      if (u.sponsorId && sponsorMap.has(u.sponsorId)) {
        u.sponsorDetails = sponsorMap.get(u.sponsorId);
      }
      allUsersMap.set(u.id, u);
    });

    // Prepare next level
    const nextLevelIds = [];
    nodes.forEach(n => {
      if (n.leftChildId) nextLevelIds.push(n.leftChildId);
      if (n.rightChildId) nextLevelIds.push(n.rightChildId);
    });
    currentLevelIds = nextLevelIds;
  }

  const toJson = (userId, currentDepth) => {
    const node = allNodesMap.get(userId);
    const user = allUsersMap.get(userId);

    if (!node || !user) return null;

    const out = {
      id: user.id,
      userID: user.userID,
      userPkId: node.userPkId || user.userID,
      name: user.name || "—",
      referralCode: user.referralCode,
      userType: user.userType,
      joiningDate: node.joiningDate || user.createdAt,
      sponsorPkId: user.sponsorDetails?.userID || null,
      sponsorName: user.sponsorDetails?.name || null,
      leftId: node.leftChildId,
      rightId: node.rightChildId,
      left: null,
      right: null
    };

    if (currentDepth < depthLimit) {
      if (node.leftChildId) out.left = toJson(node.leftChildId, currentDepth + 1);
      if (node.rightChildId) out.right = toJson(node.rightChildId, currentDepth + 1);
    }

    return out;
  };

  return toJson(rootUserId, 0);
}

// ✅ Optimized subtree collector (limit loops, better batching)
async function collectSubtreeStats(rootNodeId) {
  const stats = {
    TOTAL: 0,
    ENTREPRENEUR: 0,
    TRAINEE_ENTREPRENEUR: 0,
    OTHER: 0,
  };

  if (!rootNodeId) return stats;

  let queue = [rootNodeId];
  const processed = new Set();

  while (queue.length > 0) {
    // Process in batches of 50 to keep memory low but reduce queries
    const batch = queue.splice(0, 50);

    const nodes = await BinaryNode.findAll({
      where: { userId: { [Op.in]: batch } },
      attributes: ["userId", "leftChildId", "rightChildId"]
    });

    const users = await User.findAll({
      where: { id: { [Op.in]: batch } },
      attributes: ["userType"]
    });

    users.forEach(u => {
      stats.TOTAL++;
      const t = String(u.userType || "").toUpperCase();
      if (t === "ENTREPRENEUR") stats.ENTREPRENEUR++;
      else if (t === "TRAINEE_ENTREPRENEUR") stats.TRAINEE_ENTREPRENEUR++;
      else stats.OTHER++;
    });

    nodes.forEach(n => {
      if (n.leftChildId && !processed.has(n.leftChildId)) {
        queue.push(n.leftChildId);
        processed.add(n.leftChildId);
      }
      if (n.rightChildId && !processed.has(n.rightChildId)) {
        queue.push(n.rightChildId);
        processed.add(n.rightChildId);
      }
    });
  }

  return stats;
}

/* ========================= ROUTES ========================= */

router.get("/tree", auth, async (req, res) => {
  try {
    const rootUserId = req.user.id;
    const depth = parseInt(req.query.depth) || 10; // Default to 10 for full visibility
    const tree = await buildTreeOptimized(rootUserId, depth);
    return res.json({ rootUserId, tree });
  } catch (err) {
    console.error("BINARY TREE ERROR =>", err);
    return res.status(500).json({ msg: "Failed to load tree" });
  }
});

router.get("/stats", auth, async (req, res) => {
  try {
    const rootUserId = req.user.id;

    const rootNode = await BinaryNode.findOne({
      where: { userId: rootUserId },
      attributes: ["userId", "leftChildId", "rightChildId"],
    });

    if (!rootNode) return res.status(404).json({ msg: "Binary tree not initialized" });

    const [
      leftStats,
      rightStats,
      directReferrals,
      rootUser,
      leftCF,
      rightCF,
      leftPaid,
      rightPaid,
      leftFlushed,
      rightFlushed,
    ] = await Promise.all([
      collectSubtreeStats(rootNode.leftChildId),
      collectSubtreeStats(rootNode.rightChildId),
      User.findAll({
        where: { sponsorId: rootUserId },
        attributes: ["id", "userID", "name", "userType", "createdAt"],
      }),
      User.findByPk(rootUserId, {
        attributes: ["paidPairs", "leftCount", "rightCount", "userType", "leftEntCount", "rightEntCount"],
      }),
      // Carry Forward (unused entrepreneurs only)
      PairPending.count({
        where: { uplineUserId: rootUserId, side: "LEFT", isUsed: false, isFlushed: false },
        include: [{ model: User, as: "downline", where: { userType: "ENTREPRENEUR" } }]
      }),
      PairPending.count({
        where: { uplineUserId: rootUserId, side: "RIGHT", isUsed: false, isFlushed: false },
        include: [{ model: User, as: "downline", where: { userType: "ENTREPRENEUR" } }]
      }),
      // Successful Payouts - Count only pairs that have a valid wallet transaction
      PairMatch.count({
        where: { uplineUserId: rootUserId, walletTransactionId: { [Op.ne]: null } },
        include: [{ model: User, as: "leftUser" }],
      }),
      PairMatch.count({
        where: { uplineUserId: rootUserId, walletTransactionId: { [Op.ne]: null } },
        include: [{ model: User, as: "rightUser" }],
      }),
      // Flushed are tricky but usually not stored in PairMatch unless you want them to be.
      // Since PairMatch only stores Successful ones, we stay with PairPending for flushed.
      PairPending.count({
        where: { uplineUserId: rootUserId, side: "LEFT", isUsed: true, isFlushed: true },
        include: [{ model: User, as: "downline", where: { userType: "ENTREPRENEUR" } }],
      }),
      PairPending.count({
        where: { uplineUserId: rootUserId, side: "RIGHT", isUsed: true, isFlushed: true },
        include: [{ model: User, as: "downline", where: { userType: "ENTREPRENEUR" } }],
      }),
    ]);

    console.log(`BINARY STATS DEBUG for ${rootUserId} => L_Paid:${leftPaid} R_Paid:${rightPaid} L_CF:${leftCF} R_CF:${rightCF}`);

    const directStats = {
      TOTAL: directReferrals.length,
      ENTREPRENEUR: 0,
      TRAINEE_ENTREPRENEUR: 0,
      OTHER: 0
    };
    directReferrals.forEach(u => {
      const t = String(u.userType || "").toUpperCase();
      if (t === "ENTREPRENEUR") directStats.ENTREPRENEUR++;
      else if (t === "TRAINEE_ENTREPRENEUR") directStats.TRAINEE_ENTREPRENEUR++;
      else directStats.OTHER++;
    });

    // ✅ Use actual paid pairs from rootUser and carry forward from PairPending counts
    const leftEntReal = leftStats.ENTREPRENEUR;
    const rightEntReal = rightStats.ENTREPRENEUR;
    // Total successful entrepreneur pairs is the count of matches where BOTH sides are Entrepreneurs.
    // However, on a PER SIDE basis, we count each Ent match on that side.
    const overallPaidPairs = Math.min(leftPaid, rightPaid);

    return res.json({
      rootUserId,
      left: {
        ...leftStats,
        TOTAL: leftStats.TOTAL,
        ENTREPRENEUR: leftEntReal,
        TRAINEE_ENTREPRENEUR: leftStats.TRAINEE_ENTREPRENEUR,
        payoutPaidMembers: leftPaid,
        carryForwardMembers: (Number(leftEntReal) - Number(leftPaid) - Number(leftFlushed)) > 0 ? (Number(leftEntReal) - Number(leftPaid) - Number(leftFlushed)) : 0,
        flushedMembers: leftFlushed,
      },
      right: {
        ...rightStats,
        TOTAL: rightStats.TOTAL,
        ENTREPRENEUR: rightEntReal,
        TRAINEE_ENTREPRENEUR: rightStats.TRAINEE_ENTREPRENEUR,
        payoutPaidMembers: rightPaid,
        carryForwardMembers: (Number(rightEntReal) - Number(rightPaid) - Number(rightFlushed)) > 0 ? (Number(rightEntReal) - Number(rightPaid) - Number(rightFlushed)) : 0,
        flushedMembers: rightFlushed,
      },
      overall: {
        TOTAL: leftStats.TOTAL + rightStats.TOTAL,
        ENTREPRENEUR: leftEntReal + rightEntReal,
        TRAINEE_ENTREPRENEUR: leftStats.TRAINEE_ENTREPRENEUR + rightStats.TRAINEE_ENTREPRENEUR,
        OTHER: leftStats.OTHER + rightStats.OTHER,
      },
      direct: directStats,
      directReferralsList: directReferrals.map(u => ({
        id: u.id,
        userID: u.userID,
        name: u.name,
        userType: u.userType,
        joinedAt: u.createdAt,
      })),
      totalPairs: overallPaidPairs,
      leftCarryForward: (Number(leftEntReal) - Number(leftPaid) - Number(leftFlushed)) > 0 ? (Number(leftEntReal) - Number(leftPaid) - Number(leftFlushed)) : 0,
      rightCarryForward: (Number(rightEntReal) - Number(rightPaid) - Number(rightFlushed)) > 0 ? (Number(rightEntReal) - Number(rightPaid) - Number(rightFlushed)) : 0,
      meta: {
        leftCount: leftStats.TOTAL,
        rightCount: rightStats.TOTAL,
        leftEntCount: leftEntReal,
        rightEntCount: rightEntReal,
        payoutPaidMembers: overallPaidPairs,
        leftPaidMembers: leftPaid,
        rightPaidMembers: rightPaid,
        leftCFMembers: (Number(leftEntReal) - Number(leftPaid) - Number(leftFlushed)) > 0 ? (Number(leftEntReal) - Number(leftPaid) - Number(leftFlushed)) : 0,
        rightCFMembers: (Number(rightEntReal) - Number(rightPaid) - Number(rightFlushed)) > 0 ? (Number(rightEntReal) - Number(rightPaid) - Number(rightFlushed)) : 0,
        leftFlushedMembers: leftFlushed,
        rightFlushedMembers: rightFlushed,
      },
    });
  } catch (err) {
    console.error("TREE STATS ERROR =>", err);
    return res.status(500).json({ msg: "Failed to get stats" });
  }
});

router.get("/admin/tree", auth, isAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) return res.status(400).json({ msg: "q is required (userID/name/id)" });

    let user = null;
    if (/^\d+$/.test(q)) {
      user = await User.findByPk(Number(q), { attributes: ["id", "userID", "name"] });
    }
    if (!user) {
      user = await User.findOne({
        where: { userID: q },
        attributes: ["id", "userID", "name"]
      });
    }
    if (!user) {
      user = await User.findOne({
        where: { name: { [Op.like]: `%${q}%` } },
        attributes: ["id", "userID", "name"]
      });
    }

    if (!user) return res.status(404).json({ msg: "User not found" });

    const tree = await buildTreeOptimized(user.id, 4);
    return res.json({ searched: q, targetUser: user, tree });
  } catch (err) {
    console.error("ADMIN TREE ERROR =>", err);
    return res.status(500).json({ msg: "Failed to load admin tree" });
  }
});

export default router;
