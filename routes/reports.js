import express from "express";
import auth from "../middleware/auth.js";
import { Op, Sequelize } from "sequelize";
import { DateTime } from "luxon";
import { sequelize } from "../config/db.js";

import User from "../models/User.js";
import Product from "../models/Product.js";
import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";
import PairMatch from "../models/PairMatch.js";
import PairPending from "../models/PairPending.js";
import BinaryNode from "../models/BinaryNode.js";

const router = express.Router();

function getIstRange(dateStr) {
  const zone = "Asia/Kolkata";

  const dt = dateStr
    ? DateTime.fromISO(dateStr, { zone })
    : DateTime.now().setZone(zone);

  const start = dt.startOf("day").toUTC().toJSDate();
  const end = dt.plus({ days: 1 }).startOf("day").toUTC().toJSDate();

  return { start, end, istDate: dt.toISODate(), zone };
}

/* ================= HELPERS ================= */

function getRangeForPeriod(period, zone = "Asia/Kolkata") {
  const now = DateTime.now().setZone(zone);
  let start;
  let end = now.plus({ days: 1 }).startOf("day").toUTC().toJSDate();

  if (period === "day") {
    start = now.startOf("day").toUTC().toJSDate();
  } else if (period === "week") {
    start = now.startOf("week").toUTC().toJSDate();
  } else if (period === "month") {
    start = now.startOf("month").toUTC().toJSDate();
  } else if (period === "year") {
    start = now.startOf("year").toUTC().toJSDate();
  } else {
    start = now.startOf("day").toUTC().toJSDate();
  }

  return { start, end };
}

async function getReferralCount(userId, start, end) {
  return await User.count({
    where: {
      sponsorId: userId,
      createdAt: { [Op.gte]: start, [Op.lt]: end },
    },
  });
}

// Fetch all binary downline IDs recursively (BFS)
async function getAllBinaryDownlineIds(userId) {
  const downlineIds = [];
  let queue = [];

  const rootNode = await BinaryNode.findOne({
    where: { userId },
    attributes: ["leftChildId", "rightChildId"],
  });

  if (rootNode) {
    if (rootNode.leftChildId) queue.push(rootNode.leftChildId);
    if (rootNode.rightChildId) queue.push(rootNode.rightChildId);
  }

  while (queue.length > 0) {
    const batch = queue.splice(0, 50);
    const nodes = await BinaryNode.findAll({
      where: { userId: { [Op.in]: batch } },
      attributes: ["userId", "leftChildId", "rightChildId"],
    });

    nodes.forEach((n) => {
      downlineIds.push(n.userId);
      if (n.leftChildId) queue.push(n.leftChildId);
      if (n.rightChildId) queue.push(n.rightChildId);
    });
  }
  return downlineIds;
}

async function getTeamCount(downlineIds, start, end) {
  if (!downlineIds || downlineIds.length === 0) return 0;
  return await User.count({
    where: {
      id: { [Op.in]: downlineIds },
      createdAt: { [Op.gte]: start, [Op.lt]: end },
    },
  });
}

const sumAmounts = (txns) =>
  txns.reduce((acc, t) => acc + Number(t.amount || 0), 0);

const isPendingTxn = (txn) => txn?.meta?.pending === true;

/* ================= ROUTES ================= */

// ✅ GET /api/reports/referral-summary
router.get("/referral-summary", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const periods = ["day", "week", "month", "year"];

    // 1. Get all downline IDs first
    const downlineIds = await getAllBinaryDownlineIds(userId);

    // 2. Fetch all counts in parallel
    const counts = await Promise.all(
      periods.map(async (p) => {
        const { start, end } = getRangeForPeriod(p);
        const [direct, overall] = await Promise.all([
          getReferralCount(userId, start, end),
          getTeamCount(downlineIds, start, end),
        ]);
        return { period: p, direct, overall };
      })
    );

    const summary = {};
    const directSummary = {};
    counts.forEach((c) => {
      summary[c.period] = c.overall; // Set main summary to overall as requested
      directSummary[c.period] = c.direct;
    });

    return res.json({
      userId,
      timezone: "Asia/Kolkata",
      summary, // Overall team stats
      directSummary, // Just direct referrals
    });
  } catch (err) {
    console.error("REFERRAL SUMMARY ERROR =>", err);
    return res
      .status(500)
      .json({ msg: "Failed to get referral summary", err: err.message });
  }
});

