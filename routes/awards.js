import express from "express";
import auth from "../middleware/auth.js";
import isAdmin from "../middleware/isAdmin.js";
import { Op, fn, col } from "sequelize";

import PairMatch from "../models/PairMatch.js";
import RankSetting from "../models/RankSetting.js";
import RankAchievement from "../models/RankAchievement.js";
import User from "../models/User.js";

const router = express.Router();

/* ================= USER: MY AWARDS =================
GET /api/awards/my
*/
router.get("/my", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const totalPairs = await PairMatch.count({ where: { uplineUserId: userId } });

    const settings = await RankSetting.findAll({
      where: { isActive: true },
      order: [["pairsRequired", "ASC"]],
    });

    const achievements = await RankAchievement.findAll({
      where: { userId },
      order: [["pairsRequired", "ASC"]],
    });

    const aMap = new Map(achievements.map((a) => [a.pairsRequired, a]));

    const awards = settings.map((s) => {
      const a = aMap.get(s.pairsRequired);
      const unlocked = totalPairs >= s.pairsRequired;

      return {
        pairsRequired: s.pairsRequired,
        cashReward: Number(s.cashReward || 0),
        giftName: s.giftName || null,
        isActive: !!s.isActive,

        totalPairs,
        unlocked,

        achieved: !!a,
        achievementId: a?.id || null,
        achievedAt: a?.achievedAt || null,
        giftStatus: a?.giftStatus || (unlocked ? "PENDING" : null),
        walletTransactionId: a?.walletTransactionId || null,
        meta: a?.meta || null,
      };
    });

    const reachedLevels = achievements.length;
    const totalCashEarned = achievements.reduce(
      (acc, a) => acc + Number(a.cashReward || 0),
      0
    );

    return res.json({
      userId,
      totalPairs,
      reachedLevels,
      totalCashEarned: Number(totalCashEarned.toFixed(2)),
      awards,
    });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});

/* ================= ADMIN: LIST ALL ACHIEVEMENTS (NO PAGINATION) =================
GET /api/awards/admin/achievements?status=PENDING&search=mani
*/
router.get("/admin/achievements", auth,  async (req, res) => {
  try {
    const status = (req.query.status || "").toUpperCase();
    const search = (req.query.search || "").trim();

    const where = {};
    if (["PENDING", "APPROVED", "DISPATCHED", "DELIVERED", "REJECTED"].includes(status)) {
      where.giftStatus = status;
    }

    const include = [
      {
        model: User,
        attributes: ["id", "userID", "name", "phone", "email"],
        required: false,
        ...(search
          ? {
              where: {
                [Op.or]: [
                  { name: { [Op.like]: `%${search}%` } },
                  { userID: { [Op.like]: `%${search}%` } },
                  { phone: { [Op.like]: `%${search}%` } },
                  { email: { [Op.like]: `%${search}%` } },
                ],
              },
              required: true,
            }
          : {}),
      },
    ];

    const achievements = await RankAchievement.findAll({
      where,
      include,
      order: [["achievedAt", "DESC"]],
    });

    return res.json({
      total: achievements.length,
      achievements,
    });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});

/* ================= ADMIN: UPDATE ACHIEVEMENT STATUS =================
PATCH /api/awards/admin/achievements/:id/status
Body: { giftStatus: "APPROVED"|"DISPATCHED"|"DELIVERED"|"REJECTED", meta?: {...} }
*/
router.patch("/admin/achievements/:id/status", auth, isAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const next = String(req.body.giftStatus || "").toUpperCase();
    const allowed = ["PENDING", "APPROVED", "DISPATCHED", "DELIVERED", "REJECTED"];

    if (!allowed.includes(next)) {
      return res.status(400).json({ msg: "Invalid giftStatus" });
    }

    const ach = await RankAchievement.findByPk(id);
    if (!ach) return res.status(404).json({ msg: "Achievement not found" });

    const meta =
      req.body.meta && typeof req.body.meta === "object" ? req.body.meta : null;

    const updated = await ach.update({
      giftStatus: next,
      meta: meta
        ? { ...(ach.meta || {}), ...meta, updatedAt: new Date().toISOString() }
        : ach.meta,
    });

    return res.json({ msg: "Status updated", achievement: updated });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});

