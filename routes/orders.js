
// ========================= routes/orders.js (FULL CODE WITH FIXES) =========================
import express from "express";
import auth from "../middleware/auth.js";
import isAdmin from "../middleware/isAdmin.js";
import { Op } from "sequelize";

import { sequelize } from "../config/db.js";

import Cart from "../models/Cart.js";
import CartItem from "../models/CartItem.js";
import Product from "../models/Product.js";

import Order from "../models/Order.js";
import OrderItem from "../models/OrderItem.js";

import Wallet from "../models/Wallet.js";
import WalletTransaction from "../models/WalletTransaction.js";

import DeliveryCharge from "../models/DeliveryCharge.js";
import Address from "../models/Address.js";
import User from "../models/User.js";

import Referral from "../models/Referral.js";
import { updateUplineEntrepreneurCounts } from "./auth.js";
import { getSettingNumber } from "../utils/appSettings.js";

const router = express.Router();

/* ======================================================================================
   ✅ IMPORTANT FIXES ADDED
   1) meta can be STRING in production → safe JSON parse everywhere
   2) release logic should run on EVERY first-time DELIVERED (not only newly-unlocked)
   3) walletMap ensures single wallet instance per transaction, save once at end
====================================================================================== */

// ✅ meta safe parser (works if DB stores JSON string or object)
function parseMeta(txn) {
  const m = txn?.meta;
  if (!m) return {};
  if (typeof m === "string") {
    try {
      return JSON.parse(m);
    } catch {
      return {};
    }
  }
  return m;
}