// ✅ GET /api/reports/daily-income?date=2026-02-07
router.get("/daily-income", auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const { start, end, istDate, zone } = getIstRange(req.query.date);

    const wallet = await Wallet.findOne({ where: { userId } });
    if (!wallet) return res.status(404).json({ msg: "Wallet not found" });

    // 1) pairs matched today (ceiling applied pairs only)
    const pairsMatched = await PairMatch.count({
      where: {
        uplineUserId: userId,
        matchedAt: { [Op.gte]: start, [Op.lt]: end },
      },
    });

    // 2) flushed count today (because you want NO carry forward)
    const flushedPairs = await PairPending.count({
      where: {
        uplineUserId: userId,
        isFlushed: true,
        flushedAt: { [Op.gte]: start, [Op.lt]: end },
      },
    });

    // 3) fetch today transactions (pair + join)
    const txns = await WalletTransaction.findAll({
      where: {
        walletId: wallet.id,
        type: "CREDIT",
        reason: { [Op.in]: ["PAIR_BONUS", "REFERRAL_JOIN_BONUS"] },
        createdAt: { [Op.gte]: start, [Op.lt]: end },
      },
      order: [["id", "DESC"]],
    });

    const pairTxns = txns.filter((t) => t.reason === "PAIR_BONUS");
    const joinTxns = txns.filter((t) => t.reason === "REFERRAL_JOIN_BONUS");

    const pairCredited = pairTxns.filter((t) => !isPendingTxn(t));
    const pairPending = pairTxns.filter((t) => isPendingTxn(t));

    const joinCredited = joinTxns.filter((t) => !isPendingTxn(t));
    const joinPending = joinTxns.filter((t) => isPendingTxn(t));

    const report = {
      date: istDate,
      timezone: zone,

      pairsMatched,
      flushedPairs,

      pairIncome: {
        credited: Number(sumAmounts(pairCredited).toFixed(2)),
        pending: Number(sumAmounts(pairPending).toFixed(2)),
        total: Number(sumAmounts(pairTxns).toFixed(2)),
        transactionsCount: pairTxns.length,
      },

      joinIncome: {
        credited: Number(sumAmounts(joinCredited).toFixed(2)),
        pending: Number(sumAmounts(joinPending).toFixed(2)),
        total: Number(sumAmounts(joinTxns).toFixed(2)),
        transactionsCount: joinTxns.length,
      },

      totals: {
        credited: Number(
          (sumAmounts(pairCredited) + sumAmounts(joinCredited)).toFixed(2)
        ),
        pending: Number(
          (sumAmounts(pairPending) + sumAmounts(joinPending)).toFixed(2)
        ),
        grandTotal: Number((sumAmounts(pairTxns) + sumAmounts(joinTxns)).toFixed(2)),
      },

      recent: {
        pairTxns: pairTxns.slice(0, 20).map((t) => ({
          id: t.id,
          amount: Number(t.amount || 0),
          pending: isPendingTxn(t),
          createdAt: t.createdAt,
          meta: t.meta || null,
        })),
        joinTxns: joinTxns.slice(0, 20).map((t) => ({
          id: t.id,
          amount: Number(t.amount || 0),
          pending: isPendingTxn(t),
          createdAt: t.createdAt,
          meta: t.meta || null,
        })),
      },
    };

    return res.json(report);
  } catch (err) {
    console.error("DAILY INCOME REPORT ERROR =>", err);
    return res
      .status(500)
      .json({ msg: "Failed to get daily report", err: err.message });
  }
});