/* ================= ADMIN: USERS SUMMARY (NO PAGINATION) =================
GET /api/awards/admin/users?search=mani
*/
router.get("/admin/users", auth, async (req, res) => {
  try {
    const search = (req.query.search || "").trim();

    const userWhere = {};
    if (search) {
      userWhere[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { userID: { [Op.like]: `%${search}%` } },
        { phone: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
      ];
    }

    const users = await User.findAll({
      where: userWhere,
      attributes: ["id", "userID", "name", "email", "phone", "userType"],
      order: [["id", "DESC"]],
    });

    const userIds = users.map((u) => u.id);

    const pairsAgg = await PairMatch.findAll({
      where: { uplineUserId: userIds },
      attributes: ["uplineUserId", [fn("COUNT", col("id")), "pairs"]],
      group: ["uplineUserId"],
    });
    const pairMap = new Map(
      pairsAgg.map((r) => [Number(r.uplineUserId), Number(r.get("pairs") || 0)])
    );

    const achAgg = await RankAchievement.findAll({
      where: { userId: userIds },
      attributes: [
        "userId",
        [fn("COUNT", col("id")), "levelsReached"],
        [fn("SUM", col("cashReward")), "cashTotal"],
      ],
      group: ["userId"],
    });

    const achMap = new Map(
      achAgg.map((r) => [
        Number(r.userId),
        {
          levelsReached: Number(r.get("levelsReached") || 0),
          cashTotal: Number(r.get("cashTotal") || 0),
        },
      ])
    );

    const out = users.map((u) => {
      const pairs = pairMap.get(u.id) || 0;
      const a = achMap.get(u.id) || { levelsReached: 0, cashTotal: 0 };
      return {
        id: u.id,
        userID: u.userID,
        name: u.name,
        phone: u.phone,
        email: u.email,
        userType: u.userType,
        totalPairs: pairs,
        levelsReached: a.levelsReached,
        totalAwardCash: Number(a.cashTotal.toFixed(2)),
      };
    });

    return res.json({ total: out.length, users: out });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});
// ================= ADMIN: LIST SETTINGS =================
// GET /api/awards/admin/settings
router.get("/admin/settings", auth, async (req, res) => {
  try {
    const settings = await RankSetting.findAll({
      order: [["pairsRequired", "ASC"]],
    });
    return res.json({ total: settings.length, settings });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});

// ================= ADMIN: CREATE SETTING =================
// POST /api/awards/admin/settings
// Body: { pairsRequired, cashReward?, giftName?, isActive? }
router.post("/admin/settings", auth,  async (req, res) => {
  try {
    const pairsRequired = Number(req.body.pairsRequired);
    const cashReward = req.body.cashReward != null ? Number(req.body.cashReward) : 0;
    const giftName = req.body.giftName ? String(req.body.giftName).trim() : null;
    const isActive = req.body.isActive === undefined ? true : !!req.body.isActive;

    if (!pairsRequired || pairsRequired <= 0) {
      return res.status(400).json({ msg: "pairsRequired must be > 0" });
    }

    // prevent duplicate level
    const exists = await RankSetting.findOne({ where: { pairsRequired } });
    if (exists) {
      return res.status(400).json({ msg: "This pairsRequired already exists" });
    }

    const row = await RankSetting.create({
      pairsRequired,
      cashReward,
      giftName,
      isActive,
    });

    return res.json({ msg: "Award level created", setting: row });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});
// ================= ADMIN: UPDATE SETTING =================
// PATCH /api/awards/admin/settings/:id
router.patch("/admin/settings/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await RankSetting.findByPk(id);
    if (!row) return res.status(404).json({ msg: "Setting not found" });

    // optional updates
    if (req.body.pairsRequired != null) {
      const pairsRequired = Number(req.body.pairsRequired);
      if (!pairsRequired || pairsRequired <= 0) {
        return res.status(400).json({ msg: "pairsRequired must be > 0" });
      }

      const exists = await RankSetting.findOne({ where: { pairsRequired } });
      if (exists && exists.id !== row.id) {
        return res.status(400).json({ msg: "This pairsRequired already exists" });
      }

      row.pairsRequired = pairsRequired;
    }

    if (req.body.cashReward != null) row.cashReward = Number(req.body.cashReward);
    if (req.body.giftName !== undefined)
      row.giftName = req.body.giftName ? String(req.body.giftName).trim() : null;

    if (req.body.isActive !== undefined) row.isActive = !!req.body.isActive;

    await row.save();

    return res.json({ msg: "Award level updated", setting: row });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});

// ================= ADMIN: DELETE SETTING =================
// DELETE /api/awards/admin/settings/:id
router.delete("/admin/settings/:id", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await RankSetting.findByPk(id);
    if (!row) return res.status(404).json({ msg: "Setting not found" });

    await row.destroy();
    return res.json({ msg: "Award level deleted" });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});



export default router;