// ✅ Helper: keep ONE wallet instance per user in transaction (avoid stale instance)
async function getWalletFromMap(userId, walletMap, t) {
  if (walletMap.has(userId)) return walletMap.get(userId);

  const wallet = await Wallet.findOne({
    where: { userId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  if (wallet) walletMap.set(userId, wallet);
  return wallet;
}

async function addSpendAndUnlockIfNeeded({ userId, amount, t, walletMap, minSpend }) {
  const wallet = await getWalletFromMap(userId, walletMap, t);
  if (!wallet) throw new Error("Wallet not found for userId: " + userId);

  const wasUnlocked = !!wallet.isUnlocked;

  wallet.totalSpent = Number(wallet.totalSpent || 0) + Number(amount || 0);

  if (!wallet.isUnlocked && Number(wallet.totalSpent) >= minSpend) {
    wallet.isUnlocked = true;
  }

  // wallet.save at end
  return { wallet, wasUnlocked, minSpend };
}

// ✅ Release sponsor locked join bonus when referred unlocks
async function tryReleasePendingJoinBonusesForReferred({ referredUserId, t, walletMap, minSpend }) {
  const checkUnlocked = async (uid) => {
    const w = await getWalletFromMap(uid, walletMap, t);
    return !!w?.isUnlocked && Number(w?.totalSpent || 0) >= minSpend;
  };

  const referredOk = await checkUnlocked(referredUserId);
  if (!referredOk) return { released: 0, reason: "REFERRED_NOT_UNLOCKED" };

  // ✅ Optimization: filter by referredUserId AND pending status at DB level
  const pendingJoinTxns = await WalletTransaction.findAll({
    where: {
      type: "CREDIT",
      reason: "REFERRAL_JOIN_BONUS",
      "meta.pending": true,
      "meta.referredUserId": referredUserId
    },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  let released = 0;

  for (const txn of pendingJoinTxns) {
    const meta = parseMeta(txn);
    // double check just in case, though DB filter should handle it
    if (meta.pending !== true) continue;
    if (Number(meta.referredUserId) !== Number(referredUserId)) continue;

    // sponsor wallet row
    const sponsorWalletRow = await Wallet.findByPk(txn.walletId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!sponsorWalletRow) continue;

    // use walletMap instance for sponsor
    const sponsorWallet = await getWalletFromMap(sponsorWalletRow.userId, walletMap, t);

    const sponsorOk = await checkUnlocked(sponsorWallet.userId);
    if (!sponsorOk) continue;

    const amt = Number(txn.amount || 0);

    sponsorWallet.lockedBalance = Math.max(0, Number(sponsorWallet.lockedBalance || 0) - amt);
    sponsorWallet.balance = Number(sponsorWallet.balance || 0) + amt;
    sponsorWallet.totalBalance =
      Number(sponsorWallet.balance || 0) + Number(sponsorWallet.lockedBalance || 0);

    txn.meta = {
      ...meta,
      pending: false,
      releasedAt: new Date().toISOString(),
      pendingReason: null,
    };
    await txn.save({ transaction: t });

    released += 1;
  }

  return { released };
}

// ✅ Release THIS sponsor wallet's own pending txns (walletId = sponsor wallet)
async function tryReleasePendingJoinBonusesForSponsor({ sponsorId, t, walletMap, minSpend }) {
  const checkUnlocked = async (uid) => {
    const w = await getWalletFromMap(uid, walletMap, t);
    return !!w?.isUnlocked && Number(w?.totalSpent || 0) >= minSpend;
  };

  const sponsorWallet = await getWalletFromMap(sponsorId, walletMap, t);
  if (!sponsorWallet) return { released: 0, reason: "NO_WALLET" };

  const sponsorOk = await checkUnlocked(sponsorId);
  if (!sponsorOk) return { released: 0, reason: "SPONSOR_NOT_UNLOCKED" };

  // ✅ Optimization: filter by pending status at DB level
  const pendingTxns = await WalletTransaction.findAll({
    where: {
      walletId: sponsorWallet.id,
      type: "CREDIT",
      reason: "REFERRAL_JOIN_BONUS",
      "meta.pending": true
    },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  let released = 0;

  for (const txn of pendingTxns) {
    const meta = parseMeta(txn);
    if (meta.pending !== true) continue;

    const referredUserId = Number(meta.referredUserId || 0);
    if (!referredUserId) continue;

    const referredOk = await checkUnlocked(referredUserId);
    if (!referredOk) continue;

    const amt = Number(txn.amount || 0);

    sponsorWallet.lockedBalance = Math.max(0, Number(sponsorWallet.lockedBalance || 0) - amt);
    sponsorWallet.balance = Number(sponsorWallet.balance || 0) + amt;
    sponsorWallet.totalBalance =
      Number(sponsorWallet.balance || 0) + Number(sponsorWallet.lockedBalance || 0);

    txn.meta = {
      ...meta,
      pending: false,
      releasedAt: new Date().toISOString(),
      pendingReason: null,
    };
    await txn.save({ transaction: t });

    released += 1;
  }

  return { released };
}

// ✅ Pair bonus release (pending)
async function tryReleasePendingPairBonuses(t, walletMap, minSpend) {
  const checkUnlocked = async (uid) => {
    const w = await getWalletFromMap(uid, walletMap, t);
    return !!w?.isUnlocked && Number(w?.totalSpent || 0) >= minSpend;
  };

  // ✅ Optimization: filter by pending status at DB level
  const pendingPairTxns = await WalletTransaction.findAll({
    where: {
      type: "CREDIT",
      reason: "PAIR_BONUS",
      "meta.pending": true
    },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  for (const txn of pendingPairTxns) {
    const meta = parseMeta(txn);
    if (meta.pending !== true) continue;

    const walletRow = await Wallet.findByPk(txn.walletId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!walletRow) continue;

    const wallet = await getWalletFromMap(walletRow.userId, walletMap, t);

    const receiverId = wallet.userId;

    const leftUserId = meta?.pairs?.[0]?.leftUserId || meta?.leftUserId;
    const rightUserId = meta?.pairs?.[0]?.rightUserId || meta?.rightUserId;
    if (!leftUserId || !rightUserId) continue;

    const [uOk, lOk, rOk] = await Promise.all([
      checkUnlocked(receiverId),
      checkUnlocked(leftUserId),
      checkUnlocked(rightUserId),
    ]);
    if (!uOk || !lOk || !rOk) continue;

    const amt = Number(txn.amount || 0);

    wallet.lockedBalance = Math.max(0, Number(wallet.lockedBalance || 0) - amt);
    wallet.balance = Number(wallet.balance || 0) + amt;
    wallet.totalBalance = Number(wallet.balance || 0) + Number(wallet.lockedBalance || 0);

    txn.meta = {
      ...meta,
      pending: false,
      releasedAt: new Date().toISOString(),
      pendingReason: null,
    };
    await txn.save({ transaction: t });
  }
}

/* ================= PLACE ORDER (from cart) =================
POST /api/orders
Body: { "paymentMethod": "COD" | "WALLET" | "RAZORPAY", "addressId": number }
*/
router.post("/", auth, async (req, res) => {
  try {
    const { paymentMethod, addressId } = req.body;

    if (!paymentMethod) return res.status(400).json({ msg: "paymentMethod required" });
    if (!addressId) return res.status(400).json({ msg: "addressId required" });

    const cart = await Cart.findOne({
      where: { userId: req.user.id },
      include: [{ model: CartItem, include: [Product] }],
    });

    if (!cart || !cart.CartItems || cart.CartItems.length === 0) {
      return res.status(400).json({ msg: "Cart is empty" });
    }

    const address = await Address.findOne({
      where: { id: addressId, userId: req.user.id, isActive: true },
    });
    if (!address) return res.status(400).json({ msg: "Invalid address" });

    let billAmount = 0;
    let totalDiscount = 0;

    const dbUser = await User.findByPk(req.user.id, { attributes: ["id", "userType"] });
    const userType = String(dbUser?.userType || "").toUpperCase();

    for (const item of cart.CartItems) {
      const p = item.Product;
      const qty = Number(item.qty || 0);
      const price = Number(p.price || 0);

      let discPercent = 0;
      if (userType === "ENTREPRENEUR") discPercent = Number(p.entrepreneurDiscount || 0);
      else if (userType === "TRAINEE_ENTREPRENEUR") discPercent = Number(p.traineeEntrepreneurDiscount || 0);

      const lineBase = qty * price;
      const lineDiscount = (lineBase * discPercent) / 100;

      billAmount += lineBase;
      totalDiscount += lineDiscount;
    }

    const slab = await DeliveryCharge.findOne({
      where: {
        isActive: true,
        minAmount: { [Op.lte]: billAmount },
        [Op.or]: [{ maxAmount: { [Op.gte]: billAmount } }, { maxAmount: null }],
      },
      order: [["minAmount", "DESC"]],
    });

    const deliveryCharge = slab ? Number(slab.charge) : 0;
    const grandTotal = Math.max(0, Number(billAmount) - Number(totalDiscount) + Number(deliveryCharge));

    let wallet = null;

    if (paymentMethod === "WALLET") {
      wallet = await Wallet.findOne({ where: { userId: req.user.id } });

      if (!wallet)
        wallet = await Wallet.create({
          userId: req.user.id,
          balance: 0,
          lockedBalance: 0,
          totalBalance: 0,
          totalSpent: 0,
          isUnlocked: false,
        });

      if (Number(wallet.balance) < Number(grandTotal)) {
        return res.status(400).json({ msg: "Insufficient wallet balance" });
      }
    }

    const order = await Order.create({
      userId: req.user.id,
      totalAmount: grandTotal,
      totalDiscount: Number(totalDiscount.toFixed(2)),
      addressId: address.id,
      deliveryCharge: deliveryCharge,
      paymentMethod,
      status: "PENDING",
      paymentStatus: "PENDING",
    });

    for (const item of cart.CartItems) {
      const p = item.Product;

      await OrderItem.create({
        orderId: order.id,
        productId: p.id,
        price: p.price,
        qty: item.qty,
      });

      await p.update({ stockQty: p.stockQty - item.qty });
    }

    if (paymentMethod === "WALLET") {
      wallet.balance = Number(wallet.balance || 0) - Number(grandTotal || 0);
      wallet.totalBalance = Number(wallet.balance || 0) + Number(wallet.lockedBalance || 0);
      await wallet.save();

      await WalletTransaction.create({
        walletId: wallet.id,
        type: "DEBIT",
        amount: grandTotal,
        reason: "ORDER_PAYMENT",
        orderId: order.id,
      });

      await order.update({ status: "PAID", paymentStatus: "SUCCESS" });
    }

    await CartItem.destroy({ where: { cartId: cart.id } });

    return res.status(201).json({
      msg: "Order placed",
      orderId: order.id,
      addressId: order.addressId,
      totalDiscount: Number(totalDiscount.toFixed(2)),
      billAmount,
      deliveryCharge,
      grandTotal,
      paymentMethod,
      walletBalance: paymentMethod === "WALLET" ? wallet.balance : undefined,
    });
  } catch (e) {
    console.error("ORDER ERROR =>", e);
    return res.status(500).json({ msg: "Order failed", err: e.message });
  }
});

/* ================= ADMIN: UPDATE ORDER STATUS =================
PATCH /api/orders/admin/:id/status
Body: { status: "PENDING"|"PAID"|"CANCELLED"|"DELIVERED" }
*/
router.patch("/admin/:id/status", auth, isAdmin, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const { status } = req.body;
    const allowed = ["PENDING", "PAID", "CANCELLED", "DELIVERED"];

    if (!status || !allowed.includes(String(status).toUpperCase())) {
      await t.rollback();
      return res.status(400).json({ msg: "Invalid status" });
    }

    const order = await Order.findByPk(req.params.id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!order) {
      await t.rollback();
      return res.status(404).json({ msg: "Order not found" });
    }

    const next = String(status).toUpperCase();
    const wasDelivered = order.status === "DELIVERED";

    if (next === "DELIVERED") {
      if (order.status === "CANCELLED") {
        await t.rollback();
        return res.status(400).json({ msg: "Cancelled order cannot be delivered" });
      }
      await order.update(
        { status: "DELIVERED", deliveredOn: new Date(), deliveredByAdminId: req.user.id },
        { transaction: t }
      );
    } else {
      await order.update(
        {
          status: next,
          deliveredOn: next === "DELIVERED" ? order.deliveredOn : null,
          deliveredByAdminId: next === "DELIVERED" ? order.deliveredByAdminId : null,
        },
        { transaction: t }
      );
    }

    let spendInfo = null;
    let sponsorPending = null;

    const walletMap = new Map();
    // ✅ Optimization: Cache settings once per request
    const minSpend = (await getSettingNumber("MIN_SPEND_UNLOCK", t)) || 30000;

    // ✅ ONLY on first time DELIVERED
    if (!wasDelivered && next === "DELIVERED") {
      // 1) add spend + unlock (wallet save at end)
      spendInfo = await addSpendAndUnlockIfNeeded({
        userId: order.userId,
        amount: order.totalAmount,
        t,
        walletMap,
        minSpend
      });

      // 2) if newly unlocked -> update userType
      if (!spendInfo.wasUnlocked && spendInfo.wallet.isUnlocked) {
        await User.update(
          { userType: "ENTREPRENEUR", activationDate: new Date() },
          { where: { id: order.userId }, transaction: t }
        );
        // ✅ NEW: Increment upline entrepreneur counts and unlock pairs
        await updateUplineEntrepreneurCounts({ newlyUpgradedUserId: order.userId, t });
      }

      // ✅ 3) ALWAYS try releasing bonuses (even if already unlocked earlier)
      const releasedJoinAsReferred = await tryReleasePendingJoinBonusesForReferred({
        referredUserId: order.userId,
        t,
        walletMap,
        minSpend
      });

      const releasedJoinAsSponsor = await tryReleasePendingJoinBonusesForSponsor({
        sponsorId: order.userId,
        t,
        walletMap,
        minSpend
      });

      await tryReleasePendingPairBonuses(t, walletMap, minSpend);

      sponsorPending = { releasedJoinAsReferred, releasedJoinAsSponsor };
    }

    // ✅ SAVE ALL modified wallets once
    for (const wallet of walletMap.values()) {
      await wallet.save({ transaction: t });
    }

    await t.commit();

    return res.json({
      msg: "Status updated",
      orderId: order.id,
      status: order.status,
      deliveredOn: order.deliveredOn,
      spendInfo: spendInfo
        ? { totalSpent: spendInfo.wallet.totalSpent, isUnlocked: spendInfo.wallet.isUnlocked, minSpend: spendInfo.minSpend }
        : null,
      sponsorPending,
    });
  } catch (e) {
    await t.rollback();
    console.error("PATCH /api/orders/admin/:id/status error:", e);
    return res.status(500).json({ msg: "Failed to update status", err: e.message });
  }
});

/* ================= ADMIN ORDERS =================
GET /api/orders/admin?search=...
*/
router.get("/admin", auth, isAdmin, async (req, res) => {
  try {
    const search = (req.query.search || "").trim();
    const type = (req.query.type || "").trim().toUpperCase(); // OFFLINE or ONLINE
    const where = {};

    if (type === "OFFLINE" || type === "ONLINE") {
      where.orderType = type;
    }

    // Handle search keywords if not explicitly filtered by type
    if (!type) {
      if (search.toLowerCase() === "offline") {
        where.orderType = "OFFLINE";
      } else if (search.toLowerCase() === "online") {
        where.orderType = "ONLINE";
      }
    }

    if (search && /^\d+$/.test(search)) where.id = Number(search);

    const orders = await Order.findAll({
      where,
      include: [
        { model: User, attributes: ["id", "name", "email", "phone", "role"], required: false },
        { model: Address, required: false },
        {
          model: OrderItem,
          include: [
            {
              model: Product,
              ...(search && !/^\d+$/.test(search)
                ? { where: { name: { [Op.like]: `%${search}%` } }, required: false }
                : {}),
            },
          ],
          required: false,
        },
        {
          model: User,
          as: "CreatedByAdmin",
          attributes: ["id", "name", "role"],
          required: false,
          foreignKey: "createdByAdminId",
        },
        {
          model: User,
          as: "DeliveredByAdmin",
          attributes: ["id", "name", "role"],
          required: false,
          foreignKey: "deliveredByAdminId",
        },
      ],
      order: [["createdAt", "DESC"]],
      distinct: true,
    });

    let filtered = orders;

    if (search && !/^\d+$/.test(search)) {
      const q = search.toLowerCase();
      filtered = orders.filter((o) => {
        const st = String(o.status || "").toLowerCase();
        const uname = String(o.User?.name || "").toLowerCase();
        const uemail = String(o.User?.email || "").toLowerCase();
        const uphone = String(o.User?.phone || "").toLowerCase();

        const products = (o.OrderItems || [])
          .map((it) => it?.Product?.name || "")
          .join(" ")
          .toLowerCase();

        return st.includes(q) || uname.includes(q) || uemail.includes(q) || uphone.includes(q) || products.includes(q);
      });
    }

    res.json({ total: filtered.length, orders: filtered });
  } catch (e) {
    console.error("GET /api/orders/admin error:", e);
    res.status(500).json({ msg: "Failed to get admin orders" });
  }
});

/* ================= GET MY ORDERS =================
GET /api/orders?search=
*/
router.get("/", auth, async (req, res) => {
  try {
    const search = (req.query.search || "").trim();

    const where = { userId: req.user.id };

    if (search) {
      if (/^\d+$/.test(search)) where.id = Number(search);
      else where.status = { [Op.like]: `%${search}%` };
    }

    const limit = Math.min(Number(req.query.limit) || 50, 100);

    const orders = await Order.findAll({
      where,
      include: [
        { model: Address },
        {
          model: OrderItem,
          include: [
            {
              model: Product,
              ...(search && !/^\d+$/.test(search)
                ? { where: { name: { [Op.like]: `%${search}%` } }, required: false }
                : {}),
            },
          ],
        },
      ],
      order: [["createdAt", "DESC"]],
      distinct: true,
      limit: limit,
    });

    res.json({ total: orders.length, orders });
  } catch (e) {
    console.error("GET /api/orders error:", e);
    res.status(500).json({ msg: "Failed to get orders" });
  }
});

/* ================= GET SINGLE ORDER =================
GET /api/orders/:id
*/
router.get("/:id", auth, async (req, res) => {
  try {
    const order = await Order.findOne({
      where: { id: req.params.id, userId: req.user.id },
      include: [{ model: OrderItem, include: [Product] }],
    });

    if (!order) return res.status(404).json({ msg: "Order not found" });
    res.json(order);
  } catch (e) {
    console.error(e);
    res.status(500).json({ msg: "Failed to get order" });
  }
});



/* ================= ADMIN: CREATE OFFLINE ORDER =================
POST /api/orders/admin/offline
Body:
{
  userId: number,
  items: [{ productId:number, qty:number }],
  paymentMethod: "OFFLINE" | "CASH" | "BANK" | "UPI",
  paymentRef: "optional",
  addressId: optional,
  markDelivered: boolean (optional)
}
*/
router.post("/admin/offline", auth, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const userId = Number(req.body.userId);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const paymentMethod = String(req.body.paymentMethod || "OFFLINE").toUpperCase();
    const paymentRef = String(req.body.paymentRef || "").trim();
    const addressId = req.body.addressId ? Number(req.body.addressId) : null;
    const markDelivered = !!req.body.markDelivered;

    if (!userId || userId <= 0) throw new Error("userId required");
    if (!items.length) throw new Error("items required");

    const allowedPay = ["OFFLINE", "CASH", "BANK", "UPI"];
    if (!allowedPay.includes(paymentMethod)) throw new Error("Invalid paymentMethod");

    const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!user) throw new Error("User not found");

    // address optional (admin may not want address)
    let address = null;
    if (addressId) {
      address = await Address.findOne({
        where: { id: addressId, userId: userId, isActive: true },
        transaction: t,
      });
      if (!address) throw new Error("Invalid addressId for this user");
    }

    // Load products (lock to avoid race)
    const productIds = items.map((x) => Number(x.productId)).filter(Boolean);
    const products = await Product.findAll({
      where: { id: productIds, isActive: true },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    const pMap = new Map(products.map((p) => [p.id, p]));
    if (products.length !== productIds.length) {
      throw new Error("One or more products not found / inactive");
    }

    // calculate totals with your discount logic (same as user order)
    let billAmount = 0;
    let totalDiscount = 0;

    const uType = String(user.userType || "").toUpperCase();

    for (const it of items) {
      const pid = Number(it.productId);
      const qty = Number(it.qty || 0);
      if (!pid || qty <= 0) throw new Error("Invalid items (productId/qty)");

      const p = pMap.get(pid);
      if (!p) throw new Error("Product not found");

      if (Number(p.stockQty || 0) < qty) {
        throw new Error(`Stock not enough for ${p.name}`);
      }

      const price = Number(p.price || 0);
      let discPercent = 0;

      if (uType === "ENTREPRENEUR") discPercent = Number(p.entrepreneurDiscount || 0);
      else if (uType === "TRAINEE_ENTREPRENEUR") discPercent = Number(p.traineeEntrepreneurDiscount || 0);

      const lineBase = qty * price;
      const lineDiscount = (lineBase * discPercent) / 100;

      billAmount += lineBase;
      totalDiscount += lineDiscount;
    }

    // delivery charge (optional: if address present then charge, else 0)
    let deliveryCharge = 0;
    if (address) {
      const slab = await DeliveryCharge.findOne({
        where: {
          isActive: true,
          minAmount: { [Op.lte]: billAmount },
          [Op.or]: [{ maxAmount: { [Op.gte]: billAmount } }, { maxAmount: null }],
        },
        order: [["minAmount", "DESC"]],
        transaction: t,
      });
      deliveryCharge = slab ? Number(slab.charge) : 0;
    }

    const grandTotal = Math.max(0, Number(billAmount) - Number(totalDiscount) + Number(deliveryCharge));

    // Create order
    const order = await Order.create(
      {
        userId: userId,
        totalAmount: grandTotal,
        totalDiscount: Number(totalDiscount.toFixed(2)),
        deliveryCharge: deliveryCharge,
        addressId: address ? address.id : null,

        paymentMethod: paymentMethod,
        paymentStatus: "SUCCESS",
        status: markDelivered ? "DELIVERED" : "PAID",
        deliveredOn: markDelivered ? new Date() : null,
        createdByAdminId: req.user.id,   // ✅ track which admin created this offline order
        orderType: "OFFLINE", // ✅ mark as offline order
      },
      { transaction: t }
    );

    // Create order items + reduce stock
    for (const it of items) {
      const p = pMap.get(Number(it.productId));
      const qty = Number(it.qty);

      await OrderItem.create(
        {
          orderId: order.id,
          productId: p.id,
          price: p.price,
          qty: qty,
        },
        { transaction: t }
      );

      await p.update({ stockQty: Number(p.stockQty) - qty }, { transaction: t });
    }

    // ✅ If admin marked delivered, apply spend+unlock+referral release logic same as your status route
    let spendInfo = null;
    let sponsorPending = null;
    const walletMap = new Map();
    const minSpend = (await getSettingNumber("MIN_SPEND_UNLOCK", t)) || 30000;

    if (markDelivered) {
      spendInfo = await addSpendAndUnlockIfNeeded({
        userId: order.userId,
        amount: order.totalAmount,
        t,
        walletMap,
        minSpend,
      });

      if (!spendInfo.wasUnlocked && spendInfo.wallet.isUnlocked) {
        await User.update(
          { userType: "ENTREPRENEUR", activationDate: new Date() },
          { where: { id: order.userId }, transaction: t }
        );
        // ✅ NEW: Increment upline entrepreneur counts and unlock pairs
        await updateUplineEntrepreneurCounts({ newlyUpgradedUserId: order.userId, t });

        const releasedJoinAsReferred = await tryReleasePendingJoinBonusesForReferred({
          referredUserId: order.userId,
          t,
          walletMap,
          minSpend,
        });

        const releasedJoinAsSponsor = await tryReleasePendingJoinBonusesForSponsor({
          sponsorId: order.userId,
          t,
          walletMap,
          minSpend,
        });

        await tryReleasePendingPairBonuses(t, walletMap, minSpend);

        sponsorPending = { releasedJoinAsReferred, releasedJoinAsSponsor };
      }

      // ✅ Save all modified wallets ONCE (prevents stale instance overwrites)
      for (const wallet of walletMap.values()) {
        await wallet.save({ transaction: t });
      }
    }

    await t.commit();

    return res.status(201).json({
      msg: "Offline order created",
      orderId: order.id,
      userId: order.userId,
      billAmount,
      totalDiscount: Number(totalDiscount.toFixed(2)),
      deliveryCharge,
      grandTotal,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      spendInfo: spendInfo
        ? { totalSpent: spendInfo.wallet.totalSpent, isUnlocked: spendInfo.wallet.isUnlocked, minSpend: spendInfo.minSpend }
        : null,
      sponsorPending,
    });
  } catch (e) {
    await t.rollback();
    console.error("ADMIN OFFLINE ORDER ERROR =>", e);
    return res.status(400).json({ msg: e.message });
  }
});
export default router;