// ✅ GET /api/reports/admin/registration-stats
// Params (all optional):
//   ?period=today|week|month|year   → quick shortcuts
//   ?startDate=2026-03-01&endDate=2026-03-17  → custom range
//   (no params) → defaults to today
router.get("/admin/registration-stats", auth, async (req, res) => {
  try {
    // 1. Admin-only access
    const role = req.user.role;
    if (!["ADMIN", "MASTER", "STAFF"].includes(role)) {
      return res.status(403).json({ msg: "Access denied. Admins only." });
    }

    // 2. Resolve date range — period shortcut OR startDate/endDate OR today
    const zone     = "Asia/Kolkata";
    const todayIST = DateTime.now().setZone(zone);
    let start, end;

    if (req.query.period) {
      // ✅ Quick shortcut: ?period=today|week|month|year
      const { start: s, end: e } = getRangeForPeriod(req.query.period, zone);
      start = DateTime.fromJSDate(s, { zone }).startOf("day");
      end   = DateTime.fromJSDate(e, { zone }).minus({ milliseconds: 1 }); // end is exclusive in helper
    } else {
      // ✅ Custom range or default today
      const rawStart = req.query.startDate || todayIST.toISODate();
      const rawEnd   = req.query.endDate   || todayIST.toISODate();
      start = DateTime.fromISO(rawStart, { zone }).startOf("day");
      end   = DateTime.fromISO(rawEnd,   { zone }).endOf("day");
    }

    if (!start.isValid || !end.isValid) {
      return res
        .status(400)
        .json({ msg: "Invalid date format. Use YYYY-MM-DD." });
    }

    if (start > end) {
      return res
        .status(400)
        .json({ msg: "startDate must be before or equal to endDate." });
    }

    const diffDays = end.diff(start, "days").days;
    if (diffDays > 366) {
      return res
        .status(400)
        .json({ msg: "Date range cannot exceed 366 days." });
    }

    // 3. Convert IST range → UTC for DB queries
    const utcStart = start.toUTC().toJSDate();
    const utcEnd   = end.toUTC().toJSDate();

    // 4. Build full label array — one entry per calendar day in range
    const labels = [];
    let cursor = start.startOf("day");
    const endDay = end.startOf("day");
    while (cursor <= endDay) {
      labels.push(cursor.toISODate()); // "2026-03-17"
      cursor = cursor.plus({ days: 1 });
    }

    // 5. Run 2 parallel raw SQL queries (IST date grouping via CONVERT_TZ)
    const [regRows, upgradeRows] = await Promise.all([
      // Query A: Daily new registrations
      sequelize.query(
        `SELECT DATE_FORMAT(CONVERT_TZ(createdAt, '+00:00', '+05:30'), '%Y-%m-%d') AS day,
                COUNT(*) AS count
         FROM Users
         WHERE createdAt >= :utcStart AND createdAt <= :utcEnd
         GROUP BY day
         ORDER BY day ASC`,
        {
          replacements: { utcStart, utcEnd },
          type: sequelize.QueryTypes.SELECT,
        }
      ),

      // Query B: Daily entrepreneur upgrades (by activationDate)
      sequelize.query(
        `SELECT DATE_FORMAT(CONVERT_TZ(activationDate, '+00:00', '+05:30'), '%Y-%m-%d') AS day,
                COUNT(*) AS count
         FROM Users
         WHERE activationDate >= :utcStart AND activationDate <= :utcEnd
           AND userType = 'ENTREPRENEUR'
         GROUP BY day
         ORDER BY day ASC`,
        {
          replacements: { utcStart, utcEnd },
          type: sequelize.QueryTypes.SELECT,
        }
      ),
    ]);

    // 6. Build Maps — r.day is guaranteed "%Y-%m-%d" string → safe Map key
    const regMap     = new Map(regRows.map((r) => [r.day, Number(r.count)]));
    const upgradeMap = new Map(upgradeRows.map((r) => [r.day, Number(r.count)]));

    // 7. Map results onto label array — missing days get 0
    const registrations        = labels.map((d) => regMap.get(d)     || 0);
    const entrepreneurUpgrades = labels.map((d) => upgradeMap.get(d) || 0);

    const totalRegistrations        = registrations.reduce((a, b) => a + b, 0);
    const totalEntrepreneurUpgrades = entrepreneurUpgrades.reduce((a, b) => a + b, 0);

    return res.json({
      labels,
      datasets: {
        registrations,
        entrepreneurUpgrades,
      },
      summary: {
        totalRegistrations,
        totalEntrepreneurUpgrades,
        // Always normalized IST YYYY-MM-DD strings
        dateRange: {
          from: start.toISODate(),
          to:   end.toISODate(),
        },
      },
    });
  } catch (err) {
    console.error("REGISTRATION STATS ERROR =>", err);
    return res
      .status(500)
      .json({ msg: "Failed to get registration stats", err: err.message });
  }
});

