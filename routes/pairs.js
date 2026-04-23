import express from "express";
import { Op } from "sequelize";

import auth from "../middleware/auth.js";
import isAdmin from "../middleware/isAdmin.js";

import PairMatch from "../models/PairMatch.js";
import User from "../models/User.js";

const router = express.Router();

/**
 * GET /api/pairs/my
 * Query:
 *  - from=2026-01-01 (optional)
 *  - to=2026-01-31   (optional)
 */
router.get("/my", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const where = { uplineUserId: userId };

    if (req.query.from || req.query.to) {
      where.matchedAt = {};
      if (req.query.from) where.matchedAt[Op.gte] = new Date(req.query.from);
      if (req.query.to) where.matchedAt[Op.lte] = new Date(req.query.to);
    }

    const rows = await PairMatch.findAll({
      where,
      order: [["matchedAt", "DESC"], ["id", "DESC"]],
    });

    const ids = Array.from(
      new Set(rows.flatMap((r) => [r.leftUserId, r.rightUserId]).filter(Boolean))
    );

    const users = await User.findAll({
      where: { id: ids },
      attributes: ["id", "name", "referralCode", "phone"],
    });
    const map = new Map(users.map((u) => [u.id, u]));

    const data = rows.map((r) => ({
      id: r.id,
      uplineUserId: r.uplineUserId,
      leftUserId: r.leftUserId,
      rightUserId: r.rightUserId,
      leftUser: map.get(r.leftUserId) || null,
      rightUser: map.get(r.rightUserId) || null,
      bonusEach: r.bonusEach,
      amount: r.amount,
      walletTransactionId: r.walletTransactionId,
      matchedAt: r.matchedAt,
      createdAt: r.createdAt,
    }));

    return res.json({
      totalPairs: data.length,
      totalAmount: data.reduce((s, x) => s + Number(x.amount || 0), 0),
      matches: data,
    });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});

/**
 * GET /api/pairs/admin
 * Query:
 *  - uplineUserId=1 (optional)
 *  - search=mani (optional: search upline name/phone/referralCode)
 *  - from=2026-01-01 (optional)
 *  - to=2026-01-31   (optional)
 */
router.get("/admin", auth, isAdmin, async (req, res) => {
  try {
    const where = {};

    if (req.query.uplineUserId) {
      where.uplineUserId = Number(req.query.uplineUserId);
    }

    if (req.query.from || req.query.to) {
      where.matchedAt = {};
      if (req.query.from) where.matchedAt[Op.gte] = new Date(req.query.from);
      if (req.query.to) where.matchedAt[Op.lte] = new Date(req.query.to);
    }

    // search by upline user (name/phone/referralCode/id)
    if (req.query.search) {
      const q = String(req.query.search).trim();
      if (q) {
        const users = await User.findAll({
          where: {
            [Op.or]: [
              { name: { [Op.like]: `%${q}%` } },
              { phone: { [Op.like]: `%${q}%` } },
              { referralCode: { [Op.like]: `%${q}%` } },
              ...(String(Number(q)) === q ? [{ id: Number(q) }] : []),
            ],
          },
          attributes: ["id"],
        });

        const ids = users.map((u) => u.id);
        where.uplineUserId = { [Op.in]: ids.length ? ids : [-1] };
      }
    }

    const rows = await PairMatch.findAll({
      where,
      order: [["matchedAt", "DESC"], ["id", "DESC"]],
    });

    const allIds = Array.from(
      new Set(rows.flatMap((r) => [r.uplineUserId, r.leftUserId, r.rightUserId]).filter(Boolean))
    );

    const users = await User.findAll({
      where: { id: allIds },
      attributes: ["id", "name", "phone", "referralCode"],
    });
    const map = new Map(users.map((u) => [u.id, u]));

    const data = rows.map((r) => ({
      id: r.id,
      uplineUserId: r.uplineUserId,
      uplineUser: map.get(r.uplineUserId) || null,

      leftUserId: r.leftUserId,
      leftUser: map.get(r.leftUserId) || null,

      rightUserId: r.rightUserId,
      rightUser: map.get(r.rightUserId) || null,

      bonusEach: r.bonusEach,
      amount: r.amount,
      walletTransactionId: r.walletTransactionId,
      matchedAt: r.matchedAt,
    }));

    const totalAmount = data.reduce((s, x) => s + Number(x.amount || 0), 0);

    return res.json({
      summary: {
        totalPairs: data.length,
        totalAmount,
      },
      matches: data,
    });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});

export default router;
