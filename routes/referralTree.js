import express from "express";
import auth from "../middleware/auth.js";
import User from "../models/User.js";
import BinaryNode from "../models/BinaryNode.js";

const router = express.Router();

/* ========================= HELPERS ========================= */

// Collect ALL userIds in a subtree starting from startUserId
// (startUserId itself included). Works because leftChildId/rightChildId are USER IDs.
async function collectSubtreeUserIds(startUserId) {
  if (!startUserId) return [];

  const out = [];
  const queue = [startUserId];
  const visited = new Set();

  while (queue.length) {
    const userId = queue.shift();
    if (!userId || visited.has(userId)) continue;

    visited.add(userId);
    out.push(userId);

    const node = await BinaryNode.findOne({
      where: { userId },
      attributes: ["leftChildId", "rightChildId"],
    });

    if (node?.leftChildId) queue.push(node.leftChildId);
    if (node?.rightChildId) queue.push(node.rightChildId);
  }

  return out;
}

// Count by userType based on Users table values (latest)
function countByUserType(users) {
  const stats = {
    TOTAL: 0,
    ENTREPRENEUR: 0,
    TRAINEE_ENTREPRENEUR: 0,
    OTHER: 0,
  };

  for (const u of users) {
    stats.TOTAL += 1;
    const t = String(u?.userType || "").toUpperCase();

    if (t === "ENTREPRENEUR") stats.ENTREPRENEUR += 1;
    else if (t === "TRAINEE_ENTREPRENEUR") stats.TRAINEE_ENTREPRENEUR += 1;
    else stats.OTHER += 1;
  }

  return stats;
}

/* ========================= TREE BUILDER ========================= */

async function buildTree(rootUserId, depth) {
  const maxDepth = Math.max(1, Math.min(Number(depth || 4), 10));

  // root node by userId
  const rootNode = await BinaryNode.findOne({
    where: { userId: rootUserId },
    attributes: ["userId", "leftChildId", "rightChildId"],
  });
  if (!rootNode) return null;

  const nodeMap = new Map(); // userId -> node
  const userMap = new Map(); // userId -> user
  const levelMap = new Map(); // userId -> level

  let frontierUserIds = [rootNode.userId];
  levelMap.set(rootNode.userId, 0);

  for (let lvl = 0; lvl <= maxDepth; lvl++) {
    if (!frontierUserIds.length) break;

    // fetch nodes by userId
    const nodes = await BinaryNode.findAll({
      where: { userId: frontierUserIds },
      attributes: ["userId", "leftChildId", "rightChildId"],
    });

    const userIds = nodes.map((n) => n.userId);

    // fetch users for these nodes (latest userType will come from Users table)
    const users = await User.findAll({
      where: { id: userIds },
      attributes: ["id", "userID", "name", "referralCode", "userType", "role", "profilePic"],
    });

    for (const n of nodes) nodeMap.set(n.userId, n);
    for (const u of users) userMap.set(u.id, u);

    // prepare next frontier using child USER IDs
    const next = [];
    for (const n of nodes) {
      const curLevel = levelMap.get(n.userId) ?? lvl;
      if (curLevel >= maxDepth) continue;

      if (n.leftChildId && !levelMap.has(n.leftChildId)) {
        levelMap.set(n.leftChildId, curLevel + 1);
        next.push(n.leftChildId);
      }
      if (n.rightChildId && !levelMap.has(n.rightChildId)) {
        levelMap.set(n.rightChildId, curLevel + 1);
        next.push(n.rightChildId);
      }
    }
    frontierUserIds = next;
  }

  const toJson = (userId, curDepth) => {
    const n = nodeMap.get(userId);
    if (!n) return null;

    const u = userMap.get(userId);

    const out = {
      userPkId: u?.id ?? null,
      userID: u?.userID ?? null,
      name: u?.name ?? "—",
      referralCode: u?.referralCode ?? null,
      userType: u?.userType ?? null, // ✅ latest from Users table
      role: u?.role ?? null,
      profilePic: u?.profilePic ?? null,

      leftUserId: n.leftChildId ?? null,
      rightUserId: n.rightChildId ?? null,

      left: null,
      right: null,
    };

    if (curDepth >= maxDepth) return out;

    out.left = n.leftChildId ? toJson(n.leftChildId, curDepth + 1) : null;
    out.right = n.rightChildId ? toJson(n.rightChildId, curDepth + 1) : null;

    return out;
  };

  return toJson(rootNode.userId, 0);
}

/* ========================= ROUTES ========================= */

// GET /api/binary/tree?depth=4
router.get("/tree", auth, async (req, res) => {
  try {
    const depth = Number(req.query.depth || 4);
    const tree = await buildTree(req.user.id, depth);

    if (!tree) return res.status(404).json({ msg: "Binary tree not initialized" });

    return res.json({
      rootUserId: req.user.id,
      depth: Math.max(1, Math.min(depth, 10)),
      tree,
    });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});

// GET /api/binary/stats
// Returns counts by userType (latest from Users table) for left/right/overall
router.get("/stats", auth, async (req, res) => {
  try {
    const rootUserId = req.user.id;

    const rootNode = await BinaryNode.findOne({
      where: { userId: rootUserId },
      attributes: ["userId", "leftChildId", "rightChildId"],
    });
    if (!rootNode) return res.status(404).json({ msg: "Binary tree not initialized" });

    // collect left/right subtree userIds
    const [leftUserIds, rightUserIds] = await Promise.all([
      collectSubtreeUserIds(rootNode.leftChildId),
      collectSubtreeUserIds(rootNode.rightChildId),
    ]);

    const leftSet = Array.from(new Set(leftUserIds));
    const rightSet = Array.from(new Set(rightUserIds));

    // overall unique to avoid double count (just in case)
    const overallSet = Array.from(new Set([...leftSet, ...rightSet]));

    // fetch users (latest userType)
    const users = await User.findAll({
      where: { id: overallSet },
      attributes: ["id", "userID", "userType", "name"],
    });

    const uMap = new Map(users.map((u) => [u.id, u]));

    const leftUsers = leftSet.map((id) => uMap.get(id)).filter(Boolean);
    const rightUsers = rightSet.map((id) => uMap.get(id)).filter(Boolean);
    const overallUsers = overallSet.map((id) => uMap.get(id)).filter(Boolean);

    return res.json({
      rootUserId,
      left: countByUserType(leftUsers),
      right: countByUserType(rightUsers),
      overall: countByUserType(overallUsers),

      // optional: show ids count
      meta: {
        leftCount: leftUsers.length,
        rightCount: rightUsers.length,
        overallCount: overallUsers.length,
      },
    });
  } catch (err) {
    console.error("TREE STATS ERROR =>", err);
    return res.status(500).json({ msg: "Failed to get stats", err: err.message });
  }
});

export default router;