// ✅ GET /api/reports/admin/stock-summary
// Query params (all optional):
//   ?sortBy=best_seller|highest_orders|low_stock|out_of_stock|newest  (default: newest)
//   ?search=keyword        → filter by product name
//   ?category=Health       → filter by category
//   ?page=1&limit=20       → pagination
router.get("/admin/stock-summary", auth, async (req, res) => {
  try {
    // 1. Admin-only
    if (!["ADMIN", "MASTER", "STAFF"].includes(req.user.role)) {
      return res.status(403).json({ msg: "Access denied. Admins only." });
    }

    // 2. Pagination & filters
    const page     = Math.max(1, parseInt(req.query.page  || "1",  10));
    const limit    = Math.max(1, parseInt(req.query.limit || "20", 10));
    const offset   = (page - 1) * limit;
    const search   = (req.query.search   || "").trim();
    const category = (req.query.category || "").trim();

    // 3. sortBy → 5 modes
    //   best_seller    🏆  most DELIVERED qty first
    //   highest_orders 📦  most total orders (sold + pending) first
    //   low_stock      ⚠️  stock > 0 but < 10, least first
    //   out_of_stock   🔴  stockQty = 0 only
    //   newest         🆕  latest added first (default)
    const SORT_MAP = {
      best_seller:    "soldQty DESC, p.name ASC",
      highest_orders: "(soldQty + pendingQty) DESC, p.name ASC",
      low_stock:      "currentStock ASC, soldQty DESC",
      out_of_stock:   "soldQty DESC, p.name ASC",
      newest:         "p.createdAt DESC",
    };
    const sortBy  = SORT_MAP[req.query.sortBy] ? req.query.sortBy : "newest";
    const orderBy = SORT_MAP[sortBy];

    // 4. Build WHERE clause dynamically
    const conditions   = ["p.isActive = 1"];
    const replacements = { limit, offset };

    if (search) {
      conditions.push("p.name LIKE :search");
      replacements.search = `%${search}%`;
    }
    if (category) {
      conditions.push("p.categoryName = :category");
      replacements.category = category;
    }
    if (sortBy === "out_of_stock") conditions.push("p.stockQty = 0");
    if (sortBy === "low_stock")    conditions.push("p.stockQty > 0 AND p.stockQty < 10");

    const whereClause = conditions.join(" AND ");

    // 5. Single SQL: LEFT JOIN OrderItems + Orders, aggregate per product
    const rows = await sequelize.query(
      `SELECT
         p.id,
         p.name,
         p.brand,
         p.categoryName,
         p.subCategoryName,
         p.mrp,
         p.price,
         p.stockQty AS currentStock,
         COALESCE(SUM(CASE WHEN o.status = 'DELIVERED'         THEN oi.qty ELSE 0 END), 0) AS soldQty,
         COALESCE(SUM(CASE WHEN o.status IN ('PENDING','PAID') THEN oi.qty ELSE 0 END), 0) AS pendingQty
       FROM Products p
       LEFT JOIN OrderItems oi ON oi.productId = p.id
       LEFT JOIN Orders     o  ON o.id = oi.orderId
       WHERE ${whereClause}
       GROUP BY p.id
       ORDER BY ${orderBy}
       LIMIT :limit OFFSET :offset`,
      { replacements, type: sequelize.QueryTypes.SELECT }
    );

    // Count query for pagination
    const countRows = await sequelize.query(
      `SELECT COUNT(*) AS total FROM Products p WHERE ${whereClause}`,
      { replacements, type: sequelize.QueryTypes.SELECT }
    );
    const totalItems = Number(countRows[0]?.total || 0);

    // 6. Shape each product row
    const LOW_STOCK_THRESHOLD = 10;
    const products = rows.map((p) => {
      const currentStock  = Number(p.currentStock);
      const soldQty       = Number(p.soldQty);
      const pendingQty    = Number(p.pendingQty);
      const price         = Number(p.price);
      const totalUploaded = currentStock + soldQty + pendingQty;
      const revenue       = Number((soldQty * price).toFixed(2));

      return {
        id:          p.id,
        name:        p.name,
        brand:       p.brand || null,
        category:    p.categoryName,
        subCategory: p.subCategoryName || null,
        mrp:         Number(p.mrp),
        price,
        // ── Stock breakdown ─────────────────────
        totalUploaded,  // ever stocked = current + sold + pending
        soldQty,        // DELIVERED orders qty
        pendingQty,     // PENDING / PAID (not yet delivered)
        currentStock,   // remaining right now
        revenue,        // approx: soldQty × price
        isLowStock:   currentStock > 0 && currentStock < LOW_STOCK_THRESHOLD,
        isOutOfStock: currentStock === 0,
      };
    });

    // 7. Summary across current page results
    const summary = {
      totalCurrentStock: products.reduce((a, p) => a + p.currentStock,  0),
      totalSold:         products.reduce((a, p) => a + p.soldQty,        0),
      totalPending:      products.reduce((a, p) => a + p.pendingQty,     0),
      totalUploaded:     products.reduce((a, p) => a + p.totalUploaded,  0),
      totalRevenue:      Number(products.reduce((a, p) => a + p.revenue, 0).toFixed(2)),
      lowStockCount:     products.filter((p) => p.isLowStock).length,
      outOfStockCount:   products.filter((p) => p.isOutOfStock).length,
    };

    return res.json({
      sortedBy: sortBy,
      products,
      summary,
      pagination: {
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
        currentPage: page,
        limit,
      },
    });
  } catch (err) {
    console.error("STOCK SUMMARY ERROR =>", err);
    return res
      .status(500)
      .json({ msg: "Failed to get stock summary", err: err.message });
  }
});

export default router;